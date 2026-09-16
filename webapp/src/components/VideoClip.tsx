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
export function VideoClip({ src, label, poster, lazy = true, aspectClass = "aspect-video" }: VideoClipProps) {
  const [ref, inView] = useInView<HTMLDivElement>("240px");
  const mounted = !lazy || inView;
  return (
    <div ref={ref} className={`relative w-full ${aspectClass} bg-black`}>
      {mounted ? (
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
