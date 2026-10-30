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
                for name in originals:
                    getattr(pipeline, name)()
                return types.SimpleNamespace(segments=[types.SimpleNamespace(start=64, end=80.9, label="chorus")])
            library = types.ModuleType("allin1")
            library.analyze = analyze
            torch = types.ModuleType("torch")
            torch.set_num_threads = Mock()
            torch.set_num_interop_threads = Mock()
            with patch.dict(sys.modules, {"allin1": library, "allin1.analyze": pipeline, "torch": torch}), \
                 patch.dict(runner.os.environ, {"AUDIO_ANALYSIS_THREADS": "6"}), \
                 patch.object(runner.subprocess, "run", side_effect=lambda *a, **k: (root / "audio.wav").write_bytes(b"fake")):
                result = runner.analyze("RXQCY_zxz-E", root)
            self.assertEqual([stage for _, stage in observed], ["separating", "features", "loading-model", "analyzing"])
            self.assertEqual(result["segments"][0]["start"], 64)
            torch.set_num_threads.assert_called_once_with(6)
            for name, original in originals.items():
                self.assertIs(getattr(pipeline, name), original)
            self.assertTrue((root / "timings.json").exists())


if __name__ == "__main__":
    unittest.main()
