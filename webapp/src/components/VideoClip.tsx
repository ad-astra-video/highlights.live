import { useEffect, useRef, useState } from "react";

/**
 * useInView
 * --------
 * Reports once when the bound element scrolls near the viewport. Used to defer
 * <video> mounting (and therefore the network request for its metadata) until
 * the clip is actually approachable — the central pattern for avoiding N
 * simultaneous video downloads on a clips/_cover_ feed/grid.
 */
function useInView<T extends HTMLElement>(rootMargin = "240px"): [React.MutableRefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true); // old/simple environment: just render
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          io.disconnect();
        }
      },
      { rootMargin }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [rootMargin]);
  return [ref, inView];
}

interface VideoClipProps {
  src: string;
  /** Short human label, used for an accessible description of the clip. */
  label?: string;
  poster?: string;
  /** Defer mounting the <video> until it nears the viewport (default true). */
  lazy?: boolean;
  /** Aspect box (Tailwind class) the player fills. */
  aspectClass?: string;
  /** When set, the server could not produce this clip (missing/incomplete
   *  recording or a cut failure); render a failure state instead of an empty
   *  player so the card is never silently blank (ADAAAA-6522). */
  error?: string;
  /** ADAAAA-8032: epoch ms when this clip was expected (the highlight's
   *  `createdAt`). While `src` is empty the wait state then NAMES its progress
   *  ("cutting clip… 12s") instead of showing an indefinite placeholder — the
   *  share's clip is cut mid-session, so a card must never sit on a bare
   *  "clip processing…" for the whole share. */
  waitingSinceMs?: number;
}

/**
 * The bounded wait state for a highlight whose clip is being cut. `waitingSinceMs`
 * missing (a legacy row) keeps the old placeholder; with it, the elapsed seconds
 * are always shown and the copy changes once the wait stops looking normal.
 */
function ClipWaitState({ waitingSinceMs }: { waitingSinceMs?: number }) {
  const [now, setNow] = useState(() => Date.now());
  const waiting = Number.isFinite(waitingSinceMs);
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [waiting]);
  const secs = waiting ? Math.max(0, Math.floor((now - (waitingSinceMs as number)) / 1000)) : null;
  if (secs === null) {
    return <div className="absolute inset-0 grid place-items-center text-xs text-mut">clip processing…</div>;
  }
  return (
    <div className="absolute inset-0 grid place-items-center px-3 text-center">
      <div>
        <div className="text-xs text-mut">{secs < 30 ? `cutting clip… ${secs}s` : `still cutting… ${secs}s`}</div>
        {secs >= 30 ? (
          <div className="mt-1 text-xs text-mut">clip finishes when the share stops</div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * VideoClip
 * ---------
 * The single place the app configures <video> playback. Modern-video defaults:
 *   - `preload="metadata"` so we never pull the whole file just to show a card
 *   - lazy mount via IntersectionObserver (see useInView)
 *   - `playsInline` + fills its aspect box (no layout jump while loading)
 *   - accessible label via aria-label
 * Feed this the same clipUri used everywhere; playback config stays in one spot.
 */
export function VideoClip({ src, label, poster, lazy = true, aspectClass = "aspect-video", error, waitingSinceMs }: VideoClipProps) {
  const [ref, inView] = useInView<HTMLDivElement>("240px");
  const mounted = !lazy || inView;
  return (
    <div ref={ref} className={`relative w-full ${aspectClass} bg-black`}>
      {error ? (
        <div className="absolute inset-0 grid place-items-center px-3 text-center">
          <div>
            <div className="text-sm font-bold text-red">Clip unavailable</div>
            <div className="mt-1 text-xs text-mut">{error}</div>
          </div>
        </div>
      ) : !src ? (
        // A highlight with no clip yet: the share's clip is cut as soon as its
        // window is flushed, so the card names its progress instead of showing
        // an indefinite placeholder (ADAAAA-8032).
        <ClipWaitState waitingSinceMs={waitingSinceMs} />
      ) : mounted ? (
        <video
          src={src}
          poster={poster}
          controls
          playsInline
          preload="metadata"
          className="absolute inset-0 h-full w-full"
          aria-label={label ? `Video clip: ${label}` : "Video clip"}
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center text-xs text-mut">clip loading…</div>
      )}
    </div>
  );
}
