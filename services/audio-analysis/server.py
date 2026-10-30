"""Bounded background job service; bind to loopback, never expose publicly."""
import hmac
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import tempfile
import math
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

TOKEN = os.environ.get("AUDIO_ANALYSIS_TOKEN", "")
JOBS = {}
LOCK = threading.Lock()
POOL = ThreadPoolExecutor(max_workers=1)
RUNNER = Path(__file__).with_name("analyze.py")
CACHE_DIR = Path(os.environ.get("AUDIO_ANALYSIS_CACHE", str(Path.home() / ".cache" / "muverse-audio")))
CACHE_TTL = 30 * 86400
LEASE_SECONDS = 30
JOB_TIMEOUT = 180


def valid_segments(value):
    if not isinstance(value, list) or len(value) > 200:
        return False
    return all(isinstance(s, dict) and isinstance(s.get("label"), str) and
               isinstance(s.get("start"), (int, float)) and isinstance(s.get("end"), (int, float)) and
               math.isfinite(s["start"]) and math.isfinite(s["end"]) and
               0 <= s["start"] < s["end"] <= 900 for s in value)


def read_cache(video_id):
    try:
        path = CACHE_DIR / f"fold0-v1-{video_id}.json"
        if path.stat().st_size > 100000:
            return None
        data = json.loads(path.read_text())
        if time.time() - data["updated"] > CACHE_TTL or not valid_segments(data["segments"]):
            return None
        return {"status": "ready", "segments": data["segments"], "updated": data["updated"], "cached": True}
    except (OSError, ValueError, TypeError, KeyError):
        return None


def save_cache(video_id, job):
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        path = CACHE_DIR / f"fold0-v1-{video_id}.json"
        temp = path.with_suffix(".tmp")
        temp.write_text(json.dumps({"updated": time.time(), "segments": job["segments"]}))
        temp.replace(path)
        files = sorted(CACHE_DIR.glob("fold0-v1-*.json"), key=lambda p: p.stat().st_mtime)
        for old in files[:-500]:
            old.unlink(missing_ok=True)
    except OSError:
        pass  # A read-only/full cache must never lose a successful analysis.


def abandoned(video_id):
    with LOCK:
        return time.time() - JOBS.get(video_id, {}).get("lastRequested", time.time()) > LEASE_SECONDS


def stop_process(process):
    if os.name != "nt":
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
    elif process.poll() is None:
        process.kill()
    else:
        return
    try:
        process.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        if os.name != "nt":
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
        process.communicate()



def run_job(video_id):
    if abandoned(video_id):
        with LOCK:
            JOBS[video_id] = {"status": "failed", "reason": "cancelled", "updated": time.time()}
        return
    with LOCK:
        JOBS.setdefault(video_id, {})
        JOBS[video_id].update(status="processing", stage="downloading", updated=time.time())
    process = None
    began = time.monotonic()
    tempdir = tempfile.TemporaryDirectory(prefix="muverse-audio-")
    try:
        # Parent owns temporary audio, so even a hard-killed child leaves no files.
        root = Path(tempdir.name)
        env = os.environ.copy()
        for name in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
            env[name] = "2"
        process = subprocess.Popen([sys.executable, str(RUNNER), video_id, str(root)],
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env,
                                   start_new_session=(os.name != "nt"))
        started = time.monotonic()
        while True:
            try:
                output, _ = process.communicate(timeout=1)
                break
            except subprocess.TimeoutExpired:
                if abandoned(video_id):
                    raise RuntimeError("cancelled")
                if time.monotonic() - started > JOB_TIMEOUT:
                    raise RuntimeError("timeout")
                try:
                    stage = (root / "stage").read_text().strip()
                    if stage in ("downloading", "analyzing"):
                        with LOCK:
                            JOBS[video_id]["stage"] = stage
                except OSError:
                    pass
        if process.returncode:
            raise RuntimeError("audio-analysis-unavailable")
        result = json.loads(output.decode().strip().splitlines()[-1])
        if not valid_segments(result["segments"]):
            raise RuntimeError("invalid-result")
        job = {"status": "ready", "segments": result["segments"]}
        save_cache(video_id, job)
    except Exception as error:
        if process is not None:
            stop_process(process)
        reason = str(error) if str(error) in ("cancelled", "timeout") else "audio-analysis-unavailable"
        job = {"status": "failed", "reason": reason}
    finally:
        tempdir.cleanup()
    with LOCK:
        JOBS[video_id] = {**job, "updated": time.time()}
    print(f"[audio] {video_id}: {job['status']} ({time.monotonic() - began:.1f}s) {job.get('reason', '')}", flush=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def respond(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if TOKEN and not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + TOKEN):
            return self.respond(401, {"error": "unauthorized"})
        if self.path == "/health":
            return self.respond(200, {"status": "ok"})
        return self.respond(404, {"error": "not-found"})

    def do_POST(self):
        if TOKEN and not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + TOKEN):
            return self.respond(401, {"error": "unauthorized"})
        match = re.fullmatch(r"/jobs/([A-Za-z0-9_-]{11})", urlparse(self.path).path)
        if not match:
            return self.respond(400, {"error": "invalid-video-id"})
        video_id = match[1]
        with LOCK:
            now = time.time()
            for key, job in list(JOBS.items()):
                ttl = (0 if job.get("reason") == "cancelled" else 300) if job["status"] == "failed" else 86400
                if job["status"] in ("ready", "failed") and now - job["updated"] > ttl:
                    del JOBS[key]
            if video_id not in JOBS:
                cached = read_cache(video_id)
                if cached is not None:
                    if len(JOBS) >= 128:
                        completed = [k for k, j in JOBS.items() if j["status"] in ("ready", "failed")]
                        if completed:
                            del JOBS[min(completed, key=lambda k: JOBS[k]["updated"])]
                    JOBS[video_id] = cached
            if video_id not in JOBS:
                if sum(j["status"] in ("queued", "processing") for j in JOBS.values()) >= 8:
                    return self.respond(429, {"status": "busy"})
                if len(JOBS) >= 128:
                    completed = [k for k, j in JOBS.items() if j["status"] in ("ready", "failed")]
                    if completed:
                        del JOBS[min(completed, key=lambda k: JOBS[k]["updated"])]
                JOBS[video_id] = {"status": "queued", "updated": now, "lastRequested": now}
                POOL.submit(run_job, video_id)
            JOBS[video_id]["lastRequested"] = now
            result = {k: v for k, v in JOBS[video_id].items() if k != "lastRequested"}
        self.respond(200, result)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("AUDIO_ANALYSIS_PORT", "8765"))), Handler).serve_forever()
