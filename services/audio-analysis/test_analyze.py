import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("audio_runner", Path(__file__).with_name("analyze.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class PhaseTest(unittest.TestCase):
    def test_reports_each_real_pipeline_phase_and_restores_library(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            observed = []
            pipeline = types.ModuleType("allin1.analyze")
            originals = {}
            for name in ["demix", "extract_spectrograms", "load_pretrained_model", "run_inference"]:
                def step(name=name):
                    observed.append((name, (root / "stage").read_text()))
                originals[name] = step
                setattr(pipeline, name, step)
            def analyze(*args, **kwargs):
                self.assertEqual(kwargs["device"], "cpu")
                for name in originals:
                    getattr(pipeline, name)()
                return types.SimpleNamespace(segments=[types.SimpleNamespace(start=64, end=80.9, label="chorus")])
            library = types.ModuleType("allin1")
            library.analyze = analyze
            torch = types.ModuleType("torch")
            torch.set_num_threads = Mock()
            torch.set_num_interop_threads = Mock()
            with patch.dict(sys.modules, {"allin1": library, "allin1.analyze": pipeline, "torch": torch}), \
                 patch.dict(runner.os.environ, {"AUDIO_ANALYSIS_THREADS": "6", "AUDIO_ANALYSIS_DEVICE": "cpu", "AUDIO_ANALYSIS_ENGINE": "full"}), \
                 patch.object(runner.subprocess, "run", side_effect=lambda *a, **k: (root / "audio.wav").write_bytes(b"fake")):
                result = runner.analyze("RXQCY_zxz-E", root)
            self.assertEqual([stage for _, stage in observed], ["separating", "features", "loading-model", "analyzing"])
            self.assertEqual(result["segments"][0]["start"], 64)
            torch.set_num_threads.assert_called_once_with(6)
            for name, original in originals.items():
                self.assertIs(getattr(pipeline, name), original)
            self.assertTrue((root / "timings.json").exists())

    def test_cuda_request_fails_explicitly_when_cuda_is_not_available(self):
        torch = types.ModuleType("torch")
        torch.set_num_threads = Mock()
        torch.set_num_interop_threads = Mock()
        torch.cuda = types.SimpleNamespace(is_available=lambda: False)
        with tempfile.TemporaryDirectory() as folder, \
             patch.dict(sys.modules, {"torch": torch}), \
             patch.dict(runner.os.environ, {"AUDIO_ANALYSIS_DEVICE": "cuda"}):
            with self.assertRaisesRegex(RuntimeError, "CUDA requested but unavailable"):
                runner.analyze_file(Path("existing.wav"), Path(folder))

    def test_fast_download_path_does_not_import_heavy_models_or_create_wav(self):
        fast = types.ModuleType("fast_analysis")
        fast.analyze_file = Mock(return_value={"engine": "fast", "segments": []})
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with patch.dict(sys.modules, {"fast_analysis": fast, "torch": None, "allin1": None}), \
                 patch.dict(runner.os.environ, {"AUDIO_ANALYSIS_ENGINE": "fast"}), \
                 patch.object(runner.subprocess, "run", side_effect=lambda *a, **k: (root / "audio.webm").write_bytes(b"fake")) as download:
                result = runner.analyze("RXQCY_zxz-E", root)
            self.assertEqual(result["engine"], "fast")
            self.assertNotIn("--extract-audio", download.call_args.args[0])
            self.assertEqual(download.call_args.kwargs["timeout"], 20)
            self.assertFalse((root / "audio.wav").exists())
            fast.analyze_file.assert_called_once_with(root / "audio.webm", root)

    def test_download_deadline_is_distinguished_from_audio_analysis_failure(self):
        self.assertEqual(runner.failure_reason(runner.subprocess.TimeoutExpired("yt_dlp", 20), "downloading"), "download-timeout")
        self.assertEqual(runner.failure_reason(runner.subprocess.CalledProcessError(1, "yt_dlp"), "downloading"), "download-failed")
        self.assertEqual(runner.failure_reason(ValueError("DSP failure"), "analyzing"), "analysis-failed")
        self.assertEqual(runner.failure_reason(ModuleNotFoundError("scipy"), "features"), "dependency-missing")


if __name__ == "__main__":
    unittest.main()
