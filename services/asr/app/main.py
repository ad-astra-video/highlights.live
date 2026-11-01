"""Cheap ASR endpoint for the highlights decide path (ADAAAA-6314 Path 2).

Serves POST /transcribe so services/decide can ASR the trigger-window audio
into text to inject into the gemma decide prompt. Contract (see
services/decide/app/gemma.py::transcribe_audio):

    POST {url}/transcribe  {"audio": "<wav base64>", "sample_rate": 16000}
    -> {"text": "<transcript>",
        "asrFormat": "int16/16000Hz/ch1",   # ADAAAA-7665 additive evidence
        "asrRms": 0.1277, "asrSampleRate": 16000, "asrSeconds": 11.9,
        "asrError": ""}

Any failure returns {"text": ""} with HTTP 200 (never 5xx) so the decide path
degrades to text-only instead of dying on an ASR glitch — that contract is the
caller's expectation.

Sample-format handling (ADAAAA-7665): the scale factor MUST come from the WAV
header's own dtype, not an assumed int16. The endpoint used to divide every
buffer by 32768, so a float32 payload (already in -1..1) was scaled to ~1e-6 RMS
and whisper answered "" — the identical symptom a byte-misaligned/truncated
payload produces. `wavfile.read` gives the dtype, so:
    int16 -> /32768, int32 -> /2**31, uint8 -> (x-128)/128, float -> identity.
The decoded format/RMS/duration ride the response so a bad payload is visible in
the decide analysis block instead of invisible.

Uses faster-whisper (CTranslate2). DEVICE defaults to cpu for a "cheap"
endpoint that satisfies the live 1-5 s budget on a small model; set
ASR_DEVICE=cuda and reserve a GPU if a larger/faster model is configured.
"""

from __future__ import annotations

import base64
import io
import logging
import math
import os
import time
from typing import Mapping

import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel
from scipy.io import wavfile

app = FastAPI(title="highlights-asr")
log = logging.getLogger("highlights.asr")
if not log.handlers:
    logging.basicConfig(level=os.environ.get("ASR_LOG_LEVEL", "INFO"))

MODEL_SIZE = os.environ.get("ASR_MODEL", "base")
DEVICE = os.environ.get("ASR_DEVICE", "cpu").lower()
COMPUTE_TYPE = os.environ.get("ASR_COMPUTE_TYPE", "int8")
N_THREADS = int(os.environ.get("ASR_THREADS", "8"))
# ADAAAA-7665: a clip shorter than this cannot carry a sentence; report it as a
# payload problem (asrError) instead of letting whisper hallucinate on 100 ms.
MIN_USABLE_SECONDS = float(os.environ.get("ASR_MIN_SECONDS", "0.5"))
# Below this RMS the window is effectively silent; still 200 + "" but visible.
SILENCE_RMS = float(os.environ.get("ASR_SILENCE_RMS", "0.002"))

_model = None
_model_lock = False

# dtype -> (format label, scale denominator). float dtypes are already -1..1.
_INT_PCM_FORMATS: Mapping[str, tuple[str, float]] = {
    "int16": ("int16", 32768.0),
    "int32": ("int32", 2147483648.0),
    "uint8": ("uint8", 128.0),
}


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
    # ADAAAA-7665: additive payload evidence. Defaults keep the old contract
    # usable by any caller that only reads `text`.
    asrFormat: str = ""
    asrRms: float = 0.0
    asrSampleRate: int = 0
    asrSeconds: float = 0.0
    asrError: str = ""


def decode_wav_bytes(raw: bytes) -> tuple[np.ndarray, int, str, str]:
    """Decode a WAV payload to mono float32 at its native rate.

    Returns (audio, sample_rate, format_label, error). The scale factor comes
    from the header's dtype; a format we cannot reason about yields an error
    string and zeroed audio rather than a silently mis-scaled buffer.
    """
    try:
        sr, data = wavfile.read(io.BytesIO(raw))
    except Exception as exc:  # malformed / truncated header
        return np.zeros(0, dtype=np.float32), 0, "", f"wav_decode_failed:{type(exc).__name__}"
    channels = int(data.shape[-1]) if data.ndim > 1 else 1
    # Capture the HEADER dtype before any downmix: averaging a stereo int16
    # array yields float64, which would misreport the format.
    dtype = data.dtype.name
    if data.ndim > 1:
        data = data.mean(axis=1)
    scale: float | None
    if dtype in _INT_PCM_FORMATS:
        label, scale = _INT_PCM_FORMATS[dtype]
    elif dtype in ("float32", "float64"):
        label, scale = dtype, None
    else:
        return np.zeros(0, dtype=np.float32), int(sr), dtype, f"unsupported_dtype:{dtype}"
    audio = data.astype(np.float32)
    if scale is not None:
        # uint8 PCM is unsigned with 128 as the midpoint.
        if dtype == "uint8":
            audio = (audio - 128.0) / 128.0
        else:
            audio = audio / scale
    # Never feed NaN/Inf or out-of-range samples to the model.
    audio = np.nan_to_num(audio, nan=0.0, posinf=0.0, neginf=0.0)
    np.clip(audio, -1.0, 1.0, out=audio)
    return audio, int(sr), f"{label}/{int(sr)}Hz/ch{channels}", ""


def _rms(audio: np.ndarray) -> float:
    if audio.size == 0:
        return 0.0
    return float(math.sqrt(float(np.mean(audio.astype(np.float32) ** 2))))


@app.on_event("startup")
def _warm():
    # Warm the model load on startup so the first /transcribe doesn't pay the
    # cold-load cost (which would otherwise push the live p50/p95 out of budget).
    _get_model()


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "model": MODEL_SIZE,
        "device": DEVICE,
        "computeType": COMPUTE_TYPE,
        "minSeconds": MIN_USABLE_SECONDS,
    }


@app.post("/transcribe", response_model=TranscribeResponse)
def transcribe(req: TranscribeRequest) -> TranscribeResponse:
    t0 = time.monotonic()
    text = ""
    fmt = ""
    rate = 0
    seconds = 0.0
    rms = 0.0
    err = ""
    try:
        raw = base64.b64decode(req.audio)
        audio, sr, fmt, err = decode_wav_bytes(raw)
        rate = sr
        seconds = round(audio.shape[0] / float(sr), 3) if sr else 0.0
        rms = round(_rms(audio), 5)
        log.info(
            "[asr] bytes=%d b64=%d fmt=%s secs=%s rms=%s err=%s",
            len(raw), len(req.audio), fmt, seconds, rms, err or "-",
        )
        if err:
            # Visible payload problem: 200 + "" keeps the caller alive, the
            # error string makes the failure legible in the analysis block.
            text = ""
        elif seconds < MIN_USABLE_SECONDS:
            text = ""
            err = f"too_short:{seconds}s<{MIN_USABLE_SECONDS}s"
            log.warning("[asr] payload too short (%ss) — skipping inference", seconds)
        elif rms < SILENCE_RMS:
            text = ""
            log.info("[asr] silent window (rms=%s) — empty transcript by design", rms)
        else:
            # Resample if the clip is not 16 kHz (faster_whisper needs a numpy
            # array at 16 kHz; resample via linear interpolation to keep zero
            # extra hard deps).
            if int(sr) != 16000:
                n = int(round(audio.shape[0] * 16000 / sr))
                audio = np.interp(
                    np.linspace(0, audio.shape[0] - 1, n), np.arange(audio.shape[0]), audio
                ).astype(np.float32)
            model = _get_model()
            segments, _info = model.transcribe(audio, beam_size=1, language=None)
            text = " ".join(seg.text for seg in segments).strip()
    except Exception as exc:  # degrade to empty transcript — never 5xx
        text = ""
        err = err or f"transcribe_failed:{type(exc).__name__}"
        log.warning("[asr] transcribe failed: %s", type(exc).__name__)
    elapsed = round(time.monotonic() - t0, 3)
    log.info("[asr] done %.3fs text_len=%d", elapsed, len(text))
    return TranscribeResponse(
        text=text,
        asrFormat=fmt,
        asrRms=rms,
        asrSampleRate=rate,
        asrSeconds=seconds,
        asrError=err,
    )
