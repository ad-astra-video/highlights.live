// 30-day retention purge on paid-plan deactivation (ADAAAA-5391 C4 / ADAAAA-5398).
// Proves end to end:
//   1. Deactivation (dev wireframe + Stripe webhook) schedules purging_at = T+30d
//      on the account's stored datasets.
//   2. Retrieval is denied immediately at deactivation (C3 gate), independent
//      of the 30-day data GC.
//   3. The retention purge sweep deletes the DB row + stored objects at T+30d
//      and records it in the dataset_purge_log (QA-observable run/purge log).
import { describe, it, expect } from "vitest";
import { mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { buildTestApp } from "./helpers";
import { Store } from "../src/store";
import { BillingService } from "../src/billing";
import { EntitlementsService } from "../src/entitlements";
import {
  PURGE_GRACE_MS,
  datasetAccessActive,
  scheduleDatasetsPurgeForOwner,
  selectPurgeCandidates,
  runDatasetPurgeSweep,
  datasetStoragePaths,
} from "../src/dataset-lifecycle";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date();

function sample(imageRef: string) {
  return {
    id: `s-${imageRef}`,
    imageRef,
    width: 1280,
    height: 720,
    objects: [{ label: "player", bbox: [0.1, 0.1, 0.5, 0.5] }],
  };
}

function seedRecord(
  id: string,
  ownerId: string,
  opts: { bucket?: string | null; purgingAt?: string | null; trainPath?: string | null; valPath?: string | null } = {}
) {
  return {
    id,
    ownerId,
    name: "seed",
    bucket: opts.bucket ?? null,
    trainPath: opts.trainPath ?? null,
    valPath: opts.valPath ?? null,
    trainCount: 1,
    valCount: 1,
    createdAt: new Date(now.getTime() - 2 * DAY).toISOString(),
    purgingAt: opts.purgingAt ?? null,
  };
}

async function register(app: any, email: string) {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "password123" } });
  expect(r.statusCode).toBe(200);
  return r.json().token as string;
}

describe("dataset access gate (ADAAAA-5391 C3)", () => {
  it("active non-starter allows access; starter/canceled/past_due deny immediately", () => {
    expect(datasetAccessActive({ tier: "pro", status: "active" } as any)).toBe(true);
    expect(datasetAccessActive({ tier: "pro", status: "trialing" } as any)).toBe(true);
    expect(datasetAccessActive({ tier: "pro", status: "canceled" } as any)).toBe(false);
    expect(datasetAccessActive({ tier: "pro", status: "past_due" } as any)).toBe(false);
    expect(datasetAccessActive({ tier: "free", status: "active" } as any)).toBe(false);
    expect(datasetAccessActive(null)).toBe(false);
  });
});

describe("30-day purge scheduling on deactivation (ADAAAA-5398 C4)", () => {
  it("wireframe deactivate sets purging_at = T+30d on stored datasets and denies retrieval immediately", async () => {
    const app = await buildTestApp({ BILLING_WIREFRAME: "1" });
    try {
      const { app: fastify, store, db } = app;
      const token = await register(fastify, "u-c4wire@test.dev");
      const auth = { authorization: `Bearer ${token}` };

      // Upgrade to Pro (active non-starter) so dataset storage is allowed.
      const up = await fastify.inject({ method: "POST", url: "/dev/billing/activate", headers: auth, payload: { plan: "pro" } });
      expect(up.statusCode).toBe(200);

      // Persist a dataset while active non-starter -> retrievable (200).
      const created = await fastify.inject({
        method: "POST",
        url: "/datasets",
        headers: auth,
        payload: { name: "my-dataset", train: [sample("bucket-t/frame_a.jpg")], val: [sample("bucket-t/frame_b.jpg")] },
      });
      expect(created.statusCode).toBe(201);
      const ds = created.json();
      expect(ds.purgingAt).toBeNull();

      const before = await fastify.inject({ method: "GET", url: `/datasets/${ds.id}`, headers: auth });
      expect(before.statusCode).toBe(200);

      // Deactivate -> purging_at = deactivation + 30d, retrieval denied.
      const deact = await fastify.inject({ method: "POST", url: "/dev/billing/deactivate", headers: auth });
      expect(deact.statusCode).toBe(200);

      const scheduled = store.getDataset(ds.id)!;
      const expected = new Date(now.getTime() + PURGE_GRACE_MS).getTime();
      expect(scheduled.purgingAt).toBeTruthy();
      expect(Math.abs(Date.parse(scheduled.purgingAt!) - expected)).toBeLessThan(60_000);

      const after = await fastify.inject({ method: "GET", url: `/datasets/${ds.id}`, headers: auth });
      expect(after.statusCode).toBe(403);
      const list = await fastify.inject({ method: "GET", url: "/datasets", headers: auth });
      expect(list.statusCode).toBe(403);

      // Persisted on disk too (survives reload via Db).
      expect((await db.getDataset(ds.id))!.purgingAt).toBeTruthy();
    } finally {
      await app.app.close();
    }
  }, 30000);

  it("Stripe customer.subscription.deleted webhook schedules 30-day purge via onPlanDeactivated", async () => {
    // BillingService.enabled needs STRIPE_SECRET_KEY + STRIPE_PRICE_PRO and
    // handleWebhook requires STRIPE_WEBHOOK_SECRET before it will construct.
    const app = await buildTestApp({
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      STRIPE_PRICE_PRO: "price_pro",
    });
    try {
      const { store, cfg, db } = app;
      await store.saveDataset({ ...seedRecord("d-web", "user-w"), bucket: "b-web" } as any);
      let fired = 0;
      const billing = new BillingService(
        cfg,
        db,
        // Stripe-like stub whose webhook re-emits a deleted-subscription event.
        {
          customers: { create: async () => ({ id: "cus" }) },
          checkout: { sessions: { create: async () => ({ url: "x" }) } },
          billingPortal: { sessions: { create: async () => ({ url: "x" }) } },
          subscriptionItems: { createUsageRecord: async () => ({}) },
          subscriptions: { retrieve: async () => ({ status: "canceled", current_period_end: 0, items: { data: [] } }) },
          webhooks: {
            constructEvent: () => ({
              type: "customer.subscription.deleted",
              data: { object: { id: "sub_1", metadata: { userId: "user-w" } } },
            }),
          },
        },
        new EntitlementsService(db, cfg),
        {
          onPlanDeactivated: async (userId) => {
            fired++;
            await scheduleDatasetsPurgeForOwner(store, userId);
          },
        }
      );
      const res = await billing.handleWebhook("{}", "sig");
      expect(res.handled).toBe("customer.subscription.deleted");
      expect(fired).toBe(1);
      const sched = store.getDataset("d-web")!;
      expect(sched.purgingAt).toBeTruthy();
      expect(Math.abs(Date.parse(sched.purgingAt!) - (now.getTime() + PURGE_GRACE_MS))).toBeLessThan(60_000);
    } finally {
      await app.app.close();
    }
  }, 15000);
});

describe("30-day retention purge sweep (ADAAAA-5398 C4)", () => {
  async function seedStored(store: Store, cfg: any, id: string, purgingAt: string) {
    await store.saveDataset({
      ...seedRecord(id, "u-purge", { bucket: `bucket-${id}`, purgingAt, trainPath: null, valPath: null }),
    } as any);
    // Create real stored objects: the frame bucket + per-dataset manifests dir.
    const bucketDir = path.join(cfg.dataDir, "training", "extract", `bucket-${id}`);
    await mkdir(bucketDir, { recursive: true });
    await writeFile(path.join(bucketDir, "frame_0001.jpg"), Buffer.alloc(1024 * 50, 1));
    const dsDir = path.join(cfg.dataDir, "training", "datasets", id);
    await mkdir(dsDir, { recursive: true });
    await writeFile(path.join(dsDir, "train_manifest.jsonl"), "{\"sample\":true}\n");
  }

  it("candidates are EXACTLY datasets whose purging_at has elapsed (not future / not active)", async () => {
    const app = await buildTestApp();
    try {
      const { store, cfg } = app;
      const past = new Date(now.getTime() - DAY).toISOString(); // T+30d already passed
      const future = new Date(now.getTime() + DAY).toISOString(); // still inside grace
      await seedStored(store, cfg, "due1", past);
      await seedStored(store, cfg, "fut1", future);
      // Active dataset, no purge scheduled.
      await store.saveDataset({ ...seedRecord("active1", "u-purge", { bucket: "b-active" }), purgingAt: null } as any);

      const cands = selectPurgeCandidates(store, now).map((d) => d.id).sort();
      expect(cands).toEqual(["due1"]);
    } finally {
      await app.app.close();
    }
  });

  it("run-mode deletes DB row + stored objects at T+30d and appends a purge-log entry", async () => {
    const app = await buildTestApp();
    try {
      const { store, cfg, db } = app;
      await seedStored(store, cfg, "purge-ds", new Date(now.getTime() - DAY).toISOString());
      const ds = store.getDataset("purge-ds")!;
      const paths = datasetStoragePaths(cfg, ds);
      const sampleFile = path.join(cfg.dataDir, "training", "extract", "bucket-purge-ds", "frame_0001.jpg");
      expect((await stat(sampleFile)).size).toBeGreaterThan(0);

      const report = await runDatasetPurgeSweep(store, db, cfg, { now });

      expect(report.candidates).toBe(1);
      expect(report.datasetsPurged).toBe(1);
      expect(report.objectsRemoved).toBe(paths.length);
      expect(store.getDataset("purge-ds")).toBeUndefined();
      expect(await db.getDataset("purge-ds")).toBeUndefined();
      await expect(stat(sampleFile)).rejects.toThrow();

      // QA-observable run/purge log: one entry, reason plan_deactivated_30d.
      const log = await db.listDatasetPurgeLog();
      const entry = log.find((l) => l.datasetId === "purge-ds");
      expect(entry).toBeTruthy();
      expect(entry!.reason).toBe("plan_deactivated_30d");
      expect(entry!.dryRun).toBe(false);
      expect(entry!.objectsRemoved.length).toBe(paths.length);
    } finally {
      await app.app.close();
    }
  });

  it("dry-run enumerates candidates and deletes nothing", async () => {
    const app = await buildTestApp();
    try {
      const { store, cfg, db } = app;
      await seedStored(store, cfg, "dry-ds", new Date(now.getTime() - DAY).toISOString());
      const report = await runDatasetPurgeSweep(store, db, cfg, { now, dryRun: true });
      expect(report.candidates).toBe(1);
      expect(report.datasetsPurged).toBe(0);
      expect(report.dryRun).toBe(true);
      expect(store.getDataset("dry-ds")).toBeDefined();
    } finally {
      await app.app.close();
    }
  });

  it("a future purging_at (within the 30-day grace) and a null one are never purged", async () => {
    const app = await buildTestApp();
    try {
      const { store, cfg, db } = app;
      const future = new Date(now.getTime() + DAY).toISOString();
      await seedStored(store, cfg, "grace-ds", future);
      await store.saveDataset({ ...seedRecord("still-active", "u-purge", { bucket: "b2" }), purgingAt: null } as any);
      const report = await runDatasetPurgeSweep(store, db, cfg, { now });
      expect(report.candidates).toBe(0);
      expect(report.datasetsPurged).toBe(0);
      expect(store.getDataset("grace-ds")).toBeDefined();
      expect(store.getDataset("still-active")).toBeDefined();
    } finally {
      await app.app.close();
    }
  });
});
