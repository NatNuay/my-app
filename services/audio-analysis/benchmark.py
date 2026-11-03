"""Measure the complete model path on an existing local audio file. No YouTube request."""
import argparse
import json
import os
import tempfile
import time
from pathlib import Path
from analyze import analyze_file


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio", type=Path)
    parser.add_argument("--engine", choices=["fast", "full"], default="fast")
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    parser.add_argument("--threads", type=int, default=6)
    args = parser.parse_args()
    if not args.audio.is_file() or args.threads < 1:
        parser.error("Provide an existing audio file and a positive thread count")
    for name in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "AUDIO_ANALYSIS_THREADS"):
        os.environ[name] = str(args.threads)
    os.environ["AUDIO_ANALYSIS_DEVICE"] = args.device
    with tempfile.TemporaryDirectory(prefix="muverse-benchmark-") as folder:
        root = Path(folder)
        start = time.monotonic()
        if args.engine == "fast":
            from fast_analysis import analyze_file as fast_analyze
            result = fast_analyze(args.audio.resolve(), root)
        else:
            result = analyze_file(args.audio.resolve(), root)
        seconds = round(time.monotonic() - start, 2)
        timings = json.loads((root / "timings.json").read_text()) if (root / "timings.json").exists() else {}
        print(json.dumps({"engine": args.engine, "device": args.device, "threads": args.threads,
                          "analysisSeconds": seconds, "phaseSeconds": timings,
                          "within30SecondsExcludingDownload": seconds <= 30,
                          "segments": result["segments"]}, ensure_ascii=False))
        # This benchmark EXCLUDES download and API/UI latency: meeting this
        # budget alone does not prove the end-to-end product requirement.


if __name__ == "__main__":
    main()
