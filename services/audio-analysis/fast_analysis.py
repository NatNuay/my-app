"""Experimental repeated-music detector. No Demucs, Torch, model weights or JIT.

Repetition is evidence for a chorus candidate, not a semantic chorus label.
"""
import subprocess
from pathlib import Path

import numpy as np
from scipy.ndimage import binary_closing, uniform_filter1d, maximum_filter1d
from scipy.signal import find_peaks, stft

STEP = 0.25
RATE = 8000


def decode(path):
    result = subprocess.run([
        "ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-t", "900",
        "-ac", "1", "-ar", str(RATE), "-f", "f32le", "pipe:1",
    ], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=8)
    return np.frombuffer(result.stdout, dtype="<f4")


def features(samples, rate=RATE):
    if len(samples) < rate * 30 or not np.isfinite(samples).all():
        return None
    _, times, spectrum = stft(samples, fs=rate, nperseg=2048, noverlap=1536,
                              boundary=None, padded=False)
    magnitude = np.abs(spectrum).astype(np.float32)
    frequencies = np.fft.rfftfreq(2048, 1 / rate)
    selected = (frequencies >= 80) & (frequencies <= 3500)
    raw = magnitude[selected]
    profile = raw / np.maximum(raw.sum(axis=0, keepdims=True), 1e-8)
    if float(np.mean(np.abs(profile - profile.mean(axis=1, keepdims=True)).sum(axis=0))) < 0.03:
        return None
    # Compress dynamic range; per-bin whitening prevents a loud bass or kick
    # from making every part of the song look identical.
    power = np.sqrt(magnitude[selected])
    power /= np.maximum(power.mean(axis=1, keepdims=True), 1e-5)
    power = np.minimum(power, 5)
    midi = np.rint(69 + 12 * np.log2(frequencies[selected] / 440)).astype(int)
    chroma = np.stack([power[midi % 12 == k].mean(axis=0) for k in range(12)])
    bands = np.array_split(magnitude[selected], 12, axis=0)
    timbre = np.stack([np.log1p(b.mean(axis=0) * 1000) for b in bands])
    energy = np.sqrt(np.mean(np.abs(spectrum) ** 2, axis=0))
    bins = np.floor(times / STEP).astype(int)
    count = int(bins[-1]) + 1
    def pool(data):
        output = np.zeros((data.shape[0], count), dtype=np.float32)
        for k in range(count):
            mask = bins == k
            if mask.any():
                output[:, k] = data[:, mask].mean(axis=1)
        return output
    c = pool(chroma).T
    t = pool(timbre).T
    e = pool(energy[None, :])[0]
    c -= c.mean(axis=0, keepdims=True)
    t -= t.mean(axis=0, keepdims=True)
    c /= np.maximum(np.linalg.norm(c, axis=1, keepdims=True), 1e-6)
    t /= np.maximum(np.linalg.norm(t, axis=1, keepdims=True), 1e-6)
    active = e > max(float(e.max()) * 0.05, 1e-8)
    # Silence and a stationary drone must not be presented as repeated hooks.
    if active.sum() * STEP < 15 or np.mean(np.std(chroma, axis=1)) < 0.015:
        return None
    return c, t, e, active


def refine_boundaries(spans, novelty, energy):
    """Expand a match to nearby audible transitions, never by a fixed offset."""
    peaks, _ = find_peaks(novelty, distance=max(1, round(1 / STEP)), prominence=0.08)
    strong = peaks[novelty[peaks] >= 0.4]
    refined = []
    radius = round(3 / STEP)
    for left, right in sorted(spans):
        before = strong[(strong <= left) & (strong >= left - radius)]
        after = strong[(strong >= right) & (strong <= right + radius)]
        start = int(before[-1]) if len(before) else left
        end = int(after[0]) if len(after) else right
        # A brief low-energy pickup before a drop is a stronger onset cue than
        # the center of the broad novelty peak. Keep an adjacent novelty cue
        # when it is already within 1.5 seconds of the matched start.
        if left - start > round(1.5 / STEP) or not len(before):
            lo = max(0, left - round(2.5 / STEP))
            if left > lo:
                valley = lo + int(np.argmin(energy[lo:left + 1]))
                typical = float(np.median(energy[left:min(len(energy), left + round(2 / STEP))]))
                recovery = energy[valley:min(len(energy), valley + round(1 / STEP) + 1)]
                if typical > 1e-8 and energy[valley] < typical * 0.25 and recovery.max(initial=0) > typical * 0.5:
                    start = valley
                else:
                    # A rise from a quieter section can mark the onset without
                    # a silent gap. Do not expand into that preceding section
                    # just because it has a strong harmonic change nearby.
                    before_level = float(np.median(energy[max(0, left - round(3 / STEP)):max(1, left - round(1 / STEP))]))
                    if before_level > 1e-8 and typical > before_level * 1.6:
                        envelope = uniform_filter1d(energy, size=max(1, round(0.5 / STEP)), mode="nearest")
                        middle = (before_level + typical) / 2
                        crossings = np.flatnonzero((envelope[lo:left] < middle) & (envelope[lo + 1:left + 1] >= middle))
                        if len(crossings):
                            start = max(start, lo + int(crossings[-1]) + 1)
        # Do not turn a small matching span into a very long section or overlap
        # the previous occurrence while expanding.
        if (end - start) * STEP > 60 or (refined and start < refined[-1][1]):
            start, end = left, right
        refined.append((int(start), int(end)))
    return refined


def repeated_sections(data, duration, diagnostics=None):
    if diagnostics is None:
        diagnostics = {}
    if data is None:
        diagnostics["reason"] = "insufficient-or-stationary-audio"
        return []
    c, t, energy, active = data
    n = len(c)
    similarity = np.clip(0.8 * (c @ c.T) + 0.2 * (t @ t.T), -1, 1)
    similarity[~active, :] = -1
    similarity[:, ~active] = -1
    # Allow at most one quarter-second of alignment jitter. The recurrence
    # still needs a sustained musical match; do not lower the score threshold.
    similarity = maximum_filter1d(similarity, size=3, axis=1, mode="constant", cval=-1)
    # Shared structural changes split a recurring pre-chorus + chorus block.
    smoothed = uniform_filter1d(c, size=round(3 / STEP), axis=0, mode="nearest")
    novelty = np.linalg.norm(np.roll(smoothed, -round(2 / STEP), axis=0) - np.roll(smoothed, round(2 / STEP), axis=0), axis=1)
    edge = round(4 / STEP)
    novelty[:edge] = novelty[-edge:] = 0
    changes, _ = find_peaks(novelty, distance=round(6 / STEP), prominence=0.12)
    pairs = []
    for lag in range(max(round(14 / STEP), n // 10), n - round(12 / STEP)):
        diagonal = np.diagonal(similarity, offset=lag)
        smooth = uniform_filter1d(diagonal, size=round(2.5 / STEP) | 1, mode="nearest")
        mask = binary_closing(smooth > 0.78, structure=np.ones(round(1 / STEP) + 1))
        edges = np.diff(np.r_[False, mask, False].astype(np.int8))
        for start, end in zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)):
            if (end - start) * STEP < 12:
                continue
            shared = [int(k) for k in changes if start + round(12 / STEP) <= k <= end - round(12 / STEP) and
                      np.any(np.abs(changes - (k + lag)) * STEP <= 1)]
            cuts = [start] + sorted(shared) + [end]
            intervals = [(start, end)] + list(zip(cuts, cuts[1:]))
            for left, right in intervals:
                length = (right - left) * STEP
                if not 12 <= length <= 60:
                    continue
                mean = float(diagonal[left:right].mean())
                if mean < 0.78:
                    continue
                loudness = float(np.mean(energy[left:right]))
                rank = float(np.mean(energy <= loudness))
                # A very quiet repeated passage is weak evidence of a hook.
                if rank < 0.25:
                    continue
                score = 0.65 * mean + 0.25 * rank + 0.10 * min(length / 28, 1)
                pairs.append((score, (left, right), (left + lag, right + lag)))
    diagnostics["candidatePairs"] = len(pairs)
    pairs.sort(reverse=True)
    groups = []
    def same(a, b):
        return abs(a[0] - b[0]) * STEP <= 3 and abs(a[1] - b[1]) * STEP <= 3
    for score, first, second in pairs[:300]:
        group = next((g for g in groups if any(same(a, b) for a in (first, second) for b in g["spans"])), None)
        if group is None:
            group = {"score": score, "spans": []}
            groups.append(group)
        for span in (first, second):
            if not any(same(span, old) or max(span[0], old[0]) < min(span[1], old[1]) for old in group["spans"]):
                group["spans"].append(span)
    candidates = [g for g in groups if 2 <= len(g["spans"]) <= 6 and
                  sum(b - a for a, b in g["spans"]) * STEP < duration * 0.65]
    diagnostics["eligibleFamilies"] = len(candidates)
    if not candidates:
        diagnostics["reason"] = "no-eligible-repeat"
        return []
    best = max(candidates, key=lambda g: g["score"] + 0.04 * min(len(g["spans"]) - 2, 2))
    diagnostics["reason"] = "repeat-found"
    return [{"start": round(float(a * STEP), 2), "end": round(float(min(b * STEP, duration)), 2),
             "label": "chorus"} for a, b in refine_boundaries(best["spans"], novelty, energy)]


def analyze_file(path, root=None):
    samples = decode(Path(path))
    if root is not None:
        (root / "stage").write_text("features")
    data = features(samples)
    if root is not None:
        (root / "stage").write_text("analyzing")
    diagnostics = {}
    segments = repeated_sections(data, len(samples) / RATE, diagnostics)
    return {"engine": "fast", "segments": segments, "diagnostics": diagnostics}
