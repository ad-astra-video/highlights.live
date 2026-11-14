/**
 * ADAAAA-8949 (Inc 4) + ADAAAA-8970 (Inc 2): the Live Stage no-preview still's
 * data source and its degrade states.
 *
 * One `GET /jobs/:id/frames` per EXISTING detail poll (the page's 5 s
 * `VOD_DETAIL_POLL_MS` read drives `pollTick`), and the JPEG itself only when
 * the newest seq changed. There is deliberately no interval in here: the still
 * must not add a timer of its own, and it must not fetch at all unless the stage
 * is `nopreview` AND the job carries a `scoreboardSurface` block (AC4.1/AC4.7).
 *
 * Degrade policy (Inc 2) lives in `LiveStillSource`: this hook only forwards the
 * state it reports and resets the source when the JOB changes, so a cached seq
 * from the previous job can never be mistaken for this one's frame.
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
import {
  createLiveStillSource,
  shouldPollStill,
  type LiveFrameRef,
  type LiveStillRefusal,
  type LiveStillSource,
  type LiveStillStateKind,
} from "./liveFrameStill";
import type { ScoreboardSurface } from "./scoreboardSurface";

export interface LiveFrameStillState {
  state: LiveStillStateKind;
  frame: LiveFrameRef | null;
  imgSrc: string | null;
  error: string | null;
  refusal: LiveStillRefusal;
}

const EMPTY: LiveFrameStillState = { state: "waiting", frame: null, imgSrc: null, error: null, refusal: null };

export function useLiveFrameStill(
  jobId: string,
  mode: string,
  surface: ScoreboardSurface | undefined,
  pollTick: number,
): LiveFrameStillState {
  const [state, setState] = useState<LiveFrameStillState>(EMPTY);
  const sourceRef = useRef<LiveStillSource | null>(null);
  const jobRef = useRef(jobId);
  const active = shouldPollStill(mode, surface);

  if (!sourceRef.current) {
    sourceRef.current = createLiveStillSource({
      // The route answers 404 while the job has no frame directory yet (nothing
      // cropped so far). That is "no frame yet", not a failure to report.
      // ADAAAA-8973: `sinceSeq` is the source's incremental cursor (undefined on
      // the first poll). The server then serves only the newer rows, so a
      // caught-up poll transfers ~0 bytes instead of the whole frame list.
      listFrames: async (id: string, sinceSeq?: number) => {
        try {
          const qs = sinceSeq === undefined ? "" : `?sinceSeq=${encodeURIComponent(String(sinceSeq))}`;
          return await api<{ frames?: unknown }>(`/jobs/${id}/frames${qs}`);
        } catch (e: unknown) {
          if ((e as { status?: number } | null)?.status === 404) return { frames: [] };
          throw e;
        }
      },
      // The frame route's 401/403 must be distinguishable from a transport
      // failure: `authFetchFrame` only carries the status inside its message.
      fetchImage: (uri: string) => authFetchFrame(uri, getToken()),
    });
  }

  // Unmount: revoke the still nobody will render. A poll that lands after this
  // drops its own object URL at the source (generation guard, ADAAAA-8962).
  useEffect(() => {
    const source = sourceRef.current!;
    return () => source.dispose();
  }, []);

  useEffect(() => {
    const source = sourceRef.current!;
    // A different job on the same page: drop the previous job's seq/URL/refusal.
    if (jobRef.current !== jobId) {
      jobRef.current = jobId;
      source.reset();
    }
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
        if (!live) {
          // The stage left no-preview, or the page unmounted, while this fetch
          // was in flight: nobody will render this URL, so release it here.
          revoke(snap.url);
          return;
        }
        setState({
          state: snap.state,
          frame: snap.frame,
          imgSrc: snap.url,
          error: snap.error,
          refusal: snap.refusal,
        });
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
    return () => revoke(imgSrc);
  }, [imgSrc]);

  return state;
}

/** Node has no `URL.revokeObjectURL`; guard so a server render is a no-op. */
function revoke(url: string | null): void {
  if (!url) return;
  if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
}
