/**
 * Shared "content rect" measuring for an element whose intrinsic size differs
 * from its rendered box (ADAAAA-8886 Inc 3 for the `<video>`, ADAAAA-8949 Inc 4
 * for the analyze-frame `<img>`).
 *
 * The overlay geometry itself is summed in `lib/scoreboardOverlay.ts`
 * (`contentRect`); this hook only answers "how big is the rendered box and how
 * big is the picture inside it" and re-reads it on resize and on the element's
 * own size events (`loadedmetadata`/`resize` for a video, `load` for an image).
 *
 * Client-only by construction: it runs in an effect, so react-dom/server
 * renders pass through with `null` geometry — which is exactly the "no box
 * before the content size is known" rule Inc 3 established.
 *
 * `intrinsic` and `events` are read through a ref: an inline arrow at the call
 * site would otherwise be a new identity every render and re-subscribe (and
 * re-measure) on every parent render — including the 1 s elapsed tick.
 */
import { useEffect, useRef, useState } from "react";

export interface ContentGeometry {
  /** Rendered stage box (the element's border box). */
  stageW: number;
  stageH: number;
  /** Intrinsic picture size (videoWidth/Height, naturalWidth/Height). */
  elW: number;
  elH: number;
}

export function useContentGeometry<T extends HTMLElement>(
  ref: React.RefObject<T>,
  active: boolean,
  intrinsic: (el: T) => { w: number; h: number },
  events: readonly string[] = [],
): ContentGeometry | null {
  const [geom, setGeom] = useState<ContentGeometry | null>(null);
  const last = useRef<ContentGeometry | null>(null);
  const intrinsicRef = useRef(intrinsic);
  intrinsicRef.current = intrinsic;
  const eventsKey = events.join(",");

  useEffect(() => {
    if (!active) {
      last.current = null;
      setGeom(null);
      return;
    }
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const rect = el.getBoundingClientRect();
      const { w, h } = intrinsicRef.current(el);
      const next: ContentGeometry = { stageW: rect.width, stageH: rect.height, elW: w, elH: h };
      const prev = last.current;
      if (
        prev &&
        prev.stageW === next.stageW &&
        prev.stageH === next.stageH &&
        prev.elW === next.elW &&
        prev.elH === next.elH
      ) {
        return;
      }
      last.current = next;
      setGeom(next);
    };

    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(el);
    const names = eventsKey ? eventsKey.split(",") : [];
    for (const ev of names) el.addEventListener(ev, measure);
    return () => {
      observer?.disconnect();
      for (const ev of names) el.removeEventListener(ev, measure);
    };
  }, [active, ref, eventsKey]);

  return geom;
}
