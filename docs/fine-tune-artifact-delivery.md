# Fine-tune UI v2 — curated-manifest trigger + LoRA artifact delivery (ADAAAA-5323, Increment B)

Sits on top of the `/app/train` trigger (ADAAAA-5262). Two additions:

1. **Curated-manifest trigger** — the fine-tune page starts a run directly from
   the manifests the annotation loop (Increment A, ADAAAA-5322) publishes,
   instead of requiring a manual JSON paste. Manual paste stays as the
   operator fallback.
2. **Run-scoped LoRA artifact delivery** — a completed run surfaces a
   downloadable artifact (the LoRA adapter + eval report) with an integrity
   hash, served at a run-scoped URL, not a bare server path string.

## Data flow

```
Annotation loop (A) ──publishes──> data/curated/train_manifest.jsonl
                                   data/curated/val_manifest.jsonl   (Zod-valid)
                                              │
        POST /train { manifestSource:"curated" } or manual paste ──> train service
                                              │
                              highlights-train runner (services/train/run.py
                              + fine_tune_od.py) emits adapter .safetensors
                              + summary/eval_report + artifact{filename,sha256,size}
                                              │
        POST /train response: run.result.artifact { filename, sha256, size,
                                                    downloadPath:"/train/:id/artifact" }
                                              │
        GET /train/:id/artifact ──> re-hash staged file, verify digest,
                                    stream (attachment + X-Checksum-Sha256)
```

## Curated-manifest trigger

- `GET /train/curated` returns `{ curated: { present, trainCount, valCount,
  updatedAt } }` — the UI uses it to offer (or hide) the one-click curated path.
- `POST /train` accepts `manifestSource: "curated" | "paste"`. With `"curated"`
  the server loads the published manifests itself (422 `no_curated_manifest`
  if none). `"paste"` (default/absent) keeps the old manual JSON body.
- Increment A publishes to `curatedManifestDir`
  (env `CURATED_MANIFEST_DIR`, default `<dataDir>/curated`).

## Artifact delivery + integrity

- The runner (`services/train/run.py`) returns `artifact: { filename, sha256,
  size, contentType }` for the LoRA adapter, computed over the emitted file.
  A `GET /app/artifact?run=<run>` endpoint lets a deploy pull it when the
  adapter is not already staged server-side.
- The server records the artifact metadata on the run (`downloadPath` set to
  `/train/<id>/artifact`) and, when the file is already under
  `trainArtifactRoot` (env `TRAIN_ARTIFACT_ROOT`, default `<dataDir>/train-artifacts`),
  pins its real size + SHA-256.
- `GET /train/:id/artifact` (company-scoped: owner or admin only) re-hashes the
  staged file and **verifies it against the recorded digest** before streaming —
  a tampered or missing file is refused (409 `artifact_unavailable`), never
  silently served. Headers: `Content-Disposition: attachment`,
  `X-Checksum-Sha256`, `Digest`, `ETag`, `Cache-Control: private, no-store`.
- The webapp downloads over an authenticated fetch and **re-verifies SHA-256 on
  the client** against `X-Checksum-Sha256` — artifact hash is verified end to end.

## Deployment notes

- For the download to work the server must be able to read the adapter file
  under `trainArtifactRoot` (shared/network mount with the runner's `TRAIN_OUT`,
  or a staging step that copies it in). Where the box's `/runs` is not directly
  reachable, pull per-run metadata via the runner's `GET /app/artifact` and
  stage the file into `trainArtifactRoot` (Infra Monitor owns the box leg).
- `services/server/test/train.test.ts` covers the curated trigger and artifact
  download/integrity/boundary paths end to end.
