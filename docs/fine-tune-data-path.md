# Florence-2 Fine-Tune Data Path (ADAAAA-5164)

How training data for the Florence-2 fine-tune is produced, validated, and
handed to the training leg. This is the data-path leg only — **no training GPU
is scheduled here** and no Livepeer jobs are submitted from this leg. Frame
staging and manifest writing is done here; the actual training job is a later
leg owned separately.

## 1. The shared contract: `DetectionTrainingSample`

Lives in `packages/events/src/index.ts` (re-exported from
`packages/events/src/training.ts`). One row = one curated frame:

```ts
{
  id: string;                 // stable frame id
  imageRef: string;           // <bucket>/frame_XXXX.jpg relative to data/training
  width: number; height: number;   // positive ints (curation scale, 1280x720)
  objects: Array<{
    label: "player" | "soccer ball" | "goalkeeper" | "goal" | "referee";
    bbox: [x1, y1, x2, y2];   // normalized 0..1, x2>=x1, y2>=y1
  }>;
}
```

- The label values are the **closed 5-label soccer vocabulary**, mirroring the
  soccer alias group in `services/perceive/app/florence.py`
  `_GAME_VOCABULARIES["soccer"]`. Raw detector labels are canonicalized onto it
  by `canonicalizeTrainingLabel` in `packages/events/src/training.ts` (null for
  out-of-vocab labels, dropped).
- `bbox` is range-checked (`NormalizedBBoxSchema`), so a fine-tune sample can
  never carry an out-of-frame or inverted box.
- The contract is re-exported through `@highlights/events` and consumed by the
  webapp (`webapp/src/lib/dataset.ts`) and the server
  (`services/server/src/dataset.ts`) — the single import specifier is the
  contract-sync point.

## 2. Dataset Curation UI (`/app/dataset`)

`webapp/src/pages/Dataset.tsx` (nav: **Dataset Curation**) reuses the
Dashboard / FrameDebugger / BrowserCapture patterns:

1. **Ingest** a VOD clip → `POST /training/extract` extracts frames with ffmpeg
   at 1280x720 under `data/training/extract/`. A **sliding window** (in/out
   second handles, default full clip) plus a **frame rate** (default ~1 fps)
   bound the extraction — only frames inside the window are produced
   (`buildExtractArgs` in `services/server/src/ffmpeg.ts` positions `-ss`
   before `-i` and `-to` after `-i`). Extracted frames appear as a **selectable
   thumbnail grid** in the UI so the operator can jump straight to any frame,
   not just step prev/next.
2. **Auto-seed** (optional): paste the base Florence-2 open-set detections;
   `autoSeedBoxes` canonicalizes into the closed vocab and drops the rest.
3. **Review**: per-frame canvas editor — draw new boxes, drag to move, corner
   handles to resize, delete, reassign class from the 5-label vocab, accept the
   frame. Perceptual hash is computed from the decoded pixels for near-dup
   bucketing.
4. **Coverage dashboard**: class counts vs. V1 targets
   (player 4000–6000, soccer ball 1500–2500, goalkeeper 300–500, goal 200–400,
   referee 200–300; total 3000–6000 frames).
5. **Export**: `exportManifests` splits accepted frames **85/15 at frame level,
   near-dup aware** (near-duplicate frames stay in the same split side), then
   serializes and Zod-validates both manifests before they are shown or saved.

## 3. Manifests: `evals/train_manifest.jsonl` + `evals/val_manifest.jsonl`

- One `DetectionTrainingSample` per line, each line validated by the shared Zod
  schema (`serializeManifestJsonl` / `parseManifestJsonl` /
  `validateManifest`).
- Shape mirrors `evals/track_label_manifest.json`: every object entry carries a
  normalized `[x1,y1,x2,y2]` bbox plus a label (the `kind` counterpart there).
- The server gate `POST /training/manifests`
  (`writeTrainValManifests` in `services/server/src/dataset.ts`) re-validates
  **every** sample and writes **nothing** on any invalid row — returns 422 with
  the offending line indices instead. On success it writes
  `evals/train_manifest.jsonl` and `evals/val_manifest.jsonl`.

Because `evalsDir` is resolved relative to the server data dir, the manifests
land in the repo `evals/` folder when the server runs in the workspace.

## 4. Submission path (images + manifests → training box)

1. **Frames**: `imageRef` is kept relative to `data/training`
   (`<bucket>/frame_XXXX.jpg`). When a curation session is ready, the frames
   under `data/training/extract/` are staged to the training object store under
   `data/training/` **+ box object storage** (kept aligned with `imageRef`).
2. **Manifests**: `evals/train_manifest.jsonl` + `evals/val_manifest.jsonl` are
   submitted via the **Livepeer job channel**, or uploaded directly to the
   training box.
3. **Owner**: the training box is **owned by Infra Monitor**. This data-path
   leg stages the frames + writes the validated manifests and hands them off;
   Infra Monitor owns the actual submission/consumption by the training leg.

> Near-dup leakage note: the split keeps whole near-dup clusters on one side to
> avoid train/val leakage. If an input set is degenerate (a single near-dup
> cluster coarser than the 15% target — e.g. an almost-static clip), the split
> still produces a non-empty ~85/15 split by distributing at the ratio, which
> unavoidably lets that one cluster straddle the split. For realistic 1 fps
> soccer footage (camera motion, continuously moving play) clusters are small
> and no straddling occurs. If a whole session collapses into one giant cluster,
> curate more diverse clips instead.
