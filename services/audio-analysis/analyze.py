"""One isolated job. Playback remains in the YouTube iframe."""
import json
import subprocess
import sys
import signal
import shutil
from pathlib import Path


def analyze(video_id, root):
    (root / "stage").write_text("downloading")
    subprocess.run([
        sys.executable, "-m", "yt_dlp", "--no-playlist", "--no-progress",
        "--no-warnings", "--ignore-config",
        *(["--js-runtimes", "node"] if shutil.which("node") else []), "--socket-timeout", "10",
        "--retries", "0", "--extractor-retries", "0", "--fragment-retries", "0", "--max-filesize", "100M",
        "--match-filter", "duration > 0 & duration <= 900 & !is_live",
        "-f", "bestaudio/best", "--extract-audio", "--audio-format", "wav",
        "-o", str(root / "audio.%(ext)s"),
        f"https://www.youtube.com/watch?v={video_id}",
    ], check=True, stdout=sys.stderr, timeout=45)
    audio = root / "audio.wav"
    if not audio.is_file():
        raise RuntimeError("No audio: unsupported duration, live video, or download rejected")
    (root / "stage").write_text("analyzing")
    import torch
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    import allin1
    # Disable per-clip multiprocessing: WSL otherwise competes with Torch and
    # Demucs thread pools, which can make a small CPU workload much slower.
    result = allin1.analyze(str(audio), device="cpu", model="harmonix-fold0", multiprocess=False,
                            demix_dir=str(root / "demix"), spec_dir=str(root / "spec"))
    return {"segments": [dict(start=s.start, end=s.end, label=s.label) for s in result.segments]}


if __name__ == "__main__":
    import re
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(1))
    if len(sys.argv) != 3 or not re.fullmatch(r"[\w-]{11}", sys.argv[1], flags=re.ASCII):
        raise SystemExit("Invalid video ID")
    print(json.dumps(analyze(sys.argv[1], Path(sys.argv[2]))))
