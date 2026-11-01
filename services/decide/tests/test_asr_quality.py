"""ASR transcript quality guard (ADAAAA-7665).

Whisper's canonical silence hallucinations must never reach the decide prompt or
the persisted analysis block: they are filler, not commentary. Run from
services/decide with `python3 -m pytest tests/test_asr_quality.py -q`.
"""

import httpx

from app import gemma


class _Resp:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


def test_hallucination_set_is_dropped():
    for junk in [
        "What?", "Go!", "Oh", "Bye.", "You", "Okay.", "And", "よ",
        "Thank you very much.", ". . . . . . .", "Yes, yes, yes, yes…",
        "", "   ", "...",
    ]:
        assert gemma.usable_transcript(junk) == "", junk


def test_real_commentary_is_kept():
    for good in [
        "No, municipal de Corellán, empieza ya a rodar el balón.",
        "Espectación para ver a estos chicos de la Levinia del Barça.",
        "GOOOAL what a strike from the right wing",
        "from Manchester City.",
    ]:
        assert gemma.usable_transcript(good) == good


def test_two_word_phrase_is_treated_as_filler():
    assert gemma.usable_transcript("great goal") == ""
    assert gemma.usable_transcript("Nice shot") == ""


def test_transcribe_audio_drops_filler_from_the_endpoint(monkeypatch):
    monkeypatch.setattr(
        httpx, "post", lambda *a, **k: _Resp({"text": "What?", "asrFormat": "int16/16000Hz/ch1"})
    )
    text, _lat = gemma.transcribe_audio("http://asr:8082", "AAAA", 16000)
    assert text == ""


def test_transcribe_audio_keeps_real_speech(monkeypatch):
    real = "El primer es atrás para Landry."
    monkeypatch.setattr(httpx, "post", lambda *a, **k: _Resp({"text": real}))
    text, _lat = gemma.transcribe_audio("http://asr:8082", "AAAA", 16000)
    assert text == real


def test_transcribe_audio_still_degrades_to_empty_on_transport_error(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("asr down")

    monkeypatch.setattr(httpx, "post", boom)
    assert gemma.transcribe_audio("http://asr:8082", "AAAA", 16000)[0] == ""
