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
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

TOKEN = os.environ.get("AUDIO_ANALYSIS_TOKEN", "")
JOBS = {}
LOCK = threading.Lock()
POOL = ThreadPoolExecutor(max_workers=1)
RUNNER = Path(__file__).with_name("analyze.py")


def run_job(video_id):
    with LOCK:
        JOBS[video_id] = {"status": "processing", "updated": time.time()}
    try:
        # A subprocess gives every download/model run a hard deadline and cleans
        # up descendants on timeout. Temporary audio is removed on normal exit.
        process = subprocess.Popen([sys.executable, str(RUNNER), video_id],
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   start_new_session=(os.name != "nt"))
        try:
            output, _ = process.communicate(timeout=600)
        except subprocess.TimeoutExpired:
            if os.name != "nt":
                os.killpg(process.pid, signal.SIGTERM)
            else:
                process.kill()
            try:
                process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                if os.name != "nt":
                    os.killpg(process.pid, signal.SIGKILL)
                else:
                    process.kill()
                process.communicate()
            raise RuntimeError("timeout")
        if process.returncode:
            raise RuntimeError("download-or-model-unavailable")
        # Libraries may print progress; the runner emits JSON on its final line.
        result = json.loads(output.decode().strip().splitlines()[-1])
        job = {"status": "ready", "segments": result["segments"]}
    except Exception:
        job = {"status": "failed", "reason": "audio-analysis-unavailable"}
    with LOCK:
        JOBS[video_id] = {**job, "updated": time.time()}


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
                ttl = 300 if job["status"] == "failed" else 86400
                if job["status"] in ("ready", "failed") and now - job["updated"] > ttl:
                    del JOBS[key]
            if video_id not in JOBS:
                if sum(j["status"] in ("queued", "processing") for j in JOBS.values()) >= 8:
                    return self.respond(429, {"status": "busy"})
                if len(JOBS) >= 128:
                    completed = [k for k, j in JOBS.items() if j["status"] in ("ready", "failed")]
                    if completed:
                        del JOBS[min(completed, key=lambda k: JOBS[k]["updated"])]
                JOBS[video_id] = {"status": "queued", "updated": now}
                POOL.submit(run_job, video_id)
            result = dict(JOBS[video_id])
        self.respond(200, result)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("AUDIO_ANALYSIS_PORT", "8765"))), Handler).serve_forever()
