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


# --- ADAAAA-7669: opt-in English translation --------------------------------


def _capture_post(monkeypatch, payload):
    """Patch httpx.post and return the captured request kwargs list."""
    seen = []

    def fake(url, **kwargs):
        seen.append({"url": url, **kwargs})
        return _Resp(payload)

    monkeypatch.setattr(httpx, "post", fake)
    return seen


def test_task_defaults_to_transcribe_when_asr_task_is_unset(monkeypatch):
    """Deployed default must not change: no env => source-language transcription."""
    monkeypatch.delenv("ASR_TASK", raising=False)
    seen = _capture_post(monkeypatch, {"text": "No, municipal de Corellán, empieza ya a rodar el balón."})
    gemma.transcribe_audio("http://asr:8082", "AAAA", 16000)
    assert seen[0]["json"]["task"] == "transcribe"


def test_asr_task_env_opts_into_translation(monkeypatch):
    monkeypatch.setenv("ASR_TASK", "translate")
    seen = _capture_post(monkeypatch, {"text": "Not the main goal of Corrella, start to roll the ball."})
    text, _lat = gemma.transcribe_audio("http://asr:8082", "AAAA", 16000)
    assert seen[0]["json"]["task"] == "translate"
    assert text == "Not the main goal of Corrella, start to roll the ball."
    # The other contract fields are untouched (additive change only).
    assert seen[0]["json"]["audio"] == "AAAA"
    assert seen[0]["json"]["sample_rate"] == 16000


def test_explicit_task_argument_overrides_the_env(monkeypatch):
    monkeypatch.setenv("ASR_TASK", "transcribe")
    seen = _capture_post(monkeypatch, {"text": "English from a translated window."})
    gemma.transcribe_audio("http://asr:8082", "AAAA", 16000, task="translate")
    assert seen[0]["json"]["task"] == "translate"


def test_unknown_asr_task_falls_back_to_transcribe(monkeypatch):
    monkeypatch.setenv("ASR_TASK", "translte")
    seen = _capture_post(monkeypatch, {"text": "Texto en español del partido de hoy."})
    gemma.transcribe_audio("http://asr:8082", "AAAA", 16000)
    assert seen[0]["json"]["task"] == "transcribe"


def test_quality_guard_still_drops_filler_after_a_translated_payload(monkeypatch):
    """The guard runs AFTER translation: whisper's translate task answers silence
    with the same English filler set, and that must still become "" (so the
    window keeps `audio.path: none`)."""
    monkeypatch.setenv("ASR_TASK", "translate")
    for junk in ["What?", "Thank you very much.", "You", "", "..."]:
        _capture_post(monkeypatch, {"text": junk, "asrTask": "translate"})
        assert gemma.transcribe_audio("http://asr:8082", "AAAA", 16000)[0] == "", junk


def test_quality_guard_keeps_translated_english_commentary(monkeypatch):
    monkeypatch.setenv("ASR_TASK", "translate")
    english = "Not the main goal of Corrella, start to roll the ball."
    _capture_post(monkeypatch, {"text": english, "asrTask": "translate"})
    assert gemma.transcribe_audio("http://asr:8082", "AAAA", 16000)[0] == english


def test_missing_audio_skips_the_call_entirely(monkeypatch):
    monkeypatch.setenv("ASR_TASK", "translate")
    seen = _capture_post(monkeypatch, {"text": "unused"})
    assert gemma.transcribe_audio("http://asr:8082", "", 16000) == ("", 0.0)
    assert seen == []
