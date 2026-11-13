/**
 * ADAAAA-8949 (Inc 4): the Live Stage no-preview still's data source.
 *
 * One `GET /jobs/:id/frames` per EXISTING detail poll (the page's 5 s
 * `VOD_DETAIL_POLL_MS` read drives `pollTick`), and the JPEG itself only when
 * the newest seq changed. There is deliberately no interval in here: the still
 * must not add a timer of its own, and it must not fetch at all unless the stage
 * is `nopreview` AND the job carries a `scoreboardSurface` block (AC4.1/AC4.7).
 *
 * The frame route serves the JPEG to an Authorization header, which `<img>`
 * cannot send, so the image is auth-fetched to a blob object URL through the
 * existing `authFetchFrame` helper (the same one the frame filmstrip uses) and
 * the previous URL is revoked from the effect cleanup after the new `<img src>`
 * has committed.
 */
import { useEffect, useRef, useState } from "react";
import { api, getToken } from "./api";
import { authFetchFrame } from "./jobDetail";
import { createLiveStillSource, shouldPollStill, type LiveFrameRef, type LiveStillSource } from "./liveFrameStill";
import type { ScoreboardSurface } from "./scoreboardSurface";

export interface LiveFrameStillState {
  frame: LiveFrameRef | null;
  imgSrc: string | null;
  error: string | null;
}

const EMPTY: LiveFrameStillState = { frame: null, imgSrc: null, error: null };

export function useLiveFrameStill(
  jobId: string,
  mode: string,
  surface: ScoreboardSurface | undefined,
  pollTick: number,
): LiveFrameStillState {
  const [state, setState] = useState<LiveFrameStillState>(EMPTY);
  const sourceRef = useRef<LiveStillSource | null>(null);
  const active = shouldPollStill(mode, surface);

  if (!sourceRef.current) {
    sourceRef.current = createLiveStillSource({
      // The route answers 404 while the job has no frame directory yet (nothing
      // cropped so far). That is "no frame yet", not a failure to report.
      listFrames: async (id: string) => {
        try {
          return await api<{ frames?: unknown }>(`/jobs/${id}/frames`);
        } catch (e: unknown) {
          if ((e as { status?: number } | null)?.status === 404) return { frames: [] };
          throw e;
        }
      },
      fetchImage: (uri: string) => authFetchFrame(uri, getToken()),
    });
  }

  useEffect(() => {
    const source = sourceRef.current!;
    if (!active) {
      // Leaving the no-preview state (or losing the surface block): forget the
      // cached seq so a return re-reads the newest frame instead of a stale one.
      source.reset();
      setState(EMPTY);
      return;
    }
    let live = true;
    source
      .poll(jobId)
      .then((snap) => {
        if (!live) return;
        setState({ frame: snap.frame, imgSrc: snap.url, error: snap.error });
      })
      .catch(() => {
        /* a torn-down poll must never clobber the last honest still */
      });
    return () => {
      live = false;
    };
  }, [jobId, active, pollTick]);

  // Revoke the previous object URL after the new src has committed (or on
  // unmount) so a frame swap never blanks the visible still.
  const imgSrc = state.imgSrc;
  useEffect(() => {
    if (!imgSrc) return;
    return () => URL.revokeObjectURL(imgSrc);
  }, [imgSrc]);

  return state;
}
