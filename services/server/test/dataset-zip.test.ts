import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import {
  DetectionTrainingSampleSchema,
  type DetectionTrainingSample,
  type TrainingLabel,
  type Dataset,
  serializeManifestJsonl,
  parseManifestJsonl,
  buildSample,
} from "@highlights/events";
import {
  buildDatasetZip,
  buildTrackLabelManifest,
  writeZip,
  type ZipEntry,
  readPersistedImage,
  datasetExtractRoot,
  sampleImageName,
} from "../src/dataset-zip";
import { canRetrieveDataset } from "../src/billing";
import { buildTestApp } from "./helpers";

// A real, tiny (1x1) decodable JPEG so the bundled frames are genuine images.
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAAAAAAAAAQECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECEQQDEiFBUgYHEhFCMJEyUQpFITYnFChGQmNSolRikxYHKCkuJjc4OTpDU1RVZldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==",
  "base64",
);

function sample(id: string, label: TrainingLabel, frame: string): DetectionTrainingSample {
  return buildSample(id, `d1/${frame}.jpg`, 1280, 720, [{ label, bbox: [0.1, 0.2, 0.3, 0.4] }]);
}

const TRAIN = [
  sample("t1", "player", "frame_0001"),
  sample("t2", "soccer ball", "frame_0002"),
  sample("t3", "goal", "frame_0003"),
];
const VAL = [sample("v1", "goalkeeper", "frame_0101")];

function makeDataset(id: string, ownerId: string, train = TRAIN, val = VAL): Dataset {
  return {
    id,
    ownerId,
    name: `dataset-${id}`,
    train,
    val,
    imageRefs: [...new Set([...train, ...val].map((s) => s.imageRef))],
    trainCount: train.length,
    valCount: val.length,
    status: "active",
    createdAt: new Date().toISOString(),
  };
}

/** Independent ZIP reader — parses the central directory + EOCD straight from
 * the bytes and inflates each entry. Proves well-formedness without trusting
 * the encoder. */
function readZip(buf: Buffer): { [name: string]: Buffer } {
  const eocd = buf.lastIndexOf(Buffer.from("PK\x05\x06"));
  expect(eocd).toBeGreaterThan(-1);
  const count = buf.readUInt16LE(eocd + 10);
  const cdOff = buf.readUInt32LE(eocd + 16);
  const out: { [name: string]: Buffer } = {};
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    const sig = buf.readUInt32LE(p);
    expect(sig).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    expect(buf.readUInt32LE(localOff)).toBe(0x04034b50);
    const localNameLen = buf.readUInt16LE(localOff + 26);
    const localExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + localNameLen + localExtraLen;
    const data = buf.subarray(dataStart, dataStart + size); // compSize==size for STORE
    let raw: Buffer;
    if (method === 8) raw = inflateRawSync(data);
    else if (method === 0) raw = data;
    else throw new Error(`unsupported method ${method}`);
    out[name] = raw;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe("dataset-zip writeZip (ADAAAA-5397)", () => {
  it("produces a well-formed zip that an independent reader can inflate", () => {
    const entries: ZipEntry[] = [
      { name: "train_manifest.jsonl", data: Buffer.from("a\nb\n") },
      { name: "images/frame_0001.jpg", data: TINY_JPEG },
      { name: "nested/dir/file.txt", data: Buffer.from("hello zip") },
    ];
    const zip = writeZip(entries);
    const read = readZip(zip);
    expect(read["train_manifest.jsonl"].toString()).toBe("a\nb\n");
    expect(read["images/frame_0001.jpg"].equals(TINY_JPEG)).toBe(true);
    expect(read["nested/dir/file.txt"].toString()).toBe("hello zip");
  });

  it("rejects path-traversal entry names", () => {
    expect(() => writeZip([{ name: "../evil", data: Buffer.from("x") }])).toThrow(/unsafe name/);
    expect(() => writeZip([{ name: "/abs", data: Buffer.from("x") }])).toThrow(/unsafe name/);
    expect(() => writeZip([{ name: "a\\b", data: Buffer.from("x") }])).toThrow(/unsafe name/);
  });
});

describe("buildDatasetZip layout (ADAAAA-5397)", () => {
  it("builds a zip that unzips to the DetectionTrainingSample train/val layout", async () => {
    const images = new Map<string, Buffer>();
    for (const s of [...TRAIN, ...VAL]) images.set(sampleImageName(s), TINY_JPEG);
    const zip = await buildDatasetZip({
      dataset: makeDataset("ds1", "u1"),
      readImage: async (ref) => images.get(sampleImageName({ imageRef: ref } as any)) ?? null,
    });
    const unzipped = readZip(zip);
    const names = Object.keys(unzipped).sort();
    expect(names).toEqual(
      ["README.md", "images/frame_0001.jpg", "images/frame_0002.jpg", "images/frame_0003.jpg",
        "images/frame_0101.jpg", "track_label_manifest.json", "train_manifest.jsonl", "val_manifest.jsonl"],
    );

    // manifests re-ingest cleanly against the shared Zod schema
    const train = parseManifestJsonl(unzipped["train_manifest.jsonl"].toString());
    const val = parseManifestJsonl(unzipped["val_manifest.jsonl"].toString());
    expect(train).toHaveLength(3);
    expect(val).toHaveLength(1);
    for (const s of [...train, ...val]) {
      expect(DetectionTrainingSampleSchema.safeParse(s).success).toBe(true);
      expect(unzipped[`images/${sampleImageName(s)}`]).toBeTruthy();
    }

    // track_label_manifest.json is a valid tracker-eval shape (sport + clips)
    const tlm = JSON.parse(unzipped["track_label_manifest.json"].toString());
    expect(tlm.sport).toBe("soccer");
    expect(tlm.clips[0].id).toBe("train");
    expect(tlm.clips[0].frames).toHaveLength(3);
    expect(tlm.clips[0].frames[0].objects[0]).toMatchObject({ id: "o0", bbox: [0.1, 0.2, 0.3, 0.4], kind: "player" });
    expect(tlm.clips[1].id).toBe("val");
    expect(tlm.clips[1].frames).toHaveLength(1);
  });

  it("aborts (no corrupt zip) when an annotated frame is missing from persistence", async () => {
    const images = new Map<string, Buffer>([["frame_0001.jpg", TINY_JPEG]]);
    await expect(
      buildDatasetZip({
        dataset: makeDataset("ds2", "u1"),
        readImage: async (r) => images.get(sampleImageName({ imageRef: r } as any)) ?? null,
      }),
    ).rejects.toThrow(/missing from persistence/);
  });

  it("isDecodableByPythonZipfile (external well-formedness check)", async () => {
    const images = new Map([["frame_0001.jpg", TINY_JPEG]]);
    const zip = await buildDatasetZip({
      dataset: makeDataset("ds3", "u1", TRAIN.slice(0, 1), []),
      readImage: async (r) => images.get(sampleImageName({ imageRef: r } as any)) as Buffer,
    });
    const dir = mkdtempSync(path.join(tmpdir(), "hl-zip-py-"));
    const zipPath = path.join(dir, "out.zip");
    await fs.writeFile(zipPath, zip);
    const listing = execFileSync("python3", ["-m", "zipfile", "-l", zipPath], { encoding: "utf8" });
    expect(listing).toContain("train_manifest.jsonl");
    expect(listing).toContain("images/frame_0001.jpg");
    execFileSync("python3", ["-m", "zipfile", "-e", zipPath, path.join(dir, "out")]);
    const manifest = await fs.readFile(path.join(dir, "out", "train_manifest.jsonl"), "utf8");
    expect(parseManifestJsonl(manifest)).toHaveLength(1);
    const img = await fs.readFile(path.join(dir, "out", "images", "frame_0001.jpg"));
    expect(img.equals(TINY_JPEG)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("plan gate (ADAAAA-5397)", () => {
  it("allows paid (pro) active/trialing, blocks starter and deactivated", () => {
    expect(canRetrieveDataset({ tier: "pro", status: "active" } as any)).toBe(true);
    expect(canRetrieveDataset({ tier: "pro", status: "trialing" } as any)).toBe(true);
    expect(canRetrieveDataset({ tier: "free", status: "active" } as any)).toBe(false); // starter
    expect(canRetrieveDataset({ tier: "pro", status: "past_due" } as any)).toBe(false); // deactivated
    expect(canRetrieveDataset({ tier: "pro", status: "canceled" } as any)).toBe(false); // deactivated
  });
});

describe("readPersistedImage seam (ADAAAA-5397)", () => {
  it("resolves imageRefs under the extract root and blocks traversal", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hl-dset-")); // acts as cfg.dataDir
    const cfg = { dataDir: dir } as any;
    const frameDir = path.join(datasetExtractRoot(cfg), "d1");
    await fs.mkdir(frameDir, { recursive: true });
    await fs.writeFile(path.join(frameDir, "frame_0001.jpg"), TINY_JPEG);

    expect((await readPersistedImage(cfg, "d1/frame_0001.jpg"))?.equals(TINY_JPEG)).toBe(true);
    // missing frame -> null
    expect(await readPersistedImage(cfg, "d1/nope.jpg")).toBeNull();
    // traversal/absolute refs are never resolved
    expect(await readPersistedImage(cfg, "../secret")).toBeNull();
    expect(await readPersistedImage(cfg, "/etc/passwd")).toBeNull();
    expect(await readPersistedImage(cfg, "d1/../../etc/passwd")).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("GET /training/dataset.zip route (ADAAAA-5397)", () => {
  let app: any;
  let cfg: any;
  let db: any;
  let ownerId: string;
  let token: string;
  let dsId: string;

  beforeAll(async () => {
    const built = await buildTestApp();
    app = built.app;
    cfg = built.cfg;
    db = built.db;
    const reg = await app.inject({ method: "POST", url: "/auth/register", payload: { email: "zip@test.dev", password: "password123" } });
    expect(reg.statusCode).toBe(200);
    ownerId = reg.json().user.id;
    token = reg.json().token;

    // Persist a dataset via the Change 3 DB seam, with its frames on the
    // extract root (the layout POST /training/manifests + /training/extract
    // produce): imageRefs are relative to dataDir/training/extract.
    for (const s of [...TRAIN, ...VAL]) {
      const abs = path.join(datasetExtractRoot(cfg), s.imageRef);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, TINY_JPEG);
    }
    const ds = makeDataset("ds-route-1", ownerId);
    dsId = ds.id;
    await db.saveDataset(ds);
  });

  afterAll(async () => {
    await app.close();
  });

  it("blocks starter-plan (free) download with 403 plan_required", async () => {
    const res = await app.inject({ method: "GET", url: "/training/dataset.zip", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("plan_required");
  });

  it("returns 404 no_dataset when paid-active but nothing persisted", async () => {
    const reg = await app.inject({ method: "POST", url: "/auth/register", payload: { email: "empty@test.dev", password: "password789" } });
    const t2 = reg.json().token;
    await db.setSubscription(reg.json().user.id, { tier: "pro", status: "active" });
    const res = await app.inject({ method: "GET", url: "/training/dataset.zip", headers: { authorization: `Bearer ${t2}` } });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("no_dataset");
  });

  it("downloads a valid zip while paid-active and blocks after deactivation", async () => {
    // starter -> 403
    let res = await app.inject({ method: "GET", url: "/training/dataset.zip", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);
    // activate pro -> 200 zip
    await db.setSubscription(ownerId, { tier: "pro", status: "active" });

    res = await app.inject({ method: "GET", url: "/training/dataset.zip", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/zip");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["x-dataset-train"]).toBe("3");
    expect(res.headers["x-dataset-val"]).toBe("1");

    const unzipped = readZip(res.rawPayload as Buffer);
    expect(unzipped["train_manifest.jsonl"]).toBeTruthy();
    expect(parseManifestJsonl(unzipped["train_manifest.jsonl"].toString())).toHaveLength(3);
    expect(unzipped["images/frame_0001.jpg"].equals(TINY_JPEG)).toBe(true);

    // explicit ?id= also works
    res = await app.inject({ method: "GET", url: `/training/dataset.zip?id=${dsId}`, headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-dataset-id"]).toBe(dsId);

    // deactivate (paid plan canceled) -> 403 again
    await db.setSubscription(ownerId, { tier: "pro", status: "canceled" });
    res = await app.inject({ method: "GET", url: "/training/dataset.zip", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("plan_required");
  });

  it("owner-scopes: another user cannot download this dataset (403 gate then 404)", async () => {
    const reg = await app.inject({ method: "POST", url: "/auth/register", payload: { email: "other@test.dev", password: "passwordabc" } });
    const t3 = reg.json().token;
    await db.setSubscription(reg.json().user.id, { tier: "pro", status: "active" });
    // explicit id of a dataset owned by someone else -> 404 not_found (not exposed)
    const res = await app.inject({ method: "GET", url: `/training/dataset.zip?id=${dsId}`, headers: { authorization: `Bearer ${t3}` } });
    expect(res.statusCode).toBe(404);
  });
});
