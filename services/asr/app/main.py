"""Cheap ASR endpoint for the highlights decide path (ADAAAA-6314 Path 2).

Serves POST /transcribe so services/decide can ASR the trigger-window audio
into text to inject into the gemma decide prompt. Contract (see
services/decide/app/gemma.py::transcribe_audio):

    POST {url}/transcribe  {"audio": "<wav base64>", "sample_rate": 16000}
    -> {"text": "<transcript>"}

Any failure returns {"text": ""} with HTTP 200 (never 5xx) so the decide path
degrades to text-only instead of dying on an ASR glitch — that contract is the
caller's expectation.

Uses faster-whisper (CTranslate2). DEVICE defaults to cpu for a "cheap"
endpoint that satisfies the live 1-5 s budget on a small model; set
ASR_DEVICE=cuda and reserve a GPU if a larger/faster model is configured.
"""

from __future__ import annotations

import base64
import io
import os
import time

import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel
from scipy.io import wavfile

app = FastAPI(title="highlights-asr")

MODEL_SIZE = os.environ.get("ASR_MODEL", "base")
DEVICE = os.environ.get("ASR_DEVICE", "cpu").lower()
COMPUTE_TYPE = os.environ.get("ASR_COMPUTE_TYPE", "int8")
N_THREADS = int(os.environ.get("ASR_THREADS", "8"))

_model = None
_model_lock = False


def _get_model():
    """Lazily load the faster-whisper model (heavy, once per container)."""
    global _model, _model_lock
    if _model is not None:
        return _model
    from faster_whisper import WhisperModel

    _model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE, cpu_threads=N_THREADS)
    return _model


class TranscribeRequest(BaseModel):
    audio: str  # base64 of a mono WAV (e.g. 16 kHz 16-bit PCM)
    sample_rate: int = 16000


class TranscribeResponse(BaseModel):
    text: str


@app.on_event("startup")
def _warm():
    # Warm the model load on startup so the first /transcribe doesn't pay the
    # cold-load cost (which would otherwise push the live p50/p95 out of budget).
    _get_model()


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "model": MODEL_SIZE, "device": DEVICE}


@app.post("/transcribe", response_model=TranscribeResponse)
def transcribe(req: TranscribeRequest) -> TranscribeResponse:
    t0 = time.monotonic()
    text = ""
    try:
        raw = base64.b64decode(req.audio)
        sr, data = wavfile.read(io.BytesIO(raw))
        # Normalize to mono float32 at the model's expected rate (16 kHz).
        if data.ndim > 1:
            data = data.mean(axis=1)
        audio = data.astype(np.float32) / 32768.0
        # Resample if the clip is not 16 kHz (faster_whisper needs a numpy array
        # at 16 kHz; we decode the WAV header's rate and resample via simple
        # linear interpolation on the fly to keep zero extra hard deps).
        if int(sr) != 16000:
            n = int(round(audio.shape[0] * 16000 / sr))
            audio = np.interp(
                np.linspace(0, audio.shape[0] - 1, n), np.arange(audio.shape[0]), audio
            ).astype(np.float32)
        model = _get_model()
        segments, _info = model.transcribe(audio, beam_size=1, language=None)
        text = " ".join(seg.text for seg in segments).strip()
    except Exception:
        # Degrade to empty transcript — the caller runs text-only. Never 5xx.
        text = ""
    return TranscribeResponse(text=text)
