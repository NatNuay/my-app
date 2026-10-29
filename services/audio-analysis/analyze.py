"""One isolated job. Playback remains in the YouTube iframe."""
import json
import subprocess
import sys
import signal
import shutil
import tempfile
from pathlib import Path


def analyze(video_id):
    with tempfile.TemporaryDirectory(prefix="muverse-audio-") as folder:
        root = Path(folder)
        # Only fixed YouTube URLs built from a validated ID, never arbitrary URLs.
        subprocess.run([
            sys.executable, "-m", "yt_dlp", "--no-playlist", "--no-progress",
            "--no-warnings", "--ignore-config",
            *(["--js-runtimes", "node"] if shutil.which("node") else []), "--socket-timeout", "20",
            "--retries", "1", "--fragment-retries", "1", "--max-filesize", "100M",
            "--match-filter", "duration > 0 & duration <= 900 & !is_live",
            "-f", "bestaudio/best", "--extract-audio", "--audio-format", "wav",
            "-o", str(root / "audio.%(ext)s"),
            f"https://www.youtube.com/watch?v={video_id}",
        ], check=True, stdout=sys.stderr)
        audio = root / "audio.wav"
        if not audio.is_file():
            raise RuntimeError("No audio: unsupported duration, live video, or download rejected")
        import allin1
        result = allin1.analyze(str(audio), device="cpu", model="harmonix-fold0",
                                demix_dir=str(root / "demix"), spec_dir=str(root / "spec"))
        return {"segments": [dict(start=s.start, end=s.end, label=s.label) for s in result.segments]}


if __name__ == "__main__":
    import re
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(1))
    if len(sys.argv) != 2 or not re.fullmatch(r"[\w-]{11}", sys.argv[1], flags=re.ASCII):
        raise SystemExit("Invalid video ID")
    print(json.dumps(analyze(sys.argv[1])))
