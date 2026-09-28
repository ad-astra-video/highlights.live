// Florence-2 fine-tune Dataset Curation page (ADAAAA-5164, data path).
//
// Workflow: ingest a VOD clip (source URL/path) and extract 1 fps frames via
// POST /training/extract; the operator reviews each frame on a canvas, draws /
// moves / deletes boxes, assigns a class from the closed 5-label soccer vocab,
// optionally auto-seeds from the base detector's raw output, accepts the frame,
// tracks class coverage vs. the V1 targets, then exports Zod-validated
// train/val JSONL manifests via POST /training/manifests (server writes
// evals/train_manifest.jsonl + evals/val_manifest.jsonl).
//
// Mirrors the Dashboard / FrameDebugger / BrowserCapture styling + auth-fetch
// patterns. No training GPU is scheduled on this leg.
//
// ADAAAA-5395 (C2): the curated work-in-progress is auto-persisted to browser
// storage (localStorage) so the user can START / STOP / RESUME without losing
// state — reload restores frames + boxes + labels exactly. "Send dataset"
// produces the Zod-validated train/val manifests (existing export pipeline)
// and commits them to the server persistence path.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getToken, api, downloadDatasetZip } from "../lib/api";
import {
  SOCCER_TRAINING_LABELS,
  type TrainingLabel,
} from "@highlights/events";
import {
  autoSeedBoxes,
  coverageSummary,
  exportManifests,
  phashFromImageData,
  type CurationBox,
  type CurationFrame,
} from "../lib/dataset";
import {
  buildSession,
  clearSession,
  framesFromSession,
  loadSession,
  saveSession,
  type DatasetSessionState,
} from "../lib/datasetSession";
import { FineTuneHelp } from "../components/FineTuneHelp";


const PALETTE: Record<string, string> = {
  player: "#22d3ee",
  "soccer ball": "#a3e635",
  goalkeeper: "#f472b6",
  goal: "#fbbf24",
  referee: "#a78bfa",
};

interface ExtractedMeta {
  id: string;
  imageRef: string;
  seq: number;
  width: number;
  height: number;
  source: string;
}

// Saved-dataset archive contract (ADAAAA-5396, Change 3): the server persists
// every sent dataset in its DB and exposes it via GET /datasets (list) and
// GET /datasets/:id (detail), gated to an account that is active on a paid
// (non-starter) plan. The list carries a lightweight summary; the detail
// returns the full train/val manifests so a previously-sent dataset can be
// re-materialized in the curation UI after a reload or a new session.
interface SavedDatasetSummary {
  id: string;
  name: string | null;
  ownerId: string;
  trainCount: number;
  valCount: number;
  imageRefs: string[];
  status: string;
  createdAt: string;
}
interface SavedDatasetDetail {
  id: string;
  ownerId: string;
  name?: string;
  train: Array<{ id: string; imageRef: string; width: number; height: number; objects: Array<{ label: string; bbox: [number, number, number, number] }> }>;
  val: Array<{ id: string; imageRef: string; width: number; height: number; objects: Array<{ label: string; bbox: [number, number, number, number] }> }>;
  imageRefs: string[];
  trainCount: number;
  valCount: number;
  status: string;
  createdAt: string;
}

const CANVAS_W = 960;

/** Auth'd fetch of a frame to an object URL (same pattern as FrameDebugger). */
async function frameObjectURL(path: string): Promise<string> {
  const t = getToken();
  const r = await fetch(path, { headers: t ? { authorization: "Bearer " + t } : {} });
  if (!r.ok) throw new Error(`frame fetch HTTP ${r.status}`);
  return URL.createObjectURL(await r.blob());
}

let seqId = 0;
function boxId(): string {
  return `box-${++seqId}`;
}

export function Dataset() {
  const [source, setSource] = useState("");
  const [inSec, setInSec] = useState("0");
  const [outSec, setOutSec] = useState("");
  const [fps, setFps] = useState("1");
  const [extracting, setExtracting] = useState(false);
  const [frames, setFrames] = useState<CurationFrame[]>([]);
  const [selIdx, setSelIdx] = useState<number | null>(null);
  const [selBox, setSelBox] = useState<string | null>(null);
  const [label, setLabel] = useState<TrainingLabel>("player");
  const [seedJson, setSeedJson] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // C2: a previous session found in browser storage on mount. Shown as a
  // Resume/Start-new prompt until the user chooses. null = never checked or no
  // saved session.
  const [pendingResume, setPendingResume] = useState<DatasetSessionState | null | undefined>(undefined);
  // Saved-dataset archive (ADAAAA-5396 C3): list of the user's persisted,
  // sent datasets (loaded from GET /datasets). null = not yet fetched.
  const [saved, setSaved] = useState<SavedDatasetSummary[] | null>(null);
  const [archiveMsg, setArchiveMsg] = useState<string | null>(null);
  const [archiveDenied, setArchiveDenied] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgUrlRef = useRef<{ _frameId: string; url: string } | null>(null);
  const createdUrls = useRef<Set<string>>(new Set());
  const aliveRef = useRef(true);
  const drag = useRef<{ ref: CurationFrame; mode: "draw" | "move" | "resize"; corner?: string; startCanvasX: number; startCanvasY: number; startBox?: CurationBox } | null>(null);

  const cur = selIdx != null ? frames[selIdx] : null;

  // --- frame extraction ---------------------------------------------------
  async function doExtract() {
    if (!source.trim()) return;
    setErr(null);
    setExtracting(true);
    setFrames([]);
    setSelIdx(null);
    setSelBox(null);
    for (const u of createdUrls.current) URL.revokeObjectURL(u);
    createdUrls.current.clear();
    const body: Record<string, unknown> = { source: source.trim() };
    const fpsNum = parseFloat(fps);
    if (Number.isFinite(fpsNum) && fpsNum > 0) body.fps = fpsNum;
    const inNum = parseFloat(inSec);
    if (Number.isFinite(inNum) && inNum >= 0) body.inSec = inNum;
    const outNum = parseFloat(outSec);
    if (Number.isFinite(outNum) && outNum > (Number.isFinite(inNum) ? inNum : -1)) body.outSec = outNum;
    try {
      const r = await api<{ frames: ExtractedMeta[] }>("/training/extract", { body });
      const mapped: CurationFrame[] = r.frames.map((f) => ({
        id: f.id,
        imageRef: f.imageRef,
        width: f.width,
        height: f.height,
        uri: `/training/frames/${f.imageRef}`,
        phash: "",
        sourceSeq: f.seq,
        accepted: false,
        boxes: [],
      }));
      setFrames(mapped);
      setSelIdx(mapped.length ? 0 : null);
      setExportMsg(`Extracted ${mapped.length} frame(s). Review each, then export.`);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setExtracting(false);
    }
  }

  // --- load + draw the selected frame --------------------------------------
  const drawFrame = useCallback((frame: CurationFrame | null, boxSel: string | null) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!frame) {
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    if (!ctx) return;
    const H = Math.round((CANVAS_W * frame.height) / frame.width);
    canvas.width = CANVAS_W;
    canvas.height = H;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const img = (canvas as any)._img as HTMLImageElement | undefined;
    if (img && img.complete && img.naturalWidth > 0) {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      for (const b of frame.boxes) drawBox(ctx, b, b.id === boxSel, frame.width, frame.height);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (imgUrlRef.current) URL.revokeObjectURL(imgUrlRef.current.url);
      for (const u of createdUrls.current) URL.revokeObjectURL(u);
    };
  }, []);

  // C2 — restore-on-mount: if a curated session is persisted in browser
  // storage, surface it as a Resume prompt (don't clobber the editor). The
  // user picks Resume (hydrate) or Start new (clear + fresh).
  useEffect(() => {
    const saved = loadSession();
    setPendingResume(saved);
  }, []);

  // C2 — auto-persist the full curation session (debounced) on every change
  // so reload / Stop always restores exactly what the user had. Skipped while
  // a Resume prompt is pending (we don't want to overwrite storage with a
  // half-hydrated empty editor before the user has chosen), and skipped when
  // there is no curation work yet so a bare visit never leaves a spurious
  // "0 frames" saved-session behind.
  useEffect(() => {
    if (pendingResume === undefined || pendingResume !== null) return;
    if (frames.length === 0) return;
    const t = setTimeout(() => {
      saveSession(
        buildSession({
          ingest: { source, inSec, outSec, fps },
          frames,
          selIdx,
          selBox,
          label,
          seedJson,
        })
      );
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingResume, source, inSec, outSec, fps, frames, selIdx, selBox, label, seedJson]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!cur) {
      drawFrame(null, null);
      return;
    }
    // Frame pixels already on the canvas for this frame (e.g. box edits)? Just
    // redraw with the current boxes/selection.
    const existing = (canvas as any)._img as (HTMLImageElement & { _frameId?: string }) | null;
    if (existing && existing._frameId === cur.id && existing.complete && existing.naturalWidth > 0) {
      drawFrame(cur, selBox);
      return;
    }
    let cancelled = false;
    (async () => {
      let url: string;
      try {
        url = await frameObjectURL(cur.uri || "");
      } catch (e: any) {
        if (!cancelled) setErr("failed to load frame: " + String(e?.message || e));
        return;
      }
      if (cancelled) {
        URL.revokeObjectURL(url);
        return;
      }
      // Frames are served behind the Bearer auth header (like the Frame
      // Debugger), so we fetch to a blob and hand <img> an object URL.
      if (imgUrlRef.current && imgUrlRef.current._frameId !== cur.id) {
        URL.revokeObjectURL(imgUrlRef.current.url);
        imgUrlRef.current = null;
      }
      const img = new Image();
      (img as any)._frameId = cur.id;
      (canvas as any)._img = img;
      imgUrlRef.current = { _frameId: cur.id, url };
      img.onload = () => {
        if (cancelled) return;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          const H = Math.round((CANVAS_W * cur.height) / cur.width);
          canvas.width = CANVAS_W;
          canvas.height = H;
          ctx.drawImage(img, 0, 0, CANVAS_W, H);
          // perceptual hash for near-dup-aware 85/15 split at export time
          let data: Uint8ClampedArray = new Uint8ClampedArray([0]);
          try {
            data = ctx.getImageData(0, 0, CANVAS_W, H).data;
          } catch {
            // tainted canvas: skip hashing, split falls back to per-frame ratio
          }
          const ph = phashFromImageData(data, CANVAS_W, H);
          if (cur.phash !== ph) {
            setFrames((fs) => fs.map((f) => (f.id === cur.id ? { ...f, phash: ph } : f)));
          }
        }
        drawFrame(cur, selBox);
      };
      img.src = url;
    })();
    return () => {
      cancelled = true;
    };
  }, [cur, selBox]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- box editing ----------------------------------------------------------
  function updateFrame(idx: number, fn: (f: CurationFrame) => CurationFrame) {
    setFrames((fs) => fs.map((f, i) => (i === idx ? fn(f) : f)));
  }

  function canvasXY(e: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number } {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
    return { x, y };
  }

  function onMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!cur) return;
    const { x, y } = canvasXY(e);
    const nx = x / canvasRef.current!.width;
    const ny = y / canvasRef.current!.height;
    // resize handle? (selected box corners)
    if (selBox) {
      const b = cur.boxes.find((bb) => bb.id === selBox);
      if (b) {
        const corner = hitCorner(b, nx, ny);
        if (corner) {
          drag.current = { ref: cur, mode: "resize", corner, startCanvasX: x, startCanvasY: y, startBox: { ...b } };
          return;
        }
      }
    }
    // inside an existing box -> move
    const hit = cur.boxes.find((bb) => inside(nx, ny, bb.bbox));
    if (hit) {
      setSelBox(hit.id);
      drag.current = { ref: cur, mode: "move", startCanvasX: x, startCanvasY: y, startBox: { ...hit } };
      return;
    }
    // empty -> draw a new box with the current label
    setSelBox(null);
    const nb: CurationBox = { id: boxId(), label, bbox: [nx, ny, nx, ny] };
    updateFrame(selIdx!, (f) => ({ ...f, boxes: [...f.boxes, nb] }));
    drag.current = { ref: cur, mode: "draw", startCanvasX: x, startCanvasY: y, startBox: { ...nb } };
  }

  function onMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const d = drag.current;
    if (!d || selIdx == null) return;
    const { x, y } = canvasXY(e);
    const canvas = canvasRef.current!;
    const nx = Math.min(1, Math.max(0, x / canvas.width));
    const ny = Math.min(1, Math.max(0, y / canvas.height));
    updateFrame(selIdx, (f) => {
      const boxes = f.boxes.map((b) => {
        if (!d.startBox || b.id !== d.startBox.id) return b;
        const sb = d.startBox.bbox;
        if (d.mode === "draw") return { ...b, bbox: [clamp01(Math.min(sb[0], nx)), clamp01(Math.min(sb[1], ny)), clamp01(Math.max(sb[0], nx)), clamp01(Math.max(sb[1], ny))] as [number, number, number, number] };
        if (d.mode === "move") {
          const dx = nx - sb[0];
          const dy = ny - sb[1];
          return { ...b, bbox: moveBox(sb, dx, dy) };
        }
        // resize
        const corner = d.corner!;
        let [x1, y1, x2, y2] = sb;
        if (corner.includes("w")) x1 = Math.min(nx, x2 - 0.02);
        if (corner.includes("e")) x2 = Math.max(nx, x1 + 0.02);
        if (corner.includes("n")) y1 = Math.min(ny, y2 - 0.02);
        if (corner.includes("s")) y2 = Math.max(ny, y1 + 0.02);
        return { ...b, bbox: normalizeBox([clamp01(x1), clamp01(y1), clamp01(x2), clamp01(y2)]) };
      });
      return { ...f, boxes };
    });
  }

  function onMouseUp() {
    drag.current = null;
  }

  function deleteSelected() {
    if (selBox == null || selIdx == null) return;
    updateFrame(selIdx, (f) => ({ ...f, boxes: f.boxes.filter((b) => b.id !== selBox) }));
    setSelBox(null);
  }

  function changeLabelOf(boxIdSel: string, l: TrainingLabel) {
    if (selIdx == null) return;
    updateFrame(selIdx, (f) => ({ ...f, boxes: f.boxes.map((b) => (b.id === boxIdSel ? { ...b, label: l } : b)) }));
  }

  function seedCurrent() {
    if (selIdx == null) return;
    let raw: Array<{ label: string; bbox: [number, number, number, number] }> = [];
    try {
      raw = JSON.parse(seedJson || "[]");
    } catch {
      setErr("Seed JSON is not valid JSON — expected an array of { label, bbox:[x1,y1,x2,y2] }.");
      return;
    }
    const seeded = autoSeedBoxes(raw);
    if (!seeded.length) {
      setErr("No in-vocabulary boxes seeded (voices outside the closed soccer vocab are dropped).");
    } else {
      setErr(null);
    }
    updateFrame(selIdx, (f) => ({ ...f, boxes: f.boxes.concat(seeded.map((s) => ({ ...s, id: boxId() }))) }));
  }

  // --- export ----------------------------------------------------------------
  const exportOut = useMemo(() => (frames.length ? exportManifests(frames) : null), [frames]);
  const coverage = useMemo(() => coverageSummary(frames.filter((f) => f.accepted).map((f) => ({ objects: f.boxes }))), [frames]);

  function download(name: string, text: string) {
    const blob = new Blob([text], { type: "application/x-ndjson" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function saveManifests() {
    if (!exportOut || !exportOut.valid) return;
    setSaving(true);
    setErr(null);
    setExportMsg(null);
    try {
      const res = await api<{ ok: boolean; trainPath?: string; valPath?: string; trainCount: number; valCount: number; invalidCount: number; errors?: string[] }>(
        "/training/manifests",
        { body: { train: exportOut.train, val: exportOut.val } }
      );
      // C2 — a successful send commits the curated set to the server
      // persistence path, so the local WIP no longer needs to be resumed.
      // Clear it so a later reload starts fresh instead of resurrecting a
      // now-committed session.
      clearSession();
      setPendingResume(undefined);
      setExportMsg(
        `Sent to server: ${res.trainPath} (${res.trainCount}) + ${res.valPath} (${res.valCount}). ` +
        `Manifest shape matches track_label_manifest.json (objects carry normalized [x1,y1,x2,y2] bbox + label). Local WIP cleared.`
      );
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setSaving(false);
    }
    refreshArchive();
  }

  // --- C2: start / stop / resume ------------------------------------------
  const isResuming = pendingResume !== undefined && pendingResume !== null;
  const hasWork = frames.length > 0;

  /** Stop: persist current progress (reload-safe) and leave the editor intact.
   * The saved session is what a later Resume rehydrates. */
  function handleStop() {
    saveSession(
      buildSession({ ingest: { source, inSec, outSec, fps }, frames, selIdx, selBox, label, seedJson })
    );
    setExportMsg("Progress saved to your browser — reload or come back later and Resume.");
  }

  /** Resume: hydrate the persisted session back into the editor exactly. */
  function handleResume(s: DatasetSessionState) {
    setSource(s.ingest.source);
    setInSec(s.ingest.inSec);
    setOutSec(s.ingest.outSec);
    setFps(s.ingest.fps);
    setSeedJson(s.seedJson);
    setFrames(framesFromSession(s));
    setSelIdx(s.selIdx != null && s.selIdx < s.frames.length ? s.selIdx : s.frames.length ? 0 : null);
    setSelBox(s.selBox);
    setLabel(s.label as TrainingLabel);
    setPendingResume(null);
    setErr(null);
    setExportMsg(`Resumed ${s.frames.length} frame(s) — ${s.frames.filter((f) => f.accepted).length} accepted.`);
  }

  /** Start new: clear any saved session and reset the editor to a blank one. */
  function handleStartNew() {
    clearSession();
    setPendingResume(null);
    setSource("");
    setInSec("0");
    setOutSec("");
    setFps("1");
    setFrames([]);
    setSelIdx(null);
    setSelBox(null);
    setSeedJson("");
    setErr(null);
    setExportMsg(null);
  }
  // --- saved-dataset archive (ADAAAA-5396 C3) ------------------------------
  // Load the user's persisted, sent datasets. A 403 means the account is on a
  // starter plan or deactivated — the archive is hidden (not an error) so a
  // starter user isn't haunted by a dead control. Admin/paid active accounts
  // get the live list.
  async function refreshArchive() {
    setArchiveDenied(false);
    try {
      const r = await api<{ datasets: SavedDatasetSummary[] }>("/datasets");
      setSaved(r.datasets);
      setArchiveMsg(null);
    } catch (e: any) {
      if (e?.status === 403) {
        setArchiveDenied(true);
        setSaved(null);
      } else {
        setSaved([]);
        setArchiveMsg(String(e?.message || e));
      }
    }
  }

  // Re-materialize a saved dataset's train+val samples back into curation
  // frames so the operator can continue reviewing / re-export after a reload
  // or a new session (proves retrieval for the paid active account).
  async function loadSavedDataset(id: string) {
    try {
      const r = await api<{ dataset: SavedDatasetDetail }>(`/datasets/${id}`);
      const samples = [...r.dataset.train, ...r.dataset.val];
      const frames: CurationFrame[] = samples.map((s, i) => ({
        id: s.id,
        imageRef: s.imageRef,
        width: s.width,
        height: s.height,
        uri: `/training/frames/${s.imageRef}`,
        phash: "",
        sourceSeq: i,
        accepted: true,
        boxes: s.objects.map((o, j) => ({
          id: `saved-box-${i}-${j}`,
          label: o.label as TrainingLabel,
          bbox: o.bbox,
        })),
      }));
      for (const u of createdUrls.current) URL.revokeObjectURL(u);
      createdUrls.current.clear();
      setFrames(frames);
      setSelIdx(frames.length ? 0 : null);
      setSelBox(null);
      setErr(null);
      setExportMsg(`Loaded saved dataset “${r.dataset.name || id}” (${frames.length} sample(s)).`);
    } catch (e: any) {
      setErr(String(e?.message || e));
    }
  }

  // Download a saved dataset as a self-contained zip (ADAAAA-5397, Change 5).
  // Mirrors the LoRA artifact download: authenticated blob fetch so the token
  // never leaks into a query string. A 403 surfaces the plan gate; a 409 means
  // a frame is missing (e.g. purged) so we never save a partial archive.
  async function downloadZip(id: string) {
    try {
      await downloadDatasetZip(id);
      setErr(null);
      setArchiveMsg(`Downloaded dataset ${id}.zip — contains manifests + annotated frames.`);
    } catch (e: any) {
      setArchiveMsg(`Download failed: ${e?.message || e}`);
    }
  }

  // Fetch the archive once on mount so a returning session sees its saved sets.
  useEffect(() => {
    refreshArchive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-neon">Dataset Curation</h1>
          <p className="text-sm text-mut">Florence-2 fine-tune data path · build train/val manifests at 1 fps.</p>
        </div>
        {/* C2 — workflow controls: your curated work-in-progress auto-saves to
            your browser, so you can Stop and come back / reload and Resume. */}
        <div className="flex flex-wrap items-center gap-2">
          <FineTuneHelp page="dataset" />
          {hasWork && (
            <>
              <button className="btn-neon btn-ghost" onClick={handleStop}>
                Save progress
              </button>
              <button
                className="btn-neon btn-fill"
                onClick={saveManifests}
                disabled={!exportOut?.valid || saving}
              >
                {saving ? "Sending…" : "Send dataset"}
              </button>
            </>
          )}
        </div>
      </header>

      {/* C2 — Resume overlay: a saved session from an earlier Start exists in
          this browser. Offer to pick it back up or start fresh. */}
      {isResuming && pendingResume && (
        <section className="card card-accent p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm">
              <span className="font-bold text-neon">Saved work found</span>
              <span className="text-mut">
                {" "}— {pendingResume.frames.length} frame(s),{" "}
                {pendingResume.frames.filter((f) => f.accepted).length} accepted, last saved{" "}
                {new Date(pendingResume.savedAt).toLocaleString()}.
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="btn-neon btn-fill" onClick={() => handleResume(pendingResume)}>
                Resume
              </button>
              <button className="btn-neon btn-ghost" onClick={handleStartNew}>
                Start new
              </button>
            </div>
          </div>
          <p className="mt-2 text-xs text-mut">
            Reloading / stopping never loses your curation — it restores frames, boxes and labels exactly.
          </p>
        </section>
      )}

      {/* Ingest */}
      <section id="extract" className="card p-5">
        <h2 className="mb-3 text-lg font-bold">1 · Ingest a VOD clip</h2>
        <div className="flex gap-3">
          <input
            className="input-neon flex-1"
            placeholder="source URL or clip path, e.g. https://…/clip.mp4 or /data/…/clip.mp4"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doExtract()}
          />
        </div>
        {/* Sliding window: in/out time handles + frame rate. Only the frames
            inside the window are extracted (ffmpeg -ss/-to). */}
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-mut">In (s)</span>
            <input className="input-neon w-28" type="number" min={0} step={0.5} value={inSec} onChange={(e) => setInSec(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-mut">Out (s, empty = end)</span>
            <input className="input-neon w-28" type="number" min={0} step={0.5} value={outSec} onChange={(e) => setOutSec(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-mut">Frame rate (fps)</span>
            <input className="input-neon w-24" type="number" min={0.1} step={0.1} value={fps} onChange={(e) => setFps(e.target.value)} />
          </label>
          <button className="btn-neon btn-fill" onClick={doExtract} disabled={extracting || !source.trim()}>
            {extracting ? "Extracting…" : "Extract frames"}
          </button>
        </div>
        <p className="mt-2 text-xs text-mut">
          Extracts frames at 1280×720 under <code className="text-neon">data/training/extract/</code>. Set the in/out
          time window to a ~10–30 s sliding segment and a frame rate (default ~1 fps) to keep curation bounded —
          only frames inside the window are extracted.
        </p>
      </section>

      {/* Auto-seed */}
      <section id="seed" className="card p-5">
        <h2 className="mb-3 text-lg font-bold">2 · Auto-seed from base detector (optional)</h2>
        <div className="flex gap-3">
          <textarea
            className="input-neon flex-1 resize-y"
            rows={2}
            placeholder='[{"label":"person","bbox":[0.1,0.2,0.3,0.5]}, …]'
            value={seedJson}
            onChange={(e) => setSeedJson(e.target.value)}
          />
          <button className="btn-neon btn-ghost" onClick={seedCurrent} disabled={selIdx == null}>
            Seed current frame
          </button>
        </div>
        <p className="mt-2 text-xs text-mut">
          Paste raw Florence-2 open-set detections; labels are canonicalized into the closed soccer vocab (player /
          soccer ball / goalkeeper / goal / referee), out-of-vocab dropped.
        </p>
      </section>

      {/* Editor + coverage */}
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="card p-5 lg:col-span-2">
          <h2 className="mb-3 text-lg font-bold">3 · Per-frame review</h2>
          {frames.length === 0 ? (
            <p className="text-sm text-mut">Extract a clip to begin. Frames render here for box review.</p>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <button className="btn-neon btn-ghost" onClick={() => setSelIdx((i) => (i == null ? 0 : Math.max(0, i - 1)))} disabled={selIdx == null || selIdx === 0}>
                  ‹ prev
                </button>
                <span className="text-mut">
                  frame {selIdx == null ? "–" : selIdx + 1} / {frames.length}
                </span>
                <button className="btn-neon btn-ghost" onClick={() => setSelIdx((i) => (i == null ? 0 : Math.min(frames.length - 1, i + 1)))} disabled={selIdx == null || selIdx === frames.length - 1}>
                  next ›
                </button>
                <span className="mx-2 text-mut">·</span>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={!!cur?.accepted} onChange={(e) => selIdx != null && updateFrame(selIdx, (f) => ({ ...f, accepted: e.target.checked }))} />
                  <span className="text-neon font-semibold">Accept frame</span>
                </label>
                <span className="mx-2 text-mut">·</span>
                <button className="btn-neon btn-ghost" onClick={deleteSelected} disabled={!selBox}>
                  Delete box
                </button>
              </div>

              {/* Selectable thumbnail grid of extracted frames */}
              <FrameGrid frames={frames} selIdx={selIdx} onSelect={setSelIdx} />

              <div className="relative w-full overflow-hidden rounded-xl border border-white/10 bg-dusk/50">
                <canvas
                  ref={canvasRef}
                  className="block w-full"
                  style={{ aspectRatio: cur ? `${cur.width}/${cur.height}` : "16/9", touchAction: "none" }}
                  onMouseDown={onMouseDown}
                  onMouseMove={onMouseMove}
                  onMouseUp={onMouseUp}
                  onMouseLeave={onMouseUp}
                />
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-mut">new-box class:</span>
                {SOCCER_TRAINING_LABELS.map((l) => (
                  <button
                    key={l}
                    className={`rounded-lg border px-2 py-1 ${label === l ? "border-neon/60 bg-neon/10 text-neon" : "border-white/10 text-slate-ink hover:border-white/30"}`}
                    onClick={() => setLabel(l)}
                  >
                    {l}
                  </button>
                ))}
              </div>
              {cur && (
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="text-mut">edit boxes:</span>
                  {cur.boxes.map((b) => (
                    <span key={b.id} className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 ${selBox === b.id ? "border-neon/60 bg-neon/10" : "border-white/10"}`}>
                      <button onClick={() => { setSelBox(b.id); }}>
                        <span style={{ color: PALETTE[b.label] }}>■</span> {b.label}
                      </button>
                      <select
                        className="input-neon px-1 py-0 text-xs"
                        value={b.label}
                        onChange={(e) => changeLabelOf(b.id, e.target.value as TrainingLabel)}
                      >
                        {SOCCER_TRAINING_LABELS.map((l) => (
                          <option key={l} value={l}>{l}</option>
                        ))}
                      </select>
                    </span>
                  ))}
                </div>
              )}
              {err && <p className="text-sm text-pink">{err}</p>}
            </div>
          )}
        </div>

        {/* Coverage dashboard */}
        <div id="coverage" className="card p-5">
          <h2 className="mb-3 text-lg font-bold">4 · Class coverage</h2>
          <div className="flex flex-col gap-2 text-xs">
            {SOCCER_TRAINING_LABELS.map((l) => {
              const c = coverage.byLabel[l];
              const pct = Math.min(100, Math.round((c.count / c.max) * 100));
              return (
                <div key={l}>
                  <div className="flex justify-between">
                    <span style={{ color: PALETTE[l] }} className="font-semibold">{l}</span>
                    <span className="text-mut">
                      {c.count} / {c.max} {c.withinRange ? "✓" : ""}
                    </span>
                  </div>
                  <div className="mt-1 h-2 rounded bg-white/10">
                    <div className={`h-2 rounded ${c.withinRange ? "bg-green" : "bg-yellow"}`} style={{ width: `${pct}%` }} />
                  </div>
                  <div className="text-[10px] text-mut">target {c.min}–{c.max}</div>
                </div>
              );
            })}
            <div className="mt-2 flex justify-between border-t border-white/10 pt-2">
              <span className="text-mut">total accepted frames</span>
              <span className={coverage.totalWithinRange ? "text-green" : "text-yellow"}>
                {coverage.totalFrames} / {coverage.byLabel ? "3,000–6,000" : "–"}
              </span>
            </div>
            {!coverage.totalWithinRange && frames.length > 0 && (
              <p className="text-[11px] text-yellow">Below the 3,000-frame floor — keep extracting/accepting.</p>
            )}
          </div>
        </div>
      </section>

      {/* Export */}
      <section id="export" className="card p-5">
        <h2 className="mb-3 text-lg font-bold">5 · Export train/val manifests</h2>
        {!exportOut || !frames.length ? (
          <p className="text-sm text-mut">Extract + accept frames first.</p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="text-xs text-mut">
              Accepted: <span className="text-neon">{exportOut.train.length + exportOut.val.length}</span> → train{" "}
              <span className="text-neon">{exportOut.train.length}</span> / val <span className="text-neon">{exportOut.val.length}</span>{" "}
              (85/15, near-dup aware) · manifests pass the shared Zod schema:{" "}
              <span className={exportOut.valid ? "text-green" : "text-pink"}>{exportOut.valid ? "valid" : "INVALID"}</span>
            </div>
            {!exportOut.valid && (
              <ul className="text-xs text-pink">
                {exportOut.validationErrors.slice(0, 5).map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-3">
              <button className="btn-neon btn-ghost" onClick={() => download("train_manifest.jsonl", exportOut.trainJsonl)} disabled={!exportOut.train.length}>
                Download train_manifest.jsonl
              </button>
              <button className="btn-neon btn-ghost" onClick={() => download("val_manifest.jsonl", exportOut.valJsonl)} disabled={!exportOut.val.length}>
                Download val_manifest.jsonl
              </button>
              <button className="btn-neon btn-fill" onClick={saveManifests} disabled={!exportOut.valid || saving}>
                {saving ? "Sending…" : "Send dataset"}
              </button>
            </div>
            {exportMsg && <p className="text-sm text-green">{exportMsg}</p>}
          </div>
        )}
      </section>

      {/* Saved-dataset archive (ADAAAA-5396 C3): the server persists every sent
          dataset in its DB. This section lists them (retrievable for a paid
          active account) and can re-materialize a saved set back into the
          editor after a reload / new session. It is hidden for a starter-plan
          or deactivated account (server denies with 403). */}
      <section className="card p-5">
        <h2 className="mb-3 text-lg font-bold">6 · Your saved datasets (server archive)</h2>
        {archiveDenied ? (
          <p className="text-sm text-mut">Dataset archive requires an active paid plan.</p>
        ) : saved === null ? (
          <p className="text-sm text-mut">Loading…</p>
        ) : saved.length === 0 ? (
          <p className="text-sm text-mut">No saved datasets yet — send (save) a train/val manifest to persist one.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {saved.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 px-3 py-2">
                <div>
                  <span className="text-neon font-semibold">{d.name || d.id}</span>
                  <span className="ml-2 text-mut">
                    {d.trainCount} train / {d.valCount} val · {d.imageRefs.length} frame(s) ·{" "}
                    {new Date(d.createdAt).toLocaleString()}
                  </span>
                </div>
                <div className="flex gap-2">
                  <button className="btn-neon btn-ghost" onClick={() => loadSavedDataset(d.id)}>
                    Load
                  </button>
                  <button className="btn-neon btn-ghost" onClick={() => downloadZip(d.id)} title="Download this dataset as a zip (manifests + annotated frames)">
                    Download zip
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <button className="btn-neon btn-ghost mt-3" onClick={refreshArchive} disabled={archiveDenied}>
          Refresh
        </button>
        {archiveMsg && <p className="mt-2 text-xs text-yellow">{archiveMsg}</p>}
      </section>
    </div>
  );
}

// --- selectable thumbnail grid ---------------------------------------------
/** Renders the extracted frames as a choose-a-frame thumbnail grid so the
 * operator can jump to any extracted frame instantly, not just step
 * prev/next. Each tile is auth-fetched to an object URL and shows accepted /
 * boxed state. Clicking a tile selects it in the editor. */
function FrameGrid({ frames, selIdx, onSelect }: { frames: CurationFrame[]; selIdx: number | null; onSelect: (i: number) => void }) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const urlsRef = useRef<Record<string, string>>({});
  // revoke all created object URLs (also on unmount) so we never leak blobs
  useEffect(() => () => {
    const all = { ...urlsRef.current };
    urlsRef.current = {};
    for (const u of Object.values(all)) URL.revokeObjectURL(u);
  }, []);
  useEffect(() => {
    let alive = true;
    const pending = new Map<string, string>();
    (async () => {
      for (const f of frames) {
        if (!f.uri) continue;
        try {
          const u = await frameObjectURL(f.uri);
          if (!alive) {
            URL.revokeObjectURL(u);
            continue;
          }
          pending.set(f.id, u);
        } catch {
          /* tile stays as placeholder */
        }
      }
      if (alive) {
        urlsRef.current = Object.fromEntries(pending);
        setUrls(urlsRef.current);
      }
    })();
    return () => {
      alive = false;
      for (const u of pending.values()) URL.revokeObjectURL(u);
    };
  }, [frames]);
  return (
    <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
      {frames.map((f, i) => {
        const u = urls[f.id];
        const sel = i === selIdx;
        const boxed = f.boxes.length > 0;
        return (
          <button
            key={f.id}
            type="button"
            title={`frame ${i + 1}${f.accepted ? " · accepted" : ""}${boxed ? ` · ${f.boxes.length} box(es)` : ""}`}
            onClick={() => onSelect(i)}
            className={`relative h-16 w-24 shrink-0 overflow-hidden rounded-lg border-2 ${sel ? "border-neon" : "border-white/10"} ${f.accepted ? "bg-green/20" : "bg-white/5"} hover:border-white/40`}
          >
            {u ? (
              <img src={u} alt={`frame ${i + 1}`} className="h-full w-full object-cover" />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-[10px] text-mut">{i + 1}</span>
            )}
            <span className="absolute bottom-0 left-0 right-0 rounded-t bg-black/50 px-1 text-left text-[9px] text-white">
              {i + 1}
              {boxed ? " ■" : ""}
            </span>
            {f.accepted && <span className="absolute right-0 top-0 bg-green px-1 text-[9px] font-bold text-black">✓</span>}
          </button>
        );
      })}
    </div>
  );
}

// --- box geometry helpers ---------------------------------------------------
function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
function inside(nx: number, ny: number, bbox: [number, number, number, number]): boolean {
  return nx >= bbox[0] && nx <= bbox[2] && ny >= bbox[1] && ny <= bbox[3];
}
function normalizeBox(b: [number, number, number, number]): [number, number, number, number] {
  const [x1, y1, x2, y2] = b;
  const nx1 = Math.min(x1, x2);
  const nx2 = Math.max(x1, x2);
  const ny1 = Math.min(y1, y2);
  const ny2 = Math.max(y1, y2);
  return [nx1, ny1, nx2, ny2];
}
function moveBox(bbox: [number, number, number, number], dx: number, dy: number): [number, number, number, number] {
  let [x1, y1, x2, y2] = bbox;
  const w = x2 - x1;
  const h = y2 - y1;
  x1 = clamp01(x1 + dx); x2 = clamp01(x1 + w);
  y1 = clamp01(y1 + dy); y2 = clamp01(y1 + h);
  return normalizeBox([x1, y1, x2, y2]);
}
function hitCorner(b: CurationBox, nx: number, ny: number): string | null {
  const r = 0.015;
  const [x1, y1, x2, y2] = b.bbox;
  const horiz = Math.abs(nx - x1) <= r ? "w" : Math.abs(nx - x2) <= r ? "e" : "";
  const vert = Math.abs(ny - y1) <= r ? "n" : Math.abs(ny - y2) <= r ? "s" : "";
  if (horiz && vert) return horiz + vert;
  return null;
}
function drawBox(ctx: CanvasRenderingContext2D, b: CurationBox, selected: boolean, W: number, H: number) {
  const [x1, y1, x2, y2] = b.bbox;
  const px = x1 * ctx.canvas.width;
  const py = y1 * ctx.canvas.height;
  const pw = (x2 - x1) * ctx.canvas.width;
  const ph = (y2 - y1) * ctx.canvas.height;
  const c = PALETTE[b.label] ?? "#22d3ee";
  ctx.strokeStyle = c;
  ctx.lineWidth = selected ? 3 : 2;
  ctx.setLineDash(selected ? [6, 4] : []);
  ctx.strokeRect(px, py, pw, ph);
  ctx.setLineDash([]);
  ctx.fillStyle = c;
  ctx.font = "11px monospace";
  ctx.fillText(b.label, px, Math.max(10, py - 4));
  if (selected) {
    ctx.strokeStyle = c;
    ctx.lineWidth = 2;
    const r = 6;
    for (const [cx, cy] of [[x1, y1], [x2, y1], [x1, y2], [x2, y2]] as const) {
      ctx.beginPath();
      ctx.arc(cx * ctx.canvas.width, cy * ctx.canvas.height, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}
