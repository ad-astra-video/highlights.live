// End-to-end evidence for ADAAAA-5397 + ADAAAA-5431: build a dataset zip from
// real ffmpeg frames spanning TWO clips that both restart at frame_0001.jpg
// (the basename-collision scenario the 5431 follow-up fixes), then let the
// repo's own Python re-ingest validator (evals/detect_schema.py) confirm the
// unzipped output matches the training contract + track_label_manifest shape —
// and that no frame was dropped or bound to the wrong clip.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { buildDatasetZip } from "../services/server/src/dataset-zip.ts";
import { buildSample } from "../packages/events/src/index.ts";

const req = createRequire(import.meta.url);
const __dirname = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(__dirname, "..");

const dir = mkdtempSync(path.join(tmpdir(), "hl-e2e-zip-"));
const outZip = path.join(dir, "curated-dataset.zip");

// 1) Generate real 1280x720 frames for two clips that BOTH start at
//    frame_0001 (the 5431 collision: each /training/extract uuid dir restarts
//    the counter, so clipA/frame_0001.jpg and clipB/frame_0001.jpg are
//    distinct bytes bearing distinct drawtext labels).
const clips = ["clipA", "clipB"];
const frameIndexes = [1, 2];
const framesDir = path.join(dir, "frames");
for (const clip of clips) {
  const clipDir = path.join(framesDir, clip);
  mkdirSync(clipDir, { recursive: true });
  for (const i of frameIndexes) {
    execFileSync(
      "ffmpeg",
      ["-y", "-f", "lavfi", "-i", `testsrc=duration=1:size=1280x720:rate=1:decimals=2`, "-frames:v", "1",
        "-vf", `drawtext=text='${clip} frame ${String(i).padStart(4, "0")}':fontsize=80:fontcolor=white:x=40:y=40`,
        path.join(clipDir, `frame_${String(i).padStart(4, "0")}.jpg`)],
      { stdio: "ignore" },
    );
  }
}

// 2) Curated samples: clipA -> train, clipB -> val, sharing frame indices.
const labels = ["player", "soccer ball"];
const samples = [];
for (const clip of clips) {
  for (const i of frameIndexes) {
    samples.push(buildSample(
      `s-${clip}-${i}`,
      `${clip}/frame_${String(i).padStart(4, "0")}.jpg`, 1280, 720,
      [{ label: labels[samples.length % labels.length], bbox: [0.1, 0.2, 0.3, 0.4] }],
    ));
  }
}
const train = samples.slice(0, 2); // clipA/frame_0001, clipA/frame_0002
const val = samples.slice(2);      // clipB/frame_0001, clipB/frame_0002

// 3) Build the zip from a persisted Dataset record (Change 3 DB shape:
//    train/val samples + flattened imageRefs; persistence provides the frame
//    bytes via readImage).
const dataset = {
  id: "e2e-dataset",
  ownerId: "e2e-user",
  name: "e2e-curated",
  train,
  val,
  imageRefs: [...new Set([...train, ...val].map((s) => s.imageRef))],
  trainCount: train.length,
  valCount: val.length,
  status: "active",
  createdAt: new Date().toISOString(),
};
const zip = await buildDatasetZip({
  dataset,
  readImage: (ref) => readFileSync(path.join(framesDir, ref)),
});
writeFileSync(outZip, zip);
console.log(`zip bytes: ${zip.length}  ->  ${outZip}`);

// 4) Unzip + validate with the repo's Python contract validator.
const unz = path.join(dir, "out");
mkdirSync(unz, { recursive: true });
execFileSync("python3", ["-m", "zipfile", "-e", outZip, unz]);
const py = `
import sys, json, os
sys.path.insert(0, ${JSON.stringify(path.join(root, "evals"))})
from detect_schema import validate_manifest, validate_track_manifest
for m in ("train_manifest.jsonl", "val_manifest.jsonl"):
    valid, invalid = validate_manifest(${JSON.stringify(unz)} + "/" + m)
    print(f"{m}: valid_samples={len(valid)} invalid={len(invalid)}")
    for bad in invalid[:5]:
        print("   INVALID:", bad)
    refs = [s["sample"]["imageRef"].split("/")[-1] for s in valid]
    missing = [r for r in refs if not os.path.exists(${JSON.stringify(unz)} + "/images/" + r)]
    print(f"{m}: imageRefs={len(refs)} unique={len(set(refs))} missing_frames={len(missing)}")
    if missing: print("   MISSING:", missing)
imgs = sorted(os.listdir(${JSON.stringify(unz)} + "/images"))
print("images/ count (must be 4, one per (clip,frame)):", len(imgs), imgs)
tlm, terr = validate_track_manifest(${JSON.stringify(unz)} + "/track_label_manifest.json")
print("track_label_manifest.json valid:", tlm is not None, "errors:", terr)
data = tlm = json.load(open(${JSON.stringify(unz)} + "/track_label_manifest.json"))
print("track_label clips:", [c["id"] for c in data["clips"]], "frames:", [len(c["frames"]) for c in data["clips"]])
print("sample object shape:", json.dumps(data["clips"][0]["frames"][0]["objects"][0]))
`;
const pyOut = execFileSync("python3", ["-c", py], { encoding: "utf8" });
console.log("---- python re-ingest validation ----");
console.log(pyOut.trim());
rmSync(dir, { recursive: true, force: true });
console.log("E2E OK");
