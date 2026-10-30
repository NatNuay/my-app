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
FAST_PROFILE = "fast-repeat-v2"
ENGINE = os.environ.get("AUDIO_ANALYSIS_ENGINE", "fast")
if ENGINE not in ("fast", "full"):
    raise ValueError("AUDIO_ANALYSIS_ENGINE must be fast or full")
LEASE_SECONDS = 8 if ENGINE == "fast" else 30
JOB_TIMEOUT = 27 if ENGINE == "fast" else 180
STAGES = {"downloading", "decoding", "separating", "features", "loading-model", "analyzing"}
ERROR_CODES = {"dependency-missing", "tool-missing", "download-timeout", "decode-timeout",
               "download-failed", "decode-failed", "download-rejected", "analysis-failed"}


def read_stage(root):
    try:
        stage = (root / "stage").read_text().strip()
        return stage if stage in STAGES else None
    except OSError:
        return None


def failure_ttl(job):
    if job.get("reason") == "cancelled":
        return 0
    return 60 if job.get("reason") in ("dependency-missing", "tool-missing") else 15



def cpu_threads():
    try:
        available = len(os.sched_getaffinity(0))
    except AttributeError:
        available = os.cpu_count() or 1
    try:
        requested = int(os.environ.get("AUDIO_ANALYSIS_THREADS", "6"))
    except ValueError:
        requested = 6
    return max(1, min(available, requested))


def valid_segments(value):
    if not isinstance(value, list) or len(value) > 200:
        return False
    return all(isinstance(s, dict) and isinstance(s.get("label"), str) and
               isinstance(s.get("start"), (int, float)) and isinstance(s.get("end"), (int, float)) and
               math.isfinite(s["start"]) and math.isfinite(s["end"]) and
               0 <= s["start"] < s["end"] <= 900 for s in value)


def read_cache(video_id):
    # Prefer an already available full-model result. Never label a fast result
    # as All-In-One, and never let a fast cache overwrite a full-model result.
    profiles = [("fold0-v1", "full")]
    if ENGINE == "fast":
        profiles.append((FAST_PROFILE, "fast"))
    for profile, engine in profiles:
        try:
            path = CACHE_DIR / f"{profile}-{video_id}.json"
            if path.stat().st_size > 100000:
                continue
            data = json.loads(path.read_text())
            ttl = 300 if engine == "fast" and not data.get("segments") else CACHE_TTL
            if time.time() - data["updated"] > ttl or not valid_segments(data["segments"]):
                continue
            return {"status": "ready", "engine": engine, "segments": data["segments"], "updated": data["updated"], "cached": True}
        except (OSError, ValueError, TypeError, KeyError):
            continue
    return None


def save_cache(video_id, job):
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        profile = FAST_PROFILE if job.get("engine", ENGINE) == "fast" else "fold0-v1"
        path = CACHE_DIR / f"{profile}-{video_id}.json"
        temp = path.with_suffix(".tmp")
        temp.write_text(json.dumps({"updated": time.time(), "segments": job["segments"]}))
        temp.replace(path)
        files = sorted(CACHE_DIR.glob("*-v[12]-*.json"), key=lambda p: p.stat().st_mtime)
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
    errors = None
    began = time.monotonic()
    tempdir = tempfile.TemporaryDirectory(prefix="muverse-audio-")
    try:
        # Parent owns temporary audio, so even a hard-killed child leaves no files.
        root = Path(tempdir.name)
        env = os.environ.copy()
        env["AUDIO_ANALYSIS_ENGINE"] = ENGINE
        threads = str(cpu_threads())
        for name in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "AUDIO_ANALYSIS_THREADS"):
            env[name] = threads
        errors = (root / "worker.log").open("w+b")
        process = subprocess.Popen([sys.executable, str(RUNNER), video_id, str(root)],
                                   stdout=subprocess.PIPE, stderr=errors, env=env,
                                   start_new_session=(os.name != "nt"))
        started = time.monotonic()
        with LOCK:
            queued_seconds = max(0, time.time() - JOBS[video_id].get("created", time.time()))
        remaining = max(0, JOB_TIMEOUT - queued_seconds)
        while True:
            try:
                output, _ = process.communicate(timeout=1)
                break
            except subprocess.TimeoutExpired:
                if abandoned(video_id):
                    raise RuntimeError("cancelled")
                if time.monotonic() - started > remaining:
                    raise RuntimeError("timeout")
                try:
                    stage = read_stage(root)
                    if stage:
                        # Keep temporary diagnostics bounded even for noisy models.
                        if errors.seek(0, 2) > 65536:
                            errors.seek(-16384, 2)
                            tail = errors.read()
                            errors.seek(0)
                            errors.write(tail)
                            errors.truncate()
                            errors.flush()
                        with LOCK:
                            previous = JOBS[video_id].get("stage")
                            JOBS[video_id]["stage"] = stage
                        if stage != previous:
                            print(f"[audio] {video_id}: {stage} (elapsed {time.monotonic() - began:.1f}s)", flush=True)
                except OSError:
                    pass
        stage = read_stage(root)
        if stage:
            with LOCK:
                JOBS[video_id]["stage"] = stage
        if process.returncode:
            try:
                detail = json.loads(output.decode().strip().splitlines()[-1])
                reason = detail.get("error")
            except (ValueError, IndexError, UnicodeError, AttributeError):
                reason = None
            raise RuntimeError(reason if reason in ERROR_CODES else "audio-analysis-unavailable")
        result = json.loads(output.decode().strip().splitlines()[-1])
        if not valid_segments(result["segments"]):
            raise RuntimeError("invalid-result")
        if ENGINE == "fast" and isinstance(result.get("diagnostics"), dict):
            summary = {k: v for k, v in result["diagnostics"].items() if k in ("reason", "candidatePairs", "eligibleFamilies") and isinstance(v, (str, int))}
            print(f"[audio] {video_id}: fast summary {json.dumps(summary)}", flush=True)
        job = {"status": "ready", "engine": ENGINE, "segments": result["segments"]}
        save_cache(video_id, job)
    except Exception as error:
        if process is not None:
            stop_process(process)
        stage = read_stage(Path(tempdir.name))
        if stage:
            with LOCK:
                JOBS[video_id]["stage"] = stage
        reason = str(error) if str(error) in ERROR_CODES | {"cancelled", "timeout"} else "audio-analysis-unavailable"
        job = {"status": "failed", "reason": reason, "stage": JOBS.get(video_id, {}).get("stage", "unknown")}
    finally:
        if errors is not None:
            if job.get("status") == "failed":
                errors.seek(max(0, errors.seek(0, 2) - 4096))
                tail = errors.read().decode("utf-8", errors="replace")
                # Local diagnostic only. Never send raw traceback/URLs to the UI.
                tail = re.sub(r"https?://\S+", "<url>", tail)
                for line in tail.splitlines()[-6:]:
                    print(f"[audio-error] {video_id}: {line[:500]}", flush=True)
            errors.close()
        try:
            timings = json.loads((Path(tempdir.name) / "timings.json").read_text())
            measured = {k: v for k, v in timings.items() if k in ("separating", "features", "loading-model", "analyzing") and isinstance(v, (int, float))}
            print(f"[audio] {video_id}: phase seconds {json.dumps(measured)}", flush=True)
        except (OSError, ValueError, AttributeError):
            pass
        tempdir.cleanup()
    with LOCK:
        JOBS[video_id] = {**job, "updated": time.time()}
    print(f"[audio] {video_id}: {job['status']} ({time.monotonic() - began:.1f}s) {job.get('reason', '')} stage={job.get('stage', 'complete')}", flush=True)


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
            return self.respond(200, {"status": "ok", "version": "fast-experiment-v2.1", "engine": ENGINE, "cpuThreads": cpu_threads()})
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
                ttl = failure_ttl(job) if job["status"] == "failed" else 86400
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
                    return self.respond(429, {"status": "busy", "engine": ENGINE})
                if len(JOBS) >= 128:
                    completed = [k for k, j in JOBS.items() if j["status"] in ("ready", "failed")]
                    if completed:
                        del JOBS[min(completed, key=lambda k: JOBS[k]["updated"])]
                JOBS[video_id] = {"status": "queued", "updated": now, "lastRequested": now, "created": now, "engine": ENGINE}
                POOL.submit(run_job, video_id)
            JOBS[video_id]["lastRequested"] = now
            result = {k: v for k, v in JOBS[video_id].items() if k not in ("lastRequested", "created")}
            result.setdefault("engine", ENGINE)
        self.respond(200, result)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("AUDIO_ANALYSIS_PORT", "8765"))), Handler).serve_forever()
