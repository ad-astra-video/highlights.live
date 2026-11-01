"""Whisper task plumb-through for POST /transcribe (ADAAAA-7669).

Run: cd services/asr && python3 -m unittest discover -s tests

Stdlib unittest only (the ASR image does not ship pytest). `WhisperModel` is
mocked: this asserts the CONTRACT (which task reaches the model, and what the
response reports), not whisper's translation quality — that is measured on the
box against a real clip.
"""

import base64
import io
import unittest
from unittest import mock

import numpy as np
from scipy.io import wavfile

from app import main


def _wav_b64(seconds=1.0, rate=16000):
    """A 1 s 440 Hz int16 tone: long enough and loud enough to reach the model."""
    i = np.arange(int(rate * seconds))
    pcm = (np.sin(2 * np.pi * 440 * i / rate) * 6000).astype(np.int16)
    buf = io.BytesIO()
    wavfile.write(buf, rate, pcm)
    return base64.b64encode(buf.getvalue()).decode("ascii")


class _Seg:
    def __init__(self, text):
        self.text = text


class FakeWhisper:
    """Stand-in for faster_whisper.WhisperModel that records every call."""

    def __init__(self, text="Not the main goal of Corrella, start to roll the ball."):
        self.text = text
        self.calls = []

    def transcribe(self, audio, **kwargs):
        self.calls.append({"n_samples": int(audio.shape[0]), **kwargs})
        return [_Seg(self.text)], None


def _run(fake, **req_kwargs):
    """Drive the route function with the model swapped for `fake`."""
    order = main.TranscribeRequest(audio=_wav_b64(), **req_kwargs)
    with mock.patch.object(main, "_get_model", lambda: fake):
        return main.transcribe(order)


class TranscribeTaskTest(unittest.TestCase):
    def test_default_call_uses_transcribe_and_reports_it(self):
        """AC: a default call (no `task`) keeps source-language behaviour."""
        fake = FakeWhisper("No, municipal de Corellán, empieza ya a rodar el balón.")
        resp = _run(fake)
        self.assertEqual(fake.calls[0]["task"], "transcribe")
        self.assertEqual(resp.asrTask, "transcribe")
        # The transcript still rides through untouched (guard lives on decide).
        self.assertEqual(resp.text, fake.text)
        self.assertEqual(fake.calls[0]["language"], None)
        self.assertEqual(fake.calls[0]["beam_size"], 1)

    def test_translate_is_threaded_into_the_model_and_reported(self):
        """AC: {"task":"translate"} -> English text + asrTask "translate"."""
        fake = FakeWhisper()
        resp = _run(fake, task="translate")
        self.assertEqual(fake.calls[0]["task"], "translate")
        self.assertEqual(resp.asrTask, "translate")
        self.assertEqual(resp.text, "Not the main goal of Corrella, start to roll the ball.")
        self.assertEqual(resp.asrError, "")

    def test_task_is_case_and_whitespace_insensitive(self):
        fake = FakeWhisper("English text from a translated window.")
        resp = _run(fake, task="  TRANSLATE ")
        self.assertEqual(fake.calls[0]["task"], "translate")
        self.assertEqual(resp.asrTask, "translate")

    def test_unknown_task_falls_back_to_transcribe_and_is_reported(self):
        """A typo degrades to today's behaviour instead of erroring, but the
        response must not claim translation ran."""
        fake = FakeWhisper("Texto en español del partido.")
        resp = _run(fake, task="translte")
        self.assertEqual(fake.calls[0]["task"], "transcribe")
        self.assertEqual(resp.asrTask, "transcribe")
        # The transcript is NOT suppressed by the bad-task note.
        self.assertEqual(resp.text, fake.text)
        self.assertEqual(resp.asrError, "bad_task:translte")

    def test_early_exit_still_reports_the_effective_task(self):
        """A silent/too-short window skips inference but `asrTask` must be
        truthful so the analysis block cannot mislabel a translation run."""
        silent = np.zeros(16000, dtype=np.int16)
        buf = io.BytesIO()
        wavfile.write(buf, 16000, silent)
        fake = FakeWhisper()
        req = main.TranscribeRequest(audio=base64.b64encode(buf.getvalue()).decode(), task="translate")
        with mock.patch.object(main, "_get_model", lambda: fake):
            resp = main.transcribe(req)
        self.assertEqual(fake.calls, [])  # silence gate kept the model idle
        self.assertEqual(resp.text, "")
        self.assertEqual(resp.asrTask, "translate")

    def test_request_default_is_transcribe(self):
        self.assertEqual(main.TranscribeRequest(audio="AAAA").task, "transcribe")
        self.assertEqual(main.normalize_task(None), "transcribe")
        self.assertEqual(main.normalize_task("translate"), "translate")
        self.assertEqual(main.normalize_task("bogus"), "transcribe")


class TranscribeHttpContractTest(unittest.TestCase):
    """HTTP-level proof that `asrTask` is actually serialized (additive field).

    The response model body is what decide parses, so a route-function assertion
    alone would miss a field dropped by serialization.
    """

    def _client(self, fake):
        from fastapi.testclient import TestClient

        patcher = mock.patch.object(main, "_get_model", lambda: fake)
        patcher.start()
        self.addCleanup(patcher.stop)
        return TestClient(main.app)

    def test_post_translate_returns_english_and_asr_task(self):
        fake = FakeWhisper("Not the main goal of Corrella, start to roll the ball.")
        client = self._client(fake)
        with client:  # runs startup/_warm against the patched model
            body = client.post("/transcribe", json={"audio": _wav_b64(), "task": "translate"}).json()
        self.assertEqual(body["asrTask"], "translate")
        self.assertEqual(body["text"], fake.text)
        self.assertIn("asrFormat", body)
        self.assertEqual(body["asrError"], "")

    def test_post_without_task_defaults_to_transcribe(self):
        fake = FakeWhisper("No, municipal de Corellán, empieza ya a rodar el balón.")
        client = self._client(fake)
        with client:
            body = client.post("/transcribe", json={"audio": _wav_b64()}).json()
        self.assertEqual(body["asrTask"], "transcribe")
        self.assertEqual(body["text"], fake.text)
        self.assertEqual(fake.calls[0]["task"], "transcribe")


if __name__ == "__main__":
    unittest.main()
