import importlib.util
import time
import unittest
import tempfile
import json
from scipy.io import wavfile
from pathlib import Path

import numpy as np

spec = importlib.util.spec_from_file_location("fast_analysis", Path(__file__).with_name("fast_analysis.py"))
fast = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fast)


def phrase(notes, seconds, amplitude):
    parts = []
    for i in range(int(seconds * 2)):
        frequency = 440 * 2 ** ((notes[i % len(notes)] - 69) / 12)
        t = np.arange(fast.RATE // 2) / fast.RATE
        wave = np.sin(2 * np.pi * frequency * t) + 0.35 * np.sin(4 * np.pi * frequency * t)
        parts.append((amplitude * wave * np.minimum(t * 30, 1) * np.minimum((0.5 - t) * 30, 1)).astype(np.float32))
    return np.concatenate(parts)


class FastTest(unittest.TestCase):
    def test_silence_and_stationary_tone_are_not_hooks(self):
        silence = np.zeros(fast.RATE * 60, dtype=np.float32)
        self.assertEqual(fast.repeated_sections(fast.features(silence), 60), [])
        tone = np.sin(2 * np.pi * 440 * np.arange(fast.RATE * 60) / fast.RATE).astype(np.float32)
        self.assertEqual(fast.repeated_sections(fast.features(tone), 60), [])

    def test_repeated_musical_sections_keep_intro_offset_and_multiple_rounds(self):
        rng = np.random.default_rng(47)
        hook = phrase([60, 64, 67, 71, 62, 65, 69, 72, 59, 63, 66, 70, 61, 68, 73, 66, 60, 65, 71, 74, 62, 67, 70, 76], 24, 0.8)
        intro = np.zeros(fast.RATE * 12, dtype=np.float32)
        verse = phrase(rng.integers(48, 72, 40), 20, 0.25)
        bridge = phrase(rng.integers(52, 76, 32), 16, 0.3)
        audio = np.concatenate([intro, verse, hook, verse[::-1], hook, bridge, hook, intro])
        duration = len(audio) / fast.RATE
        start = time.monotonic()
        segments = fast.repeated_sections(fast.features(audio), duration)
        elapsed = time.monotonic() - start
        print(f"synthetic {duration:.0f}s audio: fast features + detection {elapsed:.3f}s; {segments}")
        self.assertEqual(len(segments), 3)
        for segment, expected in zip(segments, [32, 76, 116]):
            self.assertLessEqual(abs(segment["start"] - expected), 3)
            self.assertLessEqual(abs(segment["end"] - (expected + 24)), 3)
        self.assertLess(elapsed, 15, 'Algorithm-only synthetic regression budget, not an end-to-end latency guarantee')

    def test_nonfinite_samples_are_rejected(self):
        audio = np.full(fast.RATE * 31, np.nan, dtype=np.float32)
        self.assertIsNone(fast.features(audio))

    def test_decode_and_detect_a_local_wav_without_loading_any_model(self):
        rng = np.random.default_rng(23)
        notes = rng.integers(52, 80, 48)
        hook = phrase(notes, 24, 0.7)
        verse = phrase(rng.integers(40, 62, 40), 20, 0.2)
        audio = np.concatenate([np.zeros(fast.RATE * 8), verse, hook, verse[::-1], hook]).astype(np.float32)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "test.wav"
            wavfile.write(path, fast.RATE, audio)
            started = time.monotonic()
            result = fast.analyze_file(path, Path(folder))
            print(f"synthetic WAV decode + fast detection: {time.monotonic() - started:.3f}s")
            self.assertEqual(result["engine"], "fast")
            self.assertEqual(len(result["segments"]), 2)
            self.assertEqual((Path(folder) / "stage").read_text(), "analyzing")

    def test_subsecond_repeat_alignment_does_not_lose_the_start_of_the_hook(self):
        rng = np.random.default_rng(103)
        hook = phrase(rng.integers(55, 80, 48), 24, .7)
        verse1 = phrase(rng.integers(40, 70, 40), 20, .2)
        verse2 = phrase(rng.integers(40, 70, 40), 20, .2)
        for delay in (.125, .25, .375):
            audio = np.concatenate([np.zeros(fast.RATE * 8), verse1, hook, verse2,
                                    np.zeros(int(fast.RATE * delay)), hook]).astype(np.float32)
            segments = fast.repeated_sections(fast.features(audio), len(audio) / fast.RATE)
            self.assertEqual(len(segments), 2)
            for segment, start in zip(segments, (28, 72 + delay)):
                self.assertLessEqual(abs(segment["start"] - start), 2)
                self.assertLessEqual(abs(segment["end"] - (start + 24)), 2)

    def test_unrelated_melodies_do_not_become_repeats_after_jitter_tolerance(self):
        rng = np.random.default_rng(317)
        audio = phrase(rng.integers(48, 80, 240), 120, .5)
        diagnostics = {}
        segments = fast.repeated_sections(fast.features(audio), 120, diagnostics)
        self.assertEqual(segments, [])
        self.assertEqual(diagnostics["reason"], "no-eligible-repeat")

    def test_user_uploaded_real_music_reference_boundaries(self):
        fixtures = Path(__file__).resolve().parents[2] / "tests" / "fixtures"
        references = json.loads((fixtures / "fast-chorus-reference-cases.json").read_text())
        for case in references["cases"]:
            with self.subTest(video=case["videoId"]):
                with np.load(fixtures / case["featureFixture"], allow_pickle=False) as data:
                    self.assertEqual(float(data["step"]), fast.STEP)
                    segments = fast.repeated_sections((data["c"], data["t"], data["energy"], data["active"]), float(data["duration"]))
                expected = case["expectedOccurrence"]
                nearest = min(segments, key=lambda s: abs(s["start"] - expected["start"]))
                self.assertLessEqual(abs(nearest["start"] - expected["start"]), 1)
                self.assertLessEqual(abs(nearest["end"] - expected["end"]), 1)

    def test_uploaded_seventeen_audio_reaches_the_user_confirmed_chorus(self):
        fixtures = Path(__file__).resolve().parents[2] / "tests" / "fixtures"
        ref = json.loads((fixtures / "comment-reaction-reference.json").read_text())
        with np.load(fixtures / ref["featureFixture"], allow_pickle=False) as data:
            segments = fast.repeated_sections(tuple(data[k] for k in ["c", "t", "energy", "active"]), float(data["duration"]))
        first = min(segments, key=lambda s: abs(s["start"] - ref["expectedOccurrence"]["start"]))
        self.assertLessEqual(abs(first["start"] - ref["expectedOccurrence"]["start"]), 1)
        self.assertLessEqual(abs(first["end"] - ref["expectedOccurrence"]["end"]), 1)
        self.assertNotIn(ref["observedWrongRange"], [{"start": s["start"], "end": s["end"]} for s in segments])

    def test_short_silent_pickup_can_precede_a_nearby_harmonic_peak(self):
        energy = np.full(100, .01, dtype=np.float32)
        energy[32:35] = .0005
        novelty = np.zeros(100, dtype=np.float32)
        novelty[39] = 1
        span = [(40, 80)]
        self.assertEqual(fast.refine_boundaries(span, novelty, energy)[0][0], 34)
        # Without an actual quiet gap, keep the musical-change cue; never
        # subtract a fixed amount of time just because a match starts late.
        energy[:] = .01
        self.assertEqual(fast.refine_boundaries(span, novelty, energy)[0][0], 39)


if __name__ == "__main__":
    unittest.main()
