import importlib.util
import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

spec = importlib.util.spec_from_file_location("audio_worker", __file__.replace("test_server.py", "server.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class JobsTest(unittest.TestCase):
    def setUp(self):
        worker.JOBS.clear()
        self.pool = patch.object(worker, "POOL", Mock()).start()
        self.token = patch.object(worker, "TOKEN", "test-secret").start()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), worker.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        patch.stopall()

    def post(self, path, token="test-secret"):
        request = Request(f"http://127.0.0.1:{self.server.server_port}" + path,
                          data=b"", headers={"Authorization": "Bearer " + token}, method="POST")
        try:
            with urlopen(request) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    def test_validation_auth_dedup_and_queue_capacity(self):
        self.assertEqual(self.post("/jobs/RXQCY_zxz-E", token="wrong")[0], 401)
        self.assertEqual(self.post("/jobs/not-a-video")[0], 200)  # a valid 11-character ID
        self.assertEqual(self.post("/jobs/https://example.org")[0], 400)
        for _ in range(2):
            self.assertEqual(self.post("/jobs/RXQCY_zxz-E")[1]["status"], "queued")
        self.assertEqual(self.pool.submit.call_count, 2)
        for i in range(6):
            self.post(f"/jobs/clip{i:07d}")
        self.assertEqual(self.post("/jobs/u_vusNeo6xI")[0], 429)

    def test_completed_job_reused_and_failure_retried_after_ttl(self):
        import time
        worker.JOBS["RXQCY_zxz-E"] = {"status": "ready", "segments": [], "updated": time.time()}
        self.assertEqual(self.post("/jobs/RXQCY_zxz-E")[1]["status"], "ready")
        self.pool.submit.assert_not_called()
        worker.JOBS["RXQCY_zxz-E"] = {"status": "failed", "updated": time.time() - 301}
        self.assertEqual(self.post("/jobs/RXQCY_zxz-E")[1]["status"], "queued")
        self.pool.submit.assert_called_once()

    def test_runner_error_is_not_a_success_or_a_leaked_exception(self):
        with patch.object(worker.subprocess, "Popen", side_effect=OSError("sensitive path")):
            worker.run_job("RXQCY_zxz-E")
        self.assertEqual(worker.JOBS["RXQCY_zxz-E"]["status"], "failed")
        self.assertNotIn("sensitive", json.dumps(worker.JOBS))


if __name__ == "__main__":
    unittest.main()
