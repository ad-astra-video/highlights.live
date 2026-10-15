"""Decide-runner clip stash + build-or-discard (ADAAAA-6741 G4).

The decide runner owns the **120 s frame+audio ring** (the stash), fed by the
media/orchestrator rail. G4 moves the clip build off the server and onto the
decide runner:

- The stash keeps a continuous ``ring_duration_s`` (120 s) in-memory ring of
  small JPEG frames (+ optional tiny audio segments). It is consumed from the
  media rail (``ingest``), so it holds the raw material for a clip with **no
  source re-read** and **no clip request to the server for frames**.
- ``preclip(trigger_ts)`` assembles the **20 s-before / 10 s-after** window
  straight from the stash.
- **Build-or-discard**: on a **confirmed** highlight the decide runner builds the
  clip (ffmpeg encode from the stash — local CPU work, no GPU inference) and
  uploads it to the server, which persists + publishes it. On a **discarded**
  moment the stash is freed: no clip is produced and no clip record is created.

This is deliberately import-light and deterministic so it can be unit-tested
without a GPU or a live rail; ffmpeg is only invoked by ``build_clip`` (and is
injected via ``config.ffmpeg_path`` so tests can stub it).
"""
from __future__ import annotations

import math
import os
import subprocess
import tempfile
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Callable, Deque, Dict, List, Optional, Tuple


# --------------------------------------------------------------------------
# Config + data types
# --------------------------------------------------------------------------
@dataclass
class StashConfig:
    ring_duration_s: float = 120.0     # continuous ring length
    clip_before_s: float = 20.0        # window before the trigger
    clip_after_s: float = 10.0         # window after the trigger
    ffmpeg_path: str = "ffmpeg"
    # Hard capacity guard (belt-and-suspenders): at a typical rail fps this is
    # well beyond ring_duration_s; a pathological ingestion rate cannot OOM.
    max_frames: int = 1200
    min_fps: float = 1.0               # floor for the clip encode framerate
    max_fps: float = 15.0              # ceiling (bounded encode cost)


@dataclass
class StashFrame:
    """One ingested frame (small JPEG) plus its optional audio segment."""

    ts: float
    seq: int
    jpeg: bytes
    audio: Optional[bytes] = None
    audio_mime: Optional[str] = None


class ClipStash:
    """Bounded 120 s frame+audio ring owned by the decide runner.

    ``ingest`` appends frames and evicts anything older than
    ``ring_duration_s`` from the newest frame, so the ring always holds the
    last 120 s — enough for a 20 s-before / 10 s-after pre-clip plus slack.
    """

    def __init__(self, config: Optional[StashConfig] = None):
        self.config = config or StashConfig()
        self._frames: Deque[StashFrame] = deque()
        self._seq = 0
        self._created = time.time()

    # --- ingestion --------------------------------------------------------
    def ingest(
        self,
        ts: float,
        seq: Optional[int] = None,
        jpeg: Optional[bytes] = None,
        audio: Optional[bytes] = None,
        audio_mime: Optional[str] = None,
        now: Optional[float] = None,
    ) -> None:
        """Add one rail frame (JPEG bytes + optional audio segment).

        ``now`` is injectable for deterministic eviction tests; it defaults to
        ``ts`` if not given (the rail timestamps are the ring clock).
        """
        self._seq = seq if seq is not None else self._seq + 1
        f = StashFrame(
            ts=float(ts),
            seq=int(self._seq),
            jpeg=bytes(jpeg) if jpeg is not None else b"",
            audio=bytes(audio) if audio is not None else None,
            audio_mime=audio_mime,
        )
        self._frames.append(f)
        # Evict anything older than the ring window measured against the newest
        # frame's timestamp (the ring clock).
        newest = self._frames[-1].ts
        cutoff = newest - self.config.ring_duration_s
        while self._frames and self._frames[0].ts < cutoff:
            self._frames.popleft()
        while len(self._frames) > self.config.max_frames:
            self._frames.popleft()

    # --- windowing --------------------------------------------------------
    def window(self, start: float, end: float) -> Tuple[List[StashFrame], List[StashFrame]]:
        """Return (video_frames, audio_frames) whose ts fall in [start, end].

        Audio and video are returned separately because a clip muxes them from
        two inputs; frames that carry audio are in the video list too (their
        ``.audio`` is used when building the audio track)."""
        frames = [f for f in self._frames if start <= f.ts <= end]
        video = [f for f in frames if f.jpeg]
        audio = [f for f in frames if f.audio]
        return video, audio

    def preclip(
        self,
        trigger_ts: float,
        before_s: Optional[float] = None,
        after_s: Optional[float] = None,
    ) -> Tuple[List[StashFrame], List[StashFrame], float, float]:
        """Assemble the 20 s-before / 10 s-after pre-clip from the stash.

        Returns (video_frames, audio_frames, window_start, window_end)."""
        before = self.config.clip_before_s if before_s is None else before_s
        after = self.config.clip_after_s if after_s is None else after_s
        start = max(0.0, trigger_ts - before)
        end = trigger_ts + after
        video, audio = self.window(start, end)
        return video, audio, start, end

    # --- clip building (local CPU encode; no source re-read) --------------
    def estimate_fps(self, frames: List[StashFrame]) -> float:
        """Estimate a bounded encode framerate from frame timestamps."""
        if not frames:
            return self.config.min_fps
        ts = [f.ts for f in frames]
        lo, hi = min(ts), max(ts)
        span = hi - lo
        n = len(frames)
        if span <= 1e-6:
            # Single (or all-identical) timestamps: fall back to 1 fps so the
            # image-sequence encoder still produces a stream.
            return self.config.min_fps
        fps = max(1.0, (n - 1) / span)
        return max(self.config.min_fps, min(self.config.max_fps, round(fps, 3)))

    def build_clip(
        self,
        frames: List[StashFrame],
        out_path: str,
        audio_frames: Optional[List[StashFrame]] = None,
        ffmpeg_path: Optional[str] = None,
    ) -> str:
        """Encode a real MP4 from the stashed JPEG frames (+ optional audio).

        This is local CPU encode work over the in-memory stash — no source
        re-read, no GPU. Returns ``out_path`` on success; raises RuntimeError
        with the ffmpeg stderr on failure.
        """
        # Preserve timestamp order and write a contiguous image sequence.
        ordered = sorted(frames, key=lambda f: f.ts)
        if not ordered:
            raise RuntimeError("no frames to build clip from")
        ffmpeg = ffmpeg_path or self.config.ffmpeg_path
        fps = self.estimate_fps(ordered)
        workdir = tempfile.mkdtemp(prefix="hl-stash-")
        try:
            frame_dir = os.path.join(workdir, "frames")
            os.makedirs(frame_dir, exist_ok=True)
            for i, f in enumerate(ordered):
                with open(os.path.join(frame_dir, f"frame_{i:06d}.jpg"), "wb") as fh:
                    fh.write(f.jpeg)
            args = [
                ffmpeg, "-y", "-loglevel", "error",
                "-framerate", str(fps),
                "-i", os.path.join(frame_dir, "frame_%06d.jpg"),
                "-c:v", "libx264", "-pix_fmt", "yuv420p",
            ]
            audio_inputs: List[str] = []
            if audio_frames:
                audio_ordered = sorted(
                    (a for a in audio_frames if a.audio and a.audio_mime),
                    key=lambda f: f.ts,
                )
                if audio_ordered:
                    audio_path = self._write_audio_track(audio_ordered, workdir)
                    if audio_path:
                        audio_inputs = ["-i", audio_path]
                        args = (
                            [ffmpeg, "-y", "-loglevel", "error",
                             "-framerate", str(fps),
                             "-i", os.path.join(frame_dir, "frame_%06d.jpg")]
                            + audio_inputs
                            + ["-c:v", "libx264", "-pix_fmt", "yuv420p",
                               "-c:a", "aac", "-shortest"]
                        )
            args.append(out_path)
            proc = subprocess.run(args, capture_output=True, timeout=300)
            if proc.returncode != 0:
                raise RuntimeError(
                    f"ffmpeg clip build failed: {proc.stderr.decode(errors='replace')[-800:]}"
                )
            return out_path
        finally:
            import shutil
            shutil.rmtree(workdir, ignore_errors=True)

    def _write_audio_track(self, audio_frames: List[StashFrame], workdir: str) -> Optional[str]:
        """Write the stash audio segments into a single encoded audio file.

        Best-effort: only re-encodes when every segment shares a mime the local
        ffmpeg can decode into a container (webm/opus, mp4, aac/m4a). Returns
        the path, or None when audio cannot be muxed (clip stays video-only)."""
        mimes = {a.audio_mime for a in audio_frames if a.audio_mime}
        if len(mimes) != 1:
            return None
        mime = mimes.pop()
        ext = self._mime_ext(mime)
        if ext is None:
            return None
        raw = os.path.join(workdir, "audio" + ext)
        with open(raw, "wb") as fh:
            for a in audio_frames:
                if a.audio:
                    fh.write(a.audio)
        # Re-encode into a muxable AAC track.
        aac = os.path.join(workdir, "audio.aac")
        ffmpeg = self.config.ffmpeg_path
        proc = subprocess.run(
            [ffmpeg, "-y", "-loglevel", "error", "-i", raw, "-vn", "-c:a", "aac", "-b:a", "64k", aac],
            capture_output=True, timeout=120,
        )
        if proc.returncode != 0:
            return None
        return aac if os.path.exists(aac) else None

    @staticmethod
    def _mime_ext(mime: str) -> Optional[str]:
        m = (mime or "").lower()
        if "webm" in m or "opus" in m:
            return ".webm"
        if "mp4" in m or "aac" in m or "m4a" in m:
            return ".m4a"
        if "ogg" in m:
            return ".ogg"
        if "mp3" in m:
            return ".mp3"
        if "wav" in m or "pcm" in m:
            return ".wav"
        return None

    # --- build-or-discard ------------------------------------------------
    def build_or_discard(
        self,
        trigger_ts: float,
        is_highlight: bool,
        discarded: bool,
        out_path: str,
        upload: Optional[Callable[[str, dict], dict]] = None,
        metadata: Optional[dict] = None,
    ) -> Dict:
        """Resolve the build-or-discard decision for a verdict.

        - Confirmed (``is_highlight`` and not ``discarded``): build the clip
          from the stash pre-clip window and, when an ``upload`` callback is
          supplied, upload it. Returns ``{"action": "build_upload" | "build"}`,
          ``clipPath`` and any ``uploadResult``.
        - Discarded / not a highlight: free the stash (no clip). Returns
          ``{"action": "discard"}`` — no clip record is created anywhere.

        ``upload`` is ``fn(clip_path, metadata) -> dict``; the decide runner
        wires it to the server upload client.
        """
        meta = dict(metadata or {})
        meta.setdefault("start", max(0.0, trigger_ts - self.config.clip_before_s))
        meta.setdefault("end", trigger_ts + self.config.clip_after_s)
        if not (is_highlight and not discarded):
            self.discard()
            return {"action": "discard", "triggerTs": trigger_ts}
        video, audio, start, end = self.preclip(trigger_ts)
        if not video:
            self.discard()
            return {"action": "discard", "triggerTs": trigger_ts, "reason": "empty stash window"}
        self.build_clip(video, out_path, audio_frames=audio)
        result: Dict = {"action": "build_upload" if upload else "build",
                        "triggerTs": trigger_ts, "clipPath": out_path,
                        "start": start, "end": end}
        if upload:
            up = upload(out_path, meta)
            result["uploadResult"] = up
        # Keep the stash for the next moment? Build-or-discard semantics:
        # confirmed highlights are the rare case (<=5 flags/min), so keep the
        # ring fed by the live rail. Discard only frees on a refuted moment.
        return result

    def discard(self) -> None:
        """Free the stash (reclaim memory, no clip)."""
        self._frames.clear()

    def state(self) -> Dict:
        frames = list(self._frames)
        return {
            "frameCount": len(frames),
            "ringSeconds": self.config.ring_duration_s,
            "clipBeforeS": self.config.clip_before_s,
            "clipAfterS": self.config.clip_after_s,
            "oldestTs": frames[0].ts if frames else None,
            "newestTs": frames[-1].ts if frames else None,
        }
