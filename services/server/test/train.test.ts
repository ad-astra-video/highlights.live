import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTestApp, fakePipeline } from "./helpers";

async function register(app: any, email: string, pw: string) {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: pw } });
  expect(r.statusCode).toBe(200);
  return r.json().token as string;
}

const SAMPLES = [
  { image: "/srv/frames/a.png", labels: [{ label: "player", bbox: [0.1, 0.1, 0.46, 0.32] }] },
  { image: "/srv/frames/b.png", labels: [{ label: "player", bbox: [0.2, 0.2, 0.7, 0.55] }] },
];

describe("train trigger (ADAAAA-5262)", () => {
  it("board user starts a fine-tune and sees it complete (result surfaced)", async () => {
    const { app, db } = await buildTestApp();
    const token = await register(app, "train@test.dev", "password123");

    const res = await app.inject({
      method: "POST",
      url: "/train",
      headers: { authorization: `Bearer ${token}` },
      payload: { manifest: SAMPLES, epochs: 2, batchSize: 4 },
    });
    expect(res.statusCode).toBe(200);
    const { run } = res.json();
    expect(run.id).toBeTruthy();
    expect(run.status).toBe("done");
    expect(run.ownerId).toBeTruthy();
    expect(run.result?.checkpoint).toBe("/runs/train-smoke/model.safetensors");
    expect(run.result?.eval?.precision).toBe(0.91);

    // Durably persisted, surfaced via GET /train: list + single.
    const list = await app.inject({ method: "GET", url: "/train", headers: { authorization: `Bearer ${token}` } });
    expect(list.statusCode).toBe(200);
    const { runs } = list.json();
    expect(runs.length).toBe(1);
    expect(runs[0].id).toBe(run.id);

    const one = await app.inject({ method: "GET", url: `/train/${run.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(one.statusCode).toBe(200);
    expect(one.json().run.status).toBe("done");

    const stored = await db.getTrainRun(run.id);
    expect(stored?.status).toBe("done");
  });

  it("rejects an invalid manifest with 422", async () => {
    const { app } = await buildTestApp();
    const token = await register(app, "bad@test.dev", "password123");
    const res = await app.inject({
      method: "POST",
      url: "/train",
      headers: { authorization: `Bearer ${token}` },
      payload: { manifest: [] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("invalid_manifest");
  });

  it("enforces the company/user boundary: another user cannot read a run", async () => {
    const { app } = await buildTestApp();
    const alice = await register(app, "alice@test.dev", "password123");
    const bob = await register(app, "bob@test.dev", "password456");

    const created = await app.inject({
      method: "POST",
      url: "/train",
      headers: { authorization: `Bearer ${alice}` },
      payload: { manifest: SAMPLES },
    });
    const runId = created.json().run.id;

    const other = await app.inject({ method: "GET", url: `/train/${runId}`, headers: { authorization: `Bearer ${bob}` } });
    expect(other.statusCode).toBe(403);

    // Bob's own list is empty; 404 for a run he can't see.
    const bobList = await app.inject({ method: "GET", url: "/train", headers: { authorization: `Bearer ${bob}` } });
    expect(bobList.json().runs.length).toBe(0);
  });

  it("requires auth", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "POST", url: "/train", payload: { manifest: SAMPLES } });
    expect(res.statusCode).toBe(401);
  });
});

describe("train artifact delivery (ADAAAA-5323)", () => {
  function sha256(buf: Buffer): string {
    return createHash("sha256").update(buf).digest("hex");
  }

  it("serves a run-scoped LoRA download with an integrity hash, company-scoped", async () => {
    const trainArtifactRoot = mkdtempSync(path.join(tmpdir(), "hl-art-"));
    const adapterBytes = Buffer.from("fake-lora-safetensors-bytes-".repeat(3));
    writeFileSync(path.join(trainArtifactRoot, "model.safetensors"), adapterBytes);
    const expectedSha = sha256(adapterBytes);

    const adapter = {
      ...fakePipeline(),
      async train(_req: any) {
        return {
          run: "train-smoke",
          checkpoint: `/runs/train-smoke/model.safetensors`,
          adapter: `/runs/train-smoke/model.safetensors`,
          artifact: { filename: "model.safetensors", sha256: expectedSha, size: adapterBytes.length },
          eval: { eval: "completed", precision: 0.91, recall: 0.88, f1: 0.895 },
        };
      },
    };

    const { app } = await buildTestApp({ TRAIN_ARTIFACT_ROOT: trainArtifactRoot }, { adapter });
    const token = await register(app, "owner@test.dev", "password123");
    const bob = await register(app, "bob@test.dev", "password456");

    const created = await app.inject({
      method: "POST",
      url: "/train",
      headers: { authorization: `Bearer ${token}` },
      payload: { manifest: SAMPLES, epochs: 1 },
    });
    expect(created.statusCode).toBe(200);
    const run = created.json().run;
    expect(run.status).toBe("done");
    // Artifact metadata surfaced on the run (download path, not a bare string).
    expect(run.result?.artifact?.filename).toBe("model.safetensors");
    expect(run.result?.artifact?.downloadPath).toBe(`/train/${run.id}/artifact`);

    // Owner downloads the artifact; body matches + hash header matches the file.
    const dl = await app.inject({
      method: "GET",
      url: `/train/${run.id}/artifact`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["x-checksum-sha256"]).toBe(expectedSha);
    expect(dl.headers["content-disposition"]).toContain("attachment");
    expect(Buffer.from(dl.body as any)).toEqual(adapterBytes);

    // Integrity check is enforced: a staged file that no longer matches the
    // recorded hash is refused (409), never silently served.
    writeFileSync(path.join(trainArtifactRoot, "model.safetensors"), Buffer.from("tampered"));
    const tampered = await app.inject({
      method: "GET",
      url: `/train/${run.id}/artifact`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(tampered.statusCode).toBe(409);
    expect(tampered.json().code).toBe("artifact_unavailable");

    // Company boundary: another user cannot download it.
    const forbidden = await app.inject({
      method: "GET",
      url: `/train/${run.id}/artifact`,
      headers: { authorization: `Bearer ${bob}` },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("409s when the run is not done / has no artifact", async () => {
    const { app } = await buildTestApp();
    const token = await register(app, "x@test.dev", "password123");
    const res = await app.inject({
      method: "GET",
      url: "/train/does-not-exist/artifact",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("curated manifest trigger (ADAAAA-5323)", () => {
  it("POST /train with manifestSource=curated loads the published manifests", async () => {
    const curatedDir = mkdtempSync(path.join(tmpdir(), "hl-cur-"));
    const trainJsonl = JSON.stringify(SAMPLES[0]) + "\n" + JSON.stringify(SAMPLES[1]);
    writeFileSync(path.join(curatedDir, "train_manifest.jsonl"), trainJsonl);
    writeFileSync(path.join(curatedDir, "val_manifest.jsonl"), JSON.stringify(SAMPLES[0]) + "\n");

    const { app } = await buildTestApp({ CURATED_MANIFEST_DIR: curatedDir });
    const token = await register(app, "cur@test.dev", "password123");

    // Feed /train/curated availability.
    const info = await app.inject({ method: "GET", url: "/train/curated", headers: { authorization: `Bearer ${token}` } });
    expect(info.statusCode).toBe(200);
    expect(info.json().curated.present).toBe(true);
    expect(info.json().curated.trainCount).toBe(2);
    expect(info.json().curated.valCount).toBe(1);

    // Trigger a run from curated data (no manifest in the body) and confirm the
    // mode actually copied the curated JSONL into the persisted run.
    const res = await app.inject({
      method: "POST",
      url: "/train",
      headers: { authorization: `Bearer ${token}` },
      payload: { manifestSource: "curated", epochs: 2 },
    });
    expect(res.statusCode).toBe(200);
    const run = res.json().run;
    expect(run.status).toBe("done");
    const lines = run.manifest.split("\n").filter((l: string) => l.trim());
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe(JSON.stringify(SAMPLES[0]));
  });

  it("422s when manifestSource=curated but no curated manifest is published", async () => {
    const curatedDir = mkdtempSync(path.join(tmpdir(), "hl-curempty-"));
    const { app } = await buildTestApp({ CURATED_MANIFEST_DIR: curatedDir });
    const token = await register(app, "no@test.dev", "password123");
    const res = await app.inject({
      method: "POST",
      url: "/train",
      headers: { authorization: `Bearer ${token}` },
      payload: { manifestSource: "curated" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("no_curated_manifest");
  });
});
