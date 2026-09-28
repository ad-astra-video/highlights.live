// End-to-end test for ADAAAA-5396 (Change 3): server-DB persistence of a sent
// dataset and its plan-gated retrieval.
//
//  1. A valid dataset SENT via POST /training/manifests is persisted to the
//     server DB and survives — it is listed (GET /datasets) and retrievable
//     (GET /datasets/:id) for the owning account on an ACTIVE paid plan,
//     independent of any in-memory state (a fresh app/session can re-read it).
//  2. Retrieval is denied (403) for a starter (free) account and for a
//     deactivated paid account (pro / canceled or past_due).
//  3. Company scope: only the owner (or admin) can read a saved dataset; a
//     different user gets 403.
import { describe, it, expect, afterEach } from "vitest";
import { buildTestApp, type TestApp } from "./helpers";
import { DetectionTrainingSampleSchema, type DetectionTrainingSample } from "@highlights/events";

const apps: TestApp[] = [];
afterEach(async () => {
  for (const t of apps) await t.app.close();
  apps.length = 0;
});

function sample(id: string, label: string): DetectionTrainingSample {
  return DetectionTrainingSampleSchema.parse({
    id,
    imageRef: `data/training/extract/b1/frame_${id}.jpg`,
    width: 1280,
    height: 720,
    objects: [{ label, bbox: [0.1, 0.2, 0.3, 0.4] }],
  });
}

async function register(t: TestApp, email: string): Promise<{ id: string; token: string }> {
  const r = await t.app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email, password: "password123" },
  });
  expect(r.statusCode).toBe(200);
  const body = r.json();
  return { id: body.user.id, token: body.token };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("dataset persistence + plan-gated retrieval (ADAAAA-5396 C3)", () => {
  it("persists a sent dataset and makes it retrievable across sessions for a paid active account", async () => {
    const t = await buildTestApp();
    apps.push(t);
    const { id, token } = await register(t, "paid@test.dev");
    // Activate a paid (pro) subscription — this is the "active non-starter plan".
    await t.db.setSubscription(id, { tier: "pro", status: "active" });

    const sent = await t.app.inject({
      method: "POST",
      url: "/training/manifests",
      headers: auth(token),
      payload: {
        train: [sample("a", "player"), sample("b", "soccer ball")],
        val: [sample("c", "goal")],
      },
    });
    expect(sent.statusCode).toBe(200);
    const sentBody = sent.json();
    expect(sentBody.ok).toBe(true);
    expect(sentBody.dataset).toBeDefined();
    expect(sentBody.dataset.trainCount).toBe(2);
    expect(sentBody.dataset.valCount).toBe(1);
    // imageRefs flattened + deduped from train+val samples
    expect(sentBody.dataset.imageRefs).toEqual([
      "data/training/extract/b1/frame_a.jpg",
      "data/training/extract/b1/frame_b.jpg",
      "data/training/extract/b1/frame_c.jpg",
    ]);
    const datasetId = sentBody.dataset.id;

    // Survives "reload + new session": the record is in the DB, not memory.
    const fromDb = await t.db.getDataset(datasetId);
    expect(fromDb).toBeDefined();
    expect(fromDb!.ownerId).toBe(id);
    expect(fromDb!.train).toHaveLength(2);
    expect(fromDb!.val).toHaveLength(1);

    // List + single retrieval for the paid active owner.
    const list = await t.app.inject({
      method: "GET",
      url: "/datasets",
      headers: auth(token),
    });
    expect(list.statusCode).toBe(200);
    const listed = list.json().datasets;
    expect(listed.some((d: any) => d.id === datasetId)).toBe(true);

    const one = await t.app.inject({
      method: "GET",
      url: `/datasets/${datasetId}`,
      headers: auth(token),
    });
    expect(one.statusCode).toBe(200);
    expect(one.json().dataset.id).toBe(datasetId);
    expect(one.json().dataset.train).toHaveLength(2);
  });

  it("denies retrieval (403) for a starter (free) account and a deactivated paid account", async () => {
    const t = await buildTestApp();
    apps.push(t);

    // Pro active account sends a dataset.
    const owner = await register(t, "owner@test.dev");
    await t.db.setSubscription(owner.id, { tier: "pro", status: "active" });
    const sent = await t.app.inject({
      method: "POST",
      url: "/training/manifests",
      headers: auth(owner.token),
      payload: { train: [sample("x", "player")], val: [] },
    });
    expect(sent.statusCode).toBe(200);
    const datasetId = sent.json().dataset.id;

    // Same owner, now on the STARTER plan (free active) -> denied.
    await t.db.setSubscription(owner.id, { tier: "free", status: "active" });
    const starter = await t.app.inject({
      method: "GET",
      url: `/datasets/${datasetId}`,
      headers: auth(owner.token),
    });
    expect(starter.statusCode).toBe(403);
    expect(starter.json().code).toBe("paid_plan_required");

    // Back to paid but DEACTIVATED (canceled) -> denied.
    await t.db.setSubscription(owner.id, { tier: "pro", status: "canceled" });
    const cancelled = await t.app.inject({
      method: "GET",
      url: `/datasets/${datasetId}`,
      headers: auth(owner.token),
    });
    expect(cancelled.statusCode).toBe(403);

    // past_due (deactivated) -> denied for list too.
    await t.db.setSubscription(owner.id, { tier: "pro", status: "past_due" });
    const pastDueList = await t.app.inject({
      method: "GET",
      url: "/datasets",
      headers: auth(owner.token),
    });
    expect(pastDueList.statusCode).toBe(403);

    // Re-activate paid -> retrievable again (the record was never lost).
    await t.db.setSubscription(owner.id, { tier: "pro", status: "active" });
    const again = await t.app.inject({
      method: "GET",
      url: `/datasets/${datasetId}`,
      headers: auth(owner.token),
    });
    expect(again.statusCode).toBe(200);
  });

  it("enforces owner scope: another account cannot read the dataset (403)", async () => {
    const t = await buildTestApp();
    apps.push(t);

    const owner = await register(t, "owner2@test.dev");
    await t.db.setSubscription(owner.id, { tier: "pro", status: "active" });
    const other = await register(t, "other@test.dev");
    await t.db.setSubscription(other.id, { tier: "pro", status: "active" });

    const sent = await t.app.inject({
      method: "POST",
      url: "/training/manifests",
      headers: auth(owner.token),
      payload: { train: [sample("z", "player")], val: [] },
    });
    const datasetId = sent.json().dataset.id;

    const otherGet = await t.app.inject({
      method: "GET",
      url: `/datasets/${datasetId}`,
      headers: auth(other.token),
    });
    expect(otherGet.statusCode).toBe(403);
    // The other user's own list is empty.
    const otherList = await t.app.inject({
      method: "GET",
      url: "/datasets",
      headers: auth(other.token),
    });
    expect(otherList.statusCode).toBe(200);
    expect(otherList.json().datasets).toEqual([]);

    // Unknown id -> 404.
    const nf = await t.app.inject({
      method: "GET",
      url: "/datasets/does-not-exist",
      headers: auth(owner.token),
    });
    expect(nf.statusCode).toBe(404);
  });
});
