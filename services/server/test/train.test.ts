import { describe, it, expect } from "vitest";
import { buildTestApp } from "./helpers";

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
