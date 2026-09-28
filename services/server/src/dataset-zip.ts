// Dataset zip download for local retention (ADAAAA-5391 C5, task ADAAAA-5397).
//
// The user's curated fine-tune dataset is persisted on send by Change 3
// (ADAAAA-5396): POST /training/manifests writes a `Dataset` record to the
// server DB (train/val DetectionTrainingSample rows + flattened imageRefs),
// retrievable while the owning account is paid & active. This module turns that
// persisted set into a downloadable ZIP the user keeps locally.
//
// ZIP layout (the "DetectionTrainingSample layout"):
//
//   <dataset>.zip
//   ├── README.md                       layout + re-ingest instructions
//   ├── train_manifest.jsonl            Zod-valid JSONL (DetectionTrainingSample)
//   ├── val_manifest.jsonl              Zod-valid JSONL (DetectionTrainingSample)
//   ├── track_label_manifest.json       consolidated {sport, clips[], frames[],
//   │                                    objects[{id,bbox,kind}]} — same labelled
//   │                                    set the tracker eval uses
//   └── images/
//       └── <unique slug of each sample imageRef>   annotated frames / boxes
//
// Re-ingest (matches services/train/fine_tune_od.py): point --manifest / --val
// at the two JSONL files and pass --image-base-dirs images so imageRef
// basenames resolve to the bundled frames. Every rail is self-contained: the
// manifests reference image slugs whose basenames match the bundled file, and
// the zip ships those files.
//
// Naming/disambiguity: a frame's archive name and its `image:` binding are
// keyed by the FULL persisted imageRef slug (dir + basename, slashes joined by
// `_`), never by the bare basename. `/training/extract` writes each clip under
// its own uuid dir and ffmpeg restarts at `frame_0001.jpg`, so two clips would
// otherwise collide on `frame_0001.jpg` and ship the wrong frame (ADAAAA-5431).
import { deflateRawSync, crc32 } from "node:zlib";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DetectionTrainingSampleSchema, type DetectionTrainingSample, type Dataset } from "@highlights/events";
import type { ServerConfig } from "./config";

// --- frame resolution (Change 3 seam) ----------------------------------------
// Change 3 persists imageRefs only; the actual frame bytes live under
// `<cfg.dataDir>/training/extract/` (the same root the curation `GET
// /training/frames/*` route serves). imageRef is a path relative to that root
// (e.g. `<uuid>/frame_0001.jpg`). We resolve it there, traversal-guarded.
export function datasetExtractRoot(cfg: ServerConfig): string {
  return path.join(cfg.dataDir, "training", "extract");
}

/** Resolve an annotated frame's bytes by its manifest imageRef (relative to the
 * dataset extract root, mirroring the /training/frames/* serve path). Returns
 * null when the file is missing. Path traversal is impossible: we normalize
 * the ref to a relative path, reject any `..`/absolute component, and confine
 * the join under the extract root. */
export async function readPersistedImage(
  cfg: ServerConfig,
  imageRef: string,
): Promise<Buffer | null> {
  const root = path.resolve(datasetExtractRoot(cfg));
  const parts = imageRef.split(/[\\/]/).filter(Boolean);
  // reject absolute refs and any traversal component
  if (parts.length === 0 || parts.some((p) => p === "..")) return null;
  const rel = parts.join("/");
  const abs = path.join(root, rel);
  if (!abs.startsWith(root + path.sep)) return null;
  try {
    const st = await fs.stat(abs);
    if (!st.isFile()) return null;
    return await fs.readFile(abs);
  } catch {
    return null;
  }
}

// --- DetectionTrainingSample -> image filename ------------------------------
/** Unique, archive-safe slug for a persisted imageRef (relative to the dataset
 * extract root, e.g. `clipA/frame_0001.jpg`). Joins every path segment with
 * `_` so two clips that both restart at `frame_0001.jpg` (each under its own
 * uuid dir) never collide on a bare basename: `clipA/frame_0001.jpg` ->
 * `clipA_frame_0001.jpg`. The shipped manifests, track_label_manifest `image:`
 * field, and bundled images all key on this slug. Because re-ingest
 * (`fine_tune_od.py resolve_image`) matches by basename, the shipped manifest
 * imageRef is rewritten to this slug so basename(slug)==slug resolves to the
 * bundled file even for multi-clip datasets. */
export function imageRefSlug(imageRef: string): string {
  return imageRef.split(/[\\/]+/).filter(Boolean).join("_");
}

/** The file name a sample's image is stored under in the zip (the unique slug
 * of its full imageRef, not the bare basename — see imageRefSlug). */
export function sampleImageName(sample: DetectionTrainingSample): string {
  return imageRefSlug(sample.imageRef);
}

// --- ZIP writer -------------------------------------------------------------
export interface ZipEntry {
  name: string; // forward-slash path within the archive
  data: Buffer;
}

const ZIP_VERSION = 20; // deflate + UTF-8 name bit
const ZIP_UTF8_BIT = 0x0800;

/**
 * Streamless, dependency-free ZIP encoder (STORE + DEFLATE). Emits local file
 * headers, one central directory, and the end-of-central-directory record with
 * proper CRC32 (node:zlib.crc32) and UTF-8 flags on the names. Well-formed
 * enough for any standard unzip tool (verified in tests via a decoupled
 * reader and python3 -m zipfile).
 */
export function writeZip(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    if (entry.name.includes("\\") || entry.name.startsWith("/") || entry.name.split("/").includes("..")) {
      throw new Error(`zip entry has unsafe name: ${entry.name}`);
    }
    const nameBuf = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const size = entry.data.length;
    let method = 8; // DEFLATE
    let comp: Buffer = deflateRawSync(entry.data, { level: 6 });
    if (comp.length >= size) {
      method = 0; // STORE wins when deflate doesn't help (tiny/compressed images)
      comp = entry.data;
    }

    // --- local file header ---
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); // "PK\x03\x04"
    lfh.writeUInt16LE(ZIP_VERSION, 4);
    lfh.writeUInt16LE(ZIP_UTF8_BIT, 6); // flags: UTF-8 names
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10); // mod time
    lfh.writeUInt16LE(0x21, 12); // mod date (1980-01-01-ish, fixed)
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(comp.length, 18);
    lfh.writeUInt32LE(size, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28); // extra len

    const lfhName = Buffer.concat([lfh, nameBuf]);
    chunks.push(lfhName, comp);

    // --- central directory header ---
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // "PK\x01\x02"
    cd.writeUInt16LE(ZIP_VERSION, 4); // version made by
    cd.writeUInt16LE(ZIP_VERSION, 6); // version needed
    cd.writeUInt16LE(ZIP_UTF8_BIT, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12); // mod time
    cd.writeUInt16LE(0x21, 14); // mod date
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk number start
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(Buffer.concat([cd, nameBuf]));

    offset += lfhName.length + comp.length;
  }

  const centralBuf = Buffer.concat(central);
  const centralStart = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // "PK\x05\x06"
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // cd start disk
  eocd.writeUInt16LE(entries.length, 8); // entries on disk
  eocd.writeUInt16LE(entries.length, 10); // entries total
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

// --- track_label_manifest.json builder --------------------------------------
// Consolidated labelled set in the tracker-eval shape (see
// evals/detect_schema.py validate_track_manifest): top-level `{sport, clips[]}`
// where each frame carries `objects:[{id,bbox,kind}]`. Lets a reviewer confirm
// the unzipped dataset's shape matches `track_label_manifest.json` 1:1 for the
// same underlying frames.
export function buildTrackLabelManifest(
  train: DetectionTrainingSample[],
  val: DetectionTrainingSample[],
): string {
  const frames = (samples: DetectionTrainingSample[]) =>
    samples.map((s, i) => ({
      frame: i,
      objects: s.objects.map((o, oi) => ({
        id: `o${oi}`,
        bbox: o.bbox,
        kind: o.label,
      })),
      image: imageRefSlug(s.imageRef),
      sourceId: s.id,
    }));
  const manifest = {
    sport: "soccer",
    clips: [
      { id: "train", mode: "dataset", frames: frames(train) },
      { id: "val", mode: "dataset", frames: frames(val) },
    ],
  };
  return JSON.stringify(manifest, null, 1) + "\n";
}

// --- top-level builder -------------------------------------------------------
export interface DatasetZipSource {
  /** The persisted dataset record (Change 3: server DB `datasets` table). */
  dataset: Dataset;
  /** Resolve a sample's annotated image bytes by its manifest imageRef. Return
   * null to have the build fail closed (we never ship a corrupt/partial zip). */
  readImage: (imageRef: string) => Promise<Buffer | null>;
}

const README = `# Curated detection dataset (zip export)

This zip is the persisted DetectionTrainingSample dataset exported for local
retention. It is fully self-contained: each manifest imageRef is a unique
slug (dir + basename joined by an underscore) and the annotated frames ship
alongside them, so multi-clip datasets keep every frame distinct.

Layout:
  train_manifest.jsonl      Zod-valid DetectionTrainingSample train set (JSONL)
  val_manifest.jsonl        Zod-valid DetectionTrainingSample val set (JSONL)
  track_label_manifest.json consolidated labelled set ({sport, clips, frames})
  images/<refSlug>.jpg       annotated frames (one per sample imageRef)
  README.md                 this file

Re-ingest (services/train/fine_tune_od.py):
  python3 fine_tune_od.py --manifest train_manifest.jsonl --val val_manifest.jsonl \\
    --image-base-dirs images

Each manifest line validates against DetectionTrainingSampleSchema; frames are
1280x720 and object bboxes are normalized 0..1 in the closed soccer vocab.
`;

/** A sample's manifest imageRef rewritten to its archive slug so re-ingest
 * (which matches by basename) resolves to the bundled image even when two
 * clips restart at the same frame index. */
function shipSample(s: DetectionTrainingSample): DetectionTrainingSample {
  return Object.assign({}, s, { imageRef: imageRefSlug(s.imageRef) });
}

/** Build the downloadable dataset ZIP from a persisted dataset record. Throws
 * with a descriptive error listing any missing annotated frames so a user can
 * never receive a corrupt archive. */
export async function buildDatasetZip(src: DatasetZipSource): Promise<Buffer> {
  const { train, val, imageRefs } = src.dataset;
  const entries: ZipEntry[] = [
    { name: "README.md", data: Buffer.from(README, "utf8") },
    {
      name: "train_manifest.jsonl",
      data: Buffer.from(
        train.map((s) => JSON.stringify(DetectionTrainingSampleSchema.parse(shipSample(s)))).join("\n") +
          (train.length ? "\n" : ""),
        "utf8",
      ),
    },
    {
      name: "val_manifest.jsonl",
      data: Buffer.from(
        val.map((s) => JSON.stringify(DetectionTrainingSampleSchema.parse(shipSample(s)))).join("\n") +
          (val.length ? "\n" : ""),
        "utf8",
      ),
    },
    { name: "track_label_manifest.json", data: Buffer.from(buildTrackLabelManifest(train, val), "utf8") },
  ];

  // Bundle each unique imageRef exactly once by its archive SLUG (a frame may
  // be shared across samples; two clips may share a bare basename but never a
  // full-ref slug). Fail closed if any annotated frame is missing, or if two
  // distinct imageRefs collapse to the same slug (we never merge frames).
  const missing: string[] = [];
  const seen = new Map<string, string>(); // slug -> original ref
  for (const ref of imageRefs) {
    const name = imageRefSlug(ref);
    if (seen.has(name)) {
      if (seen.get(name) !== ref) {
        throw new Error(
          `dataset zip aborted: distinct imageRefs map to the same archive image '${name}' (${seen.get(name)} and ${ref}); refusing to merge frames`,
        );
      }
      continue;
    }
    seen.set(name, ref);
    const data = await src.readImage(ref);
    if (!data) {
      missing.push(name);
      continue;
    }
    entries.push({ name: `images/${name}`, data });
  }
  if (missing.length) {
    throw new Error(
      `dataset zip aborted: ${missing.length} annotated frame(s) missing from persistence (${missing
        .slice(0, 8)
        .join(", ")})`,
    );
  }
  return writeZip(entries);
}
