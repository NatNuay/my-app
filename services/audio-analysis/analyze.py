"""One isolated job. Playback remains in the YouTube iframe."""
import json
import subprocess
import sys
import signal
import shutil
import os
import time
import importlib
import traceback
from pathlib import Path


def analyze(video_id, root):
    (root / "stage").write_text("downloading")
    fast_mode = os.environ.get("AUDIO_ANALYSIS_ENGINE", "fast") == "fast"
    subprocess.run([
        sys.executable, "-m", "yt_dlp", "--no-playlist", "--no-progress",
        "--no-warnings", "--ignore-config",
        *(["--js-runtimes", "node"] if shutil.which("node") else []), "--socket-timeout", "10",
        "--retries", "0", "--extractor-retries", "0", "--fragment-retries", "0", "--max-filesize", "100M",
        "--match-filter", "duration > 0 & duration <= 900 & !is_live",
        "-f", "bestaudio/best",
        *([] if fast_mode else ["--extract-audio", "--audio-format", "wav"]),
        "-o", str(root / "audio.%(ext)s"),
        f"https://www.youtube.com/watch?v={video_id}",
    ], check=True, stdout=sys.stderr, timeout=20 if fast_mode else 45)
    files = [p for p in root.glob("audio.*") if p.suffix not in (".part", ".ytdl")]
    audio = files[0] if fast_mode and files else root / "audio.wav"
    if not audio.is_file():
        raise RuntimeError("No audio: unsupported duration, live video, or download rejected")
    if fast_mode:
        from fast_analysis import analyze_file as fast_analyze
        return fast_analyze(audio, root)
    return analyze_file(audio, root)


def analyze_file(audio, root):
    """Same model path for downloaded audio and offline performance checks."""
    (root / "stage").write_text("loading-model")
    import torch
    torch.set_num_threads(max(1, int(os.environ.get("AUDIO_ANALYSIS_THREADS", "6"))))
    torch.set_num_interop_threads(1)
    device = os.environ.get("AUDIO_ANALYSIS_DEVICE", "cpu")
    if device not in ("cpu", "cuda"):
        raise ValueError("AUDIO_ANALYSIS_DEVICE must be cpu or cuda")
    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA requested but unavailable in this Python environment")
    import allin1
    # Instrument the pinned library without modifying its installation. The
    # public analyze() combines Demucs, features, weights and inference, so its
    # final progress bar alone does NOT measure the full analysis time.
    pipeline = importlib.import_module("allin1.analyze")
    originals = {}
    timings = {}
    def measured(function, stage):
        def call(*args, **kwargs):
            (root / "stage").write_text(stage)
            started = time.monotonic()
            try:
                return function(*args, **kwargs)
            finally:
                timings[stage] = round(time.monotonic() - started, 2)
                (root / "timings.json").write_text(json.dumps(timings))
        return call
    for name, stage in {"demix": "separating", "extract_spectrograms": "features",
                        "load_pretrained_model": "loading-model", "run_inference": "analyzing"}.items():
        originals[name] = getattr(pipeline, name)
        setattr(pipeline, name, measured(originals[name], stage))
    try:
        result = allin1.analyze(str(audio), device=device, model="harmonix-fold0", multiprocess=False,
                                demix_dir=str(root / "demix"), spec_dir=str(root / "spec"))
    finally:
        for name, original in originals.items():
            setattr(pipeline, name, original)
    return {"engine": "full", "segments": [dict(start=s.start, end=s.end, label=s.label) for s in result.segments]}


def failure_reason(error, stage):
    if isinstance(error, (ImportError, ModuleNotFoundError)):
        return "dependency-missing"
    if isinstance(error, FileNotFoundError):
        return "tool-missing"
    if isinstance(error, subprocess.TimeoutExpired):
        return "download-timeout" if stage == "downloading" else "decode-timeout"
    if isinstance(error, subprocess.CalledProcessError):
        return "download-failed" if stage == "downloading" else "decode-failed"
    if str(error).startswith("No audio:"):
        return "download-rejected"
    return "analysis-failed"


if __name__ == "__main__":
    import re
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(1))
    if len(sys.argv) != 3 or not re.fullmatch(r"[\w-]{11}", sys.argv[1], flags=re.ASCII):
        raise SystemExit("Invalid video ID")
    root = Path(sys.argv[2])
    try:
        print(json.dumps(analyze(sys.argv[1], root)))
    except Exception as error:
        try:
            stage = (root / "stage").read_text().strip()
        except OSError:
            stage = "unknown"
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": failure_reason(error, stage), "stage": stage}))
        raise SystemExit(1)
