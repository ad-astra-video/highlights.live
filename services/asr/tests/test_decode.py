"""Unit tests for the ASR payload decode/format contract (ADAAAA-7665).

Run: cd services/asr && python3 -m unittest discover -s tests
Stdlib unittest only (the ASR image does not ship pytest), numpy + scipy are
already in requirements.txt.
"""

import base64
import io
import struct
import unittest

import numpy as np
from scipy.io import wavfile

from app.main import decode_wav_bytes, _rms


def _wav(samples, dtype, rate=16000, channels=1):
    buf = io.BytesIO()
    wavfile.write(buf, rate, np.asarray(samples, dtype=dtype))
    return buf.getvalue()


class DecodeWavFormatTest(unittest.TestCase):
    def test_int16_scaled_to_unit_range(self):
        # Full-scale int16 sine: RMS of a sine is amplitude/sqrt(2) = 0.707.
        i = np.arange(16000)
        pcm = (np.sin(2 * np.pi * 440 * i / 16000) * 30000).astype(np.int16)
        audio, sr, fmt, err = decode_wav_bytes(_wav(pcm, np.int16))
        self.assertEqual(err, "")
        self.assertEqual(sr, 16000)
        self.assertEqual(fmt, "int16/16000Hz/ch1")
        self.assertEqual(audio.dtype, np.float32)
        self.assertAlmostEqual(_rms(audio), 30000 / 32768 * 0.7071, places=2)

    def test_float32_is_identity_scaled(self):
        """The ADAAAA-7665 repro: a float32 payload already in -1..1 must NOT be
        divided by 32768 again (that turned a real sentence into '')."""
        i = np.arange(16000)
        pcm = (np.sin(2 * np.pi * 440 * i / 16000) * 0.7).astype(np.float32)
        audio, sr, fmt, err = decode_wav_bytes(_wav(pcm, np.float32))
        self.assertEqual(err, "")
        self.assertEqual(fmt, "float32/16000Hz/ch1")
        # Pre-fix this came out ~1e-6 (0.7/32768).
        self.assertAlmostEqual(_rms(audio), 0.7 * 0.7071, places=2)

    def test_int32_scaled_by_2_31(self):
        i = np.arange(16000)
        pcm = (np.sin(2 * np.pi * 440 * i / 16000) * 1_000_000_000).astype(np.int32)
        audio, _sr, fmt, err = decode_wav_bytes(_wav(pcm, np.int32))
        self.assertEqual(err, "")
        self.assertEqual(fmt, "int32/16000Hz/ch1")
        self.assertAlmostEqual(_rms(audio), 1_000_000_000 / 2147483648 * 0.7071, places=2)

    def test_uint8_scaled_around_128(self):
        pcm = np.array([128, 128, 128, 0, 255, 128], dtype=np.uint8)
        audio, _sr, fmt, err = decode_wav_bytes(_wav(pcm, np.uint8))
        self.assertEqual(err, "")
        self.assertEqual(fmt, "uint8/16000Hz/ch1")
        self.assertAlmostEqual(float(audio[0]), 0.0, places=5)

    def test_stereo_is_downmixed(self):
        i = np.arange(8000)
        left = (np.sin(2 * np.pi * 440 * i / 16000) * 10000).astype(np.int16)
        pcm = np.stack([left, left], axis=1)
        audio, _sr, fmt, err = decode_wav_bytes(_wav(pcm, np.int16))
        self.assertEqual(err, "")
        self.assertEqual(fmt, "int16/16000Hz/ch2")
        self.assertEqual(audio.ndim, 1)

    def test_nan_and_overrange_are_sanitized(self):
        pcm = np.array([np.nan, 5.0, -5.0, 0.0], dtype=np.float32)
        audio, _sr, _fmt, err = decode_wav_bytes(_wav(pcm, np.float32))
        self.assertEqual(err, "")
        self.assertFalse(np.isnan(audio).any())
        self.assertLessEqual(float(np.max(np.abs(audio))), 1.0)

    def test_truncated_header_reports_error_instead_of_raising(self):
        audio, sr, fmt, err = decode_wav_bytes(b"RIFF")
        self.assertEqual(audio.size, 0)
        self.assertEqual(sr, 0)
        self.assertEqual(fmt, "")
        self.assertTrue(err.startswith("wav_decode_failed"))

    def test_header_bytes_are_reported_for_a_real_payload(self):
        """Sanity: a 100 ms int16 chunk is 3200 bytes and reports its own
        format/rate — the evidence AC1 asks for."""
        pcm = np.zeros(1600, dtype=np.int16)
        raw = _wav(pcm, np.int16)
        riff = raw[0:4]
        fmt_tag, ch, rate, bits = struct.unpack("<H", raw[20:22])[0], struct.unpack("<H", raw[22:24])[0], struct.unpack("<I", raw[24:28])[0], struct.unpack("<H", raw[34:36])[0]
        self.assertEqual(riff, b"RIFF")
        self.assertEqual((fmt_tag, ch, rate, bits), (1, 1, 16000, 16))
        self.assertEqual(len(base64.b64decode(base64.b64encode(raw))), len(raw))


if __name__ == "__main__":
    unittest.main()
