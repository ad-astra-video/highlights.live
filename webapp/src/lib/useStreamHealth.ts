import { useEffect, useRef, useState } from "react";
import {
  HEALTH_SAMPLE_MS,
  bitrateFromCounters,
  foldSample,
  healthChips,
  initialHealthState,
  rateBitrate,
  rateFreshness,
  rateLink,
  rateQuality,
  parseRtcStats,
  type BitrateReading,
  type ChipView,
  type HealthState,
  type LinkInput,
  type RtcSample,
} from "./streamHealth";

// The strip's sampler (ADAAAA-7730). ONE interval, 2 s, reading
// RTCPeerConnection.getStats() plus in-memory state. No polling endpoint, no new
// network request: the values it needs are already local to the capture panel.
//
// Sources are passed as getters so the loop always reads the CURRENT refs (the
// capture panel mutates refs, not state, for mode/reconnect/observation age) and
// the interval never holds a stale closure. A tick that overlaps a slow
// getStats() is skipped rather than queued.

export interface StreamHealthSources {
  /** Start/stop sampling with the share. */
  enabled: boolean;
  /** The live RTCPeerConnection, if the share is on the RTC rail. */
  getPeer: () => RTCPeerConnection | null;
  /** The capture panel's link state machine. */
  getLink: () => LinkInput;
  /** ms since the last `observation` SSE frame (null before the first one). */
  getObservationAgeMs: () => number | null;
  /** Clips found this session + whether detection is currently running. */
  getActivity: () => { clips: number; detecting: boolean };
}

function idleChips(): ChipView[] {
  return healthChips({
    state: initialHealthState(),
    link: rateLink({ sharing: false, mode: "pending", reconnectAttempt: 0 }),
    bitrate: null,
    freshnessMs: null,
    activity: { clips: 0, detecting: false },
  });
}

export function useStreamHealth(sources: StreamHealthSources): ChipView[] {
  const srcRef = useRef<StreamHealthSources>(sources);
  srcRef.current = sources;
  const enabled = sources.enabled;
  const stateRef = useRef<HealthState>(initialHealthState());
  const prevSampleRef = useRef<{ bytes: number; atMs: number } | null>(null);
  const busyRef = useRef(false);
  const [chips, setChips] = useState<ChipView[]>(idleChips);

  useEffect(() => {
    if (!enabled) {
      // A stopped share keeps its last reading on screen but stops sampling, and
      // the byte counters are dropped so a re-share cannot compute a bitrate
      // across the gap.
      prevSampleRef.current = null;
      return;
    }
    let cancelled = false;

    const tick = async () => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        const peer = srcRef.current.getPeer();
        let sample: RtcSample | null = null;
        if (peer) {
          try {
            const atMs = Date.now();
            sample = parseRtcStats(await statsOf(peer), atMs);
          } catch {
            sample = null; // a closed peer mid-reconnect: keep the last verdict
          }
        }
        if (cancelled) return;

        const link = rateLink(srcRef.current.getLink());
        const prevBytes = prevSampleRef.current;
        let bitrate: BitrateReading | null = null;
        if (sample) {
          bitrate = bitrateFromCounters(prevBytes, sample);
          const bytes = sample.bytesSent ?? sample.bytesReceived;
          if (bytes != null) prevSampleRef.current = { bytes, atMs: sample.atMs };
        }
        const freshnessMs = srcRef.current.getObservationAgeMs();
        const next = foldSample(stateRef.current, {
          link: link.verdict,
          quality: sample ? rateQuality(sample) : "unknown",
          bitrate: bitrate ? rateBitrate(bitrate.kbps, bitrate.targetKbps) : "unknown",
          freshness: rateFreshness(freshnessMs),
        });
        stateRef.current = next;
        if (!cancelled) {
          setChips(
            healthChips({
              state: next,
              link,
              bitrate,
              freshnessMs,
              activity: srcRef.current.getActivity(),
            })
          );
        }
      } finally {
        busyRef.current = false;
      }
    };

    void tick();
    const t = setInterval(() => void tick(), HEALTH_SAMPLE_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [enabled]);

  return chips;
}

// getStats() is async on the real peer. Kept as a small named helper so the rest
// of the tick stays synchronous and the pure reducer does the deciding.
async function statsOf(peer: RTCPeerConnection): Promise<Iterable<Record<string, any>>> {
  return peer.getStats() as unknown as Iterable<Record<string, any>>;
}

export { statsOf };
