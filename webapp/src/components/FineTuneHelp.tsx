// In-UI fine-tune help sidebar + walkthrough (ADAAAA-5327).
//
// Content is the PO-authored copy from ADAAAA-5321 ("Fine-tune Florence-2 for
// better highlights detection — help content"), integrated per-page. Both the
// Dataset Curation page and the Train page render this via a help [?] control
// (a floating button) that opens a slide-over sidebar.
//
// [LINK] anchors from the doc are wired to the real controls:
//   - Dataset page: #extract (section 1 ingest), #seed (section 2 auto-seed),
//     #coverage (section 4), #export (section 5)
//   - Train page:   #train-manifest + #start-train
//   - Cross-page links navigate to the other page's hash (each page scrolls to
//     its hash on mount) so the walkthrough spans both pages.
//
// Token-only styling: uses .card / .btn-neon / .btn-ghost and the Tailwind
// theme tokens from index.css (text-neon, text-mut, text-slate-ink, bg-dusk,
// border-white/10, etc.). No hex / raw px / arbitrary values.
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { HelpCircle, X, BookOpen } from "lucide-react";

export type HelpPage = "dataset" | "train";

/** The manifest example from the PO doc (matches DetectionTrainingSample JSON). */
export const MANIFEST_EXAMPLE = `[
  {
    "image": "/srv/frames/sample_a.png",
    "labels": [
      { "label": "player", "bbox": [0.10, 0.10, 0.46, 0.32] },
      { "label": "soccer ball", "bbox": [0.52, 0.40, 0.62, 0.50] }
    ]
  },
  {
    "image": "/srv/frames/sample_b.png",
    "labels": [
      { "label": "goalkeeper", "bbox": [0.20, 0.20, 0.70, 0.55] },
      { "label": "goal", "bbox": [0.05, 0.30, 0.30, 0.90] }
    ]
  }
]`;

const SOCCER_LABELS = ["player", "soccer ball", "goalkeeper", "goal", "referee"];

/** Same-page scroll target or a cross-page route+hash. */
type Anchor =
  | { kind: "scroll"; id: string }
  | { kind: "go"; route: string };

interface WalkthroughStep {
  n: number;
  title: string;
  body: string;
  /** A link inside the body pointing at a real control. */
  link?: { label: string; anchor: Anchor };
}

export function FineTuneHelp({ page }: { page: HelpPage }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  // Cross-page links carry a hash; scroll to the target once the page mounts
  // (and again whenever the hash changes, e.g. arriving from the other page).
  useEffect(() => {
    const id = location.hash.replace("#", "");
    if (id) {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.hash, open]);

  function go(anchor: Anchor) {
    setOpen(false);
    if (anchor.kind === "scroll") {
      const el = document.getElementById(anchor.id);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      navigate(anchor.route);
    }
  }

  // Steps describe the whole flow; per-page some anchors are same-page, others
  // cross-page (which navigate to the other page once their hash is present).
  const datasetRoute = "/app/dataset";
  const trainRoute = "/app/train";

  const steps: WalkthroughStep[] = [
    {
      n: 1,
      title: "Prepare a source clip",
      body: "Fine-tuning runs on frames extracted from a video clip (a VOD source URL or an existing clip). Use footage that looks like your production stream: game + broadcast. A few minutes of representative clip is enough to start.",
    },
    {
      n: 2,
      title: "Extract frames",
      body: "Paste the source and extract frames at ~1 fps on the Dataset Curation page. The page buckets near-duplicate frames so you do not annotate the same scene twice.",
      link: {
        label: "Go to Extract frames",
        anchor:
          page === "dataset"
            ? { kind: "scroll", id: "extract" }
            : { kind: "go", route: `${datasetRoute}#extract` },
      },
    },
    {
      n: 3,
      title: "Annotate boxes on each frame",
      body: "For each frame, draw a tight box around every object you can see and assign one of the 5 labels. Use the Auto-seed button to start from the base detector's boxes, then fix what it got wrong rather than annotating from scratch.",
      link: {
        label: page === "dataset" ? "Go to Auto-seed" : "Auto-seed lives on Dataset Curation",
        anchor:
          page === "dataset"
            ? { kind: "scroll", id: "seed" }
            : { kind: "go", route: `${datasetRoute}#seed` },
      },
    },
    {
      n: 4,
      title: "Cover every label",
      body: "Watch the coverage summary. Aim to label every class that appears in your stream. A class with near-zero examples will not improve — balanced classes matter more than raw volume.",
      link: {
        label: page === "dataset" ? "View coverage summary" : "Coverage summary lives on Dataset Curation",
        anchor:
          page === "dataset"
            ? { kind: "scroll", id: "coverage" }
            : { kind: "go", route: `${datasetRoute}#coverage` },
      },
    },
    {
      n: 5,
      title: "Accept frames and export train/val manifests",
      body: "Only accept frames you are confident about. Export; the page writes a train_manifest.jsonl and val_manifest.jsonl (a held-out validation split the eval will measure against — do not contaminate it).",
      link: {
        label: page === "dataset" ? "Go to Export" : "Export lives on Dataset Curation",
        anchor:
          page === "dataset"
            ? { kind: "scroll", id: "export" }
            : { kind: "go", route: `${datasetRoute}#export` },
      },
    },
    {
      n: 6,
      title: "Train",
      body: "Paste the manifest (or use the curated one), pick epochs, and press Start fine-tune. When the run finishes, compare precision / recall / f1 against the pre-training baseline. If recall is high but precision low, your boxes were loose or you over-annotated; if precision is high but recall low, add coverage / more varied frames.",
      link: {
        label: page === "train" ? "Go to manifest + Start fine-tune" : "Training lives on the Fine-tune page",
        anchor:
          page === "train"
            ? { kind: "scroll", id: "train-manifest" }
            : { kind: "go", route: `${trainRoute}#train-manifest` },
      },
    },
  ];

  return (
    <>
      {/* Floating help [?] control */}
      <button
        aria-label="Fine-tune help"
        onClick={() => setOpen(true)}
        className="btn-neon btn-ghost flex items-center gap-1.5 px-3 py-1.5 text-xs"
      >
        <HelpCircle className="h-4 w-4" /> <span>?</span>
      </button>

      {/* Slide-over sidebar */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/50"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}
      <aside
        className={`fixed right-0 top-0 z-50 flex h-full w-[420px] max-w-[92vw] flex-col border-l border-purple/30 bg-dusk transition-transform ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
        aria-hidden={!open}
      >
        <div className="flex items-center justify-between border-b border-white/10 p-5">
          <div className="flex items-center gap-2">
            <BookOpen className="h-5 w-5 text-neon" />
            <h2 className="text-lg font-extrabold text-ink">Fine-tune help</h2>
          </div>
          <button
            aria-label="Close help"
            onClick={() => setOpen(false)}
            className="btn-neon btn-ghost p-1.5"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {/* Why tune? */}
          <section className="card card-accent mb-5 p-4">
            <h3 className="mb-2 text-sm font-bold text-neon">Why tune?</h3>
            <p className="text-xs leading-relaxed text-slate-ink">
              Florence-2-base is a general Microsoft model. On soccer it already detects
              <span className="text-ink"> player / soccer ball / goalkeeper / goal / referee</span>,
              but it misses frames where the base model is weak and can silence low-confidence
              detections. Fine-tuning trains a small <span className="text-ink">LoRA adapter</span>{" "}
              on <span className="text-ink">your</span> annotated frames. LoRA is cheap and fast by
              design: it tunes a tiny fraction of parameters on top of the frozen base, so you get
              domain lift from a fraction of the data and GPU time of a full fine-tune. One LoRA pass
              runs on a Livepeer GPU job.
            </p>
          </section>

          {/* Walkthrough */}
          <section className="mb-6">
            <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-mut">
              The fast path — 6 steps
            </h3>
            <ol className="flex flex-col gap-4">
              {steps.map((s) => (
                <li key={s.n} className="flex gap-3">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-neon/50 bg-neon/10 text-xs font-bold text-neon">
                    {s.n}
                  </span>
                  <div className="text-xs leading-relaxed text-slate-ink">
                    <span className="font-semibold text-ink">{s.title}.</span> {s.body}
                    {s.link && (
                      <button
                        onClick={() => go(s.link!.anchor)}
                        className="mt-1 block font-semibold text-neon underline-offset-2 hover:underline"
                      >
                        ↳ {s.link.label}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </section>

          {/* Label & data quality */}
          <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-mut">
            Label &amp; data quality
          </h3>

          <section className="card mb-4 p-4">
            <h4 className="mb-2 text-sm font-bold text-ink">What a good box looks like</h4>
            <ul className="flex flex-col gap-2 text-xs leading-relaxed text-slate-ink">
              <li>
                <span className="font-semibold text-green">Good:</span> the box hugs the object's
                edges — one object per box, one label per box. A <span className="text-green">soccer ball</span>{" "}
                box contains the ball and nothing else.
              </li>
              <li>
                <span className="font-semibold text-pink">Bad — too loose:</span> box spans the
                player plus background; trains the model to fire on empty space around the object
                (lowers precision).
              </li>
              <li>
                <span className="font-semibold text-pink">Bad — also covered:</span> box halves the
                object (ball cut in half), the model learns to catch fragments.
              </li>
            </ul>
            <p className="mt-2 text-xs text-mut">
              Rule of thumb: annotate the way you want the detector to fire — tight, complete,
              consistent.
            </p>
          </section>

          <section className="card mb-4 p-4">
            <h4 className="mb-2 text-sm font-bold text-ink">Label consistency</h4>
            <ul className="flex flex-col gap-2 text-xs leading-relaxed text-slate-ink">
              <li>
                Always use the exact 5 label strings; do not invent variants.{" "}
                <span className="text-mut">player</span>, <span className="text-mut">Player</span>,{" "}
                <span className="text-mut">players</span> are three different classes to the trainer.
              </li>
              <li>
                If a frame is ambiguous (a defender you cannot tell from a midfielder), still pick{" "}
                <span className="text-ink">player</span>; consistency beats per-frame perfection.
              </li>
            </ul>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {SOCCER_LABELS.map((l) => (
                <span key={l} className="rounded-lg border border-white/10 px-2 py-1 text-[10px] text-slate-ink">
                  {l}
                </span>
              ))}
            </div>
          </section>

          <section className="card mb-4 p-4">
            <h4 className="mb-2 text-sm font-bold text-ink">Volume &amp; balance guidance</h4>
            <ul className="flex flex-col gap-2 text-xs leading-relaxed text-slate-ink">
              <li>
                <span className="font-semibold text-ink">Minimum to see lift:</span> ~150–300 accepted
                frames with a few hundred boxes.
              </li>
              <li>
                <span className="font-semibold text-ink">Balance:</span> if soccer ball rarely appears
                in your clip, source a clip where it does; one class at 2% of boxes will not learn.
              </li>
              <li>
                <span className="font-semibold text-ink">Validation:</span> keep 10–20% of frames in
                the val split and never annotate the val split using detector output you will later
                score against the same frames.
              </li>
            </ul>
            <p className="mt-2 text-xs text-mut">Heuristic guidance, not a hard gate.</p>
          </section>

          <section className="card mb-4 p-4">
            <h4 className="mb-2 text-sm font-bold text-ink">Example manifest</h4>
            <p className="mb-2 text-xs text-slate-ink">
              What the Train page expects. <span className="text-mut">bbox</span> is normalized{" "}
              <span className="text-mut">[x1, y1, x2, y2]</span> in <span className="text-mut">[0,1]</span>{" "}
              image coordinates. The Dataset Curation page exports this format automatically — you
              rarely edit it by hand.
            </p>
            <pre className="overflow-x-auto rounded-lg border border-white/10 bg-void p-3 font-mono text-[10px] leading-relaxed text-neon">
              {MANIFEST_EXAMPLE}
            </pre>
          </section>

          <section className="card mb-4 p-4">
            <h4 className="mb-2 text-sm font-bold text-ink">Epochs guidance</h4>
            <ul className="flex flex-col gap-2 text-xs leading-relaxed text-slate-ink">
              <li>
                Start with <span className="text-ink">5 epochs</span> (page default). Watch the val
                eval delta.
              </li>
              <li>
                If val precision/recall stop improving (or a class gets worse), do not add more epochs
                — you are overfitting. Add data or re-check box quality instead.
              </li>
            </ul>
          </section>
        </div>
      </aside>
    </>
  );
}
