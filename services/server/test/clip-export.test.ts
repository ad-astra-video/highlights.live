import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildTestApp } from "./helpers";
import type { TestApp } from "./helpers";

// ADAAAA-7896: export-aware reject lock.
//
// AC1  playback GETs never mark; ONE export-URL GET marks, same bytes (len+sha256)
// AC2  first write wins (re-fetch + later copy intent leave the stamp alone),
//      exactly one `clip_exported` usage row
// AC3  owner reject of an exported clip -> 409 clip_exported, status unchanged,
//      no ledger debit, rejectedAt unset; non-exported clip still rejects 200
// AC4  admin reject of an exported owner clip -> 200, stamp retained,
//      rejectedAfterExport true, OWNER ledger -1 / admin ledger unchanged
// AC5  (webapp) copy marks only on clipboard success — see JobDetail.posting.test.ts
// AC6  bounded batch intent marks all ids (`batch_zip` / `copy_urls`)
// AC7  token for clip A on clip B refused; tampered token refused; plain URL works
//
// These tests are pure API-level: no perceive/analyzer/decide/Livepeer path is
// touched, so the run costs 0 GPU seconds by construction.

const BYTES_A = Buffer.from("clip-a-bytes-0123456789-export-equality");
const BYTES_B = Buffer.from("clip-b-bytes-different-length-xyz");

function periodKey(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function register(app: any, email: string, pw = "password123"): Promise<{ token: string; id: string }> {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: pw } });
  expect(r.statusCode).toBe(200);
  const token = r.json().token as string;
  const me = await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}` } });
  expect(me.statusCode).toBe(200);
  return { token, id: me.json().user.id };
}

async function adminToken(app: any, cfg: any): Promise<string> {
  const r = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: cfg.adminEmail, password: cfg.adminPassword },
  });
  expect(r.statusCode).toBe(200);
  return r.json().token as string;
}

/** Write the bytes a highlight's clipUri points at, and persist the highlight
 * owned by `ownerId` under `jobId` (status accepted so reject transitions are
 * real transitions). */
async function seedClip(
  t: TestApp,
  opts: { id: string; jobId: string; ownerId: string; bytes: Buffer; filename?: string; start?: number }
): Promise<{ id: string; clipUri: string; file: string }> {
  const filename = opts.filename ?? `${opts.id}.mp4`;
  const dir = path.join(t.cfg.dataDir, "clips");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, filename);
  writeFileSync(file, opts.bytes);
  const clipUri = `/clips/${filename}`;
  const start = opts.start ?? 10;
  await t.store.addHighlight({
    id: opts.id,
    ownerId: opts.ownerId,
    jobId: opts.jobId,
    clipUri,
    start,
    end: start + 20,
    eventType: "GOAL",
    // The postable projection keeps only scoring plays (`outcome`), so a seeded
    // clip must declare one to appear in `GET /jobs/:id/detail`.
    outcome: "scoring_play",
    score: 90,
    status: "accepted",
    createdAt: new Date().toISOString(),
  });
  return { id: opts.id, clipUri, file };
}

async function detailFor(app: any, jobId: string, token: string): Promise<any> {
  const r = await app.inject({
    method: "GET",
    url: `/jobs/${jobId}/detail`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(r.statusCode).toBe(200);
  return r.json();
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("export-aware reject lock (ADAAAA-7896)", () => {
  it("AC1: playback URL never marks; ONE export URL GET marks `download` and serves identical bytes", async () => {
    const t = await buildTestApp();
    const user = await register(t.app, "ac1@test.dev");
    const job = await t.store.createJob({ ownerId: user.id, source: "file" });
    const clip = await seedClip(t, { id: "h-ac1", jobId: job.id, ownerId: user.id, bytes: BYTES_A });

    // Two plain playback fetches (public, no token) -> no export state.
    for (let i = 0; i < 2; i++) {
      const p = await t.app.inject({ method: "GET", url: clip.clipUri });
      expect(p.statusCode).toBe(200);
      expect(p.rawPayload.equals(BYTES_A)).toBe(true);
    }
    expect(t.store.getHighlight(clip.id)?.exportedAt).toBeUndefined();

    // The projection delivers the distinct export URL (server-minted token).
    const detail = await detailFor(t.app, job.id, user.token);
    const proj = detail.highlights.find((h: any) => h.id === clip.id);
    expect(typeof proj.exportUri).toBe("string");
    expect(proj.exportUri.startsWith(clip.clipUri)).toBe(true);
    expect(proj.exportUri).toContain("x=");

    const exp = await t.app.inject({ method: "GET", url: proj.exportUri });
    expect(exp.statusCode).toBe(200);
    const after = t.store.getHighlight(clip.id)!;
    expect(after.exportedAt).toBeTruthy();
    expect(after.exportedVia).toBe("download");

    // Same bytes: length + sha256 of playback vs export.
    const play = await t.app.inject({ method: "GET", url: clip.clipUri });
    expect(exp.rawPayload.length).toBe(play.rawPayload.length);
    expect(sha(exp.rawPayload)).toBe(sha(play.rawPayload));
    console.log(`[AC1] playback len=${play.rawPayload.length} sha256=${sha(play.rawPayload)}`);
    console.log(`[AC1] export   len=${exp.rawPayload.length} sha256=${sha(exp.rawPayload)}`);
    console.log(`[AC1] exportedAt=${after.exportedAt} exportedVia=${after.exportedVia}`);
    await t.app.close();
  });

  it("AC2: first stamp wins on re-fetch + later copy intent; exactly one clip_exported row", async () => {
    const t = await buildTestApp();
    const user = await register(t.app, "ac2@test.dev");
    const job = await t.store.createJob({ ownerId: user.id, source: "file" });
    const clip = await seedClip(t, { id: "h-ac2", jobId: job.id, ownerId: user.id, bytes: BYTES_A });
    const detail = await detailFor(t.app, job.id, user.token);
    const exportUri = detail.highlights.find((h: any) => h.id === clip.id).exportUri;

    await t.app.inject({ method: "GET", url: exportUri });
    const first = t.store.getHighlight(clip.id)!;
    expect(first.exportedAt).toBeTruthy();
    expect(first.exportedVia).toBe("download");

    // Second fetch of the same export URL is idempotent (no overwrite).
    const second = await t.app.inject({ method: "GET", url: exportUri });
    expect(second.statusCode).toBe(200);
    // A later copy_link intent must ALSO leave the earliest stamp alone.
    const intent = await t.app.inject({
      method: "POST",
      url: `/highlights/${clip.id}/export-intent`,
      headers: { authorization: `Bearer ${user.token}` },
      payload: { via: "copy_link" },
    });
    expect(intent.statusCode).toBe(200);

    const after = t.store.getHighlight(clip.id)!;
    expect(after.exportedAt).toBe(first.exportedAt);
    expect(after.exportedVia).toBe("download");
    expect(await t.db.countUsage(user.id, "clip_exported")).toBe(1);
    console.log(`[AC2] exportedAt kept=${after.exportedAt} via=${after.exportedVia} usageRows=1`);
    await t.app.close();
  });

  it("AC3: owner reject of an exported clip -> 409 clip_exported, no debit; non-exported clip rejects 200", async () => {
    const t = await buildTestApp();
    const user = await register(t.app, "ac3@test.dev");
    const job = await t.store.createJob({ ownerId: user.id, source: "file" });

    // A generated clip has already debited the owner's ledger: model that.
    const period = periodKey();
    await t.db.incrementQuota(user.id, period);
    const ledger = async (token: string) =>
      (await t.app.inject({ method: "GET", url: "/billing/status", headers: { authorization: `Bearer ${token}` } })).json();

    const exported = await seedClip(t, { id: "h-ac3-exp", jobId: job.id, ownerId: user.id, bytes: BYTES_A });
    const intent = await t.app.inject({
      method: "POST",
      url: `/highlights/${exported.id}/export-intent`,
      headers: { authorization: `Bearer ${user.token}` },
      payload: { via: "copy_link" },
    });
    expect(intent.statusCode).toBe(200);
    const before = await ledger(user.token);
    expect(before.clipQuotaUsed).toBe(1);

    const rej = await t.app.inject({
      method: "POST",
      url: `/highlights/${exported.id}/review`,
      headers: { authorization: `Bearer ${user.token}` },
      payload: { status: "rejected" },
    });
    expect(rej.statusCode).toBe(409);
    const body = rej.json();
    expect(body.error).toBe("clip_exported");
    expect(body.exportedAt).toBe(t.store.getHighlight(exported.id)!.exportedAt);
    expect(body.exportedVia).toBe("copy_link");
    expect(typeof body.message).toBe("string");

    const rec = t.store.getHighlight(exported.id)!;
    expect(rec.status).toBe("accepted");
    expect(rec.rejectedAt).toBeUndefined();
    const after = await ledger(user.token);
    expect(after.clipQuotaUsed).toBe(before.clipQuotaUsed); // no debit released

    // The same reject on a NON-exported clip still succeeds and releases the slot.
    const plain = await seedClip(t, { id: "h-ac3-plain", jobId: job.id, ownerId: user.id, bytes: BYTES_B });
    const okRej = await t.app.inject({
      method: "POST",
      url: `/highlights/${plain.id}/review`,
      headers: { authorization: `Bearer ${user.token}` },
      payload: { status: "rejected" },
    });
    expect(okRej.statusCode).toBe(200);
    expect(okRej.json().status).toBe("rejected");
    expect((await ledger(user.token)).clipQuotaUsed).toBe(before.clipQuotaUsed - 1);
    console.log(`[AC3] 409 exportedAt=${body.exportedAt} via=${body.exportedVia}; owner ledger ${before.clipQuotaUsed} -> ${after.clipQuotaUsed}; non-exported reject 200`);
    await t.app.close();
  });

  it("AC4: admin reject of an exported owner clip -> 200, stamp kept, rejectedAfterExport, OWNER ledger -1", async () => {
    const t = await buildTestApp();
    const user = await register(t.app, "ac4@test.dev");
    const admin = await adminToken(t.app, t.cfg);
    const job = await t.store.createJob({ ownerId: user.id, source: "file" });
    const period = periodKey();
    await t.db.incrementQuota(user.id, period);

    const clip = await seedClip(t, { id: "h-ac4", jobId: job.id, ownerId: user.id, bytes: BYTES_A });
    const intent = await t.app.inject({
      method: "POST",
      url: `/highlights/${clip.id}/export-intent`,
      headers: { authorization: `Bearer ${user.token}` },
      payload: { via: "download" },
    });
    // `download` is only set by the URL path — the intent route refuses it.
    expect(intent.statusCode).toBe(422);
    const detail = await detailFor(t.app, job.id, user.token);
    const exportUri = detail.highlights.find((h: any) => h.id === clip.id).exportUri;
    expect((await t.app.inject({ method: "GET", url: exportUri })).statusCode).toBe(200);
    const stamped = t.store.getHighlight(clip.id)!;
    expect(stamped.exportedVia).toBe("download");

    const status = async (token: string) =>
      (await t.app.inject({ method: "GET", url: "/billing/status", headers: { authorization: `Bearer ${token}` } })).json();
    const ownerBefore = await status(user.token);
    const adminBefore = await status(admin);

    const rej = await t.app.inject({
      method: "POST",
      url: `/highlights/${clip.id}/review`,
      headers: { authorization: `Bearer ${admin}` },
      payload: { status: "rejected" },
    });
    expect(rej.statusCode).toBe(200);
    expect(rej.json().status).toBe("rejected");
    const rec = t.store.getHighlight(clip.id)!;
    expect(rec.exportedAt).toBe(stamped.exportedAt);
    expect(rec.exportedVia).toBe("download");
    expect(rec.rejectedAfterExport).toBe(true);

    const ownerAfter = await status(user.token);
    const adminAfter = await status(admin);
    expect(ownerAfter.clipQuotaUsed).toBe(ownerBefore.clipQuotaUsed - 1);
    expect(adminAfter.clipQuotaUsed).toBe(adminBefore.clipQuotaUsed);
    console.log(`[AC4] owner ledger ${ownerBefore.clipQuotaUsed} -> ${ownerAfter.clipQuotaUsed}; admin ledger ${adminBefore.clipQuotaUsed} -> ${adminAfter.clipQuotaUsed}; rejectedAfterExport=${rec.rejectedAfterExport} exportedAt=${rec.exportedAt}`);
    await t.app.close();
  });

  it("AC6: bounded batch intent marks all 5 ids (batch_zip / copy_urls) and manifest URLs are export URLs", async () => {
    const t = await buildTestApp();
    const user = await register(t.app, "ac6@test.dev");
    const job = await t.store.createJob({ ownerId: user.id, source: "file" });
    const ids = ["b1", "b2", "b3", "b4", "b5"];
    const clips = [];
    for (let i = 0; i < ids.length; i++) {
      clips.push(await seedClip(t, { id: `h-${ids[i]}`, jobId: job.id, ownerId: user.id, bytes: BYTES_A, start: 100 * i }));
    }

    const batch = await t.app.inject({
      method: "POST",
      url: "/highlights/export-intent",
      headers: { authorization: `Bearer ${user.token}` },
      payload: { ids: clips.map((c) => c.id), via: "batch_zip" },
    });
    expect(batch.statusCode).toBe(200);
    expect(batch.json().marked.sort()).toEqual(clips.map((c) => c.id).sort());
    expect(batch.json().skipped).toEqual([]);
    for (const c of clips) {
      const rec = t.store.getHighlight(c.id)!;
      expect(rec.exportedVia).toBe("batch_zip");
      expect(rec.exportedAt).toBeTruthy();
    }

    // A second selection marked by "Copy URLs".
    const more = [];
    for (const [i, id] of ["c1", "c2", "c3", "c4", "c5"].entries()) {
      more.push(await seedClip(t, { id: `h-${id}`, jobId: job.id, ownerId: user.id, bytes: BYTES_B, start: 1000 + 100 * i }));
    }
    const copyUrls = await t.app.inject({
      method: "POST",
      url: "/highlights/export-intent",
      headers: { authorization: `Bearer ${user.token}` },
      payload: { ids: more.map((c) => c.id), via: "copy_urls" },
    });
    expect(copyUrls.statusCode).toBe(200);
    expect(copyUrls.json().marked.sort()).toEqual(more.map((c) => c.id).sort());
    for (const c of more) expect(t.store.getHighlight(c.id)!.exportedVia).toBe("copy_urls");

    // The projection the batch manifest is built from carries export URLs.
    const detail = await detailFor(t.app, job.id, user.token);
    for (const c of [...clips, ...more]) {
      const proj = detail.highlights.find((h: any) => h.id === c.id);
      expect(proj.exportUri).toContain("x=");
    }

    // The bounded call refuses an oversized selection.
    const tooMany = await t.app.inject({
      method: "POST",
      url: "/highlights/export-intent",
      headers: { authorization: `Bearer ${user.token}` },
      payload: { ids: Array.from({ length: 51 }, (_, i) => `x${i}`), via: "copy_urls" },
    });
    expect(tooMany.statusCode).toBe(422);
    console.log(`[AC6] batch_zip ids=${clips.map((c) => `${c.id}@${t.store.getHighlight(c.id)!.exportedAt}`).join(", ")}`);
    console.log(`[AC6] copy_urls ids=${more.map((c) => `${c.id}@${t.store.getHighlight(c.id)!.exportedAt}`).join(", ")}`);
    await t.app.close();
  });

  it("AC7: token for clip A on clip B refused, tampered token refused, plain playback still serves", async () => {
    const t = await buildTestApp();
    const user = await register(t.app, "ac7@test.dev");
    const job = await t.store.createJob({ ownerId: user.id, source: "file" });
    const a = await seedClip(t, { id: "h-ac7-a", jobId: job.id, ownerId: user.id, bytes: BYTES_A, filename: "a.mp4" });
    const b = await seedClip(t, { id: "h-ac7-b", jobId: job.id, ownerId: user.id, bytes: BYTES_B, filename: "b.mp4", start: 200 });
    const detail = await detailFor(t.app, job.id, user.token);
    const exportA = detail.highlights.find((h: any) => h.id === a.id).exportUri;
    const tokenA = new URL(exportA, "http://x").searchParams.get("x")!;

    // Token A replayed on clip B's path.
    const cross = await t.app.inject({ method: "GET", url: `/clips/b.mp4?x=${encodeURIComponent(tokenA)}` });
    expect([403, 404]).toContain(cross.statusCode);
    expect(t.store.getHighlight(b.id)!.exportedAt).toBeUndefined();
    expect(t.store.getHighlight(a.id)!.exportedAt).toBeUndefined();

    // Tampered signature.
    const tampered = await t.app.inject({ method: "GET", url: `${exportA.slice(0, -2)}xy` });
    expect([403, 404]).toContain(tampered.statusCode);
    expect(t.store.getHighlight(a.id)!.exportedAt).toBeUndefined();

    // Garbage token on a real file.
    const garbage = await t.app.inject({ method: "GET", url: `/clips/a.mp4?x=not-a-token` });
    expect([403, 404]).toContain(garbage.statusCode);

    // Plain playback (no token) still serves, still no marking.
    const plain = await t.app.inject({ method: "GET", url: a.clipUri });
    expect(plain.statusCode).toBe(200);
    expect(plain.rawPayload.equals(BYTES_A)).toBe(true);
    expect(t.store.getHighlight(a.id)!.exportedAt).toBeUndefined();

    // A token for a file with no highlight at all is refused, no marking.
    writeFileSync(path.join(t.cfg.dataDir, "clips", "orphan.mp4"), BYTES_A);
    const orphan = await t.app.inject({ method: "GET", url: `/clips/orphan.mp4?x=${encodeURIComponent(tokenA)}` });
    expect([403, 404]).toContain(orphan.statusCode);

    console.log(`[AC7] cross=${cross.statusCode} tampered=${tampered.statusCode} garbage=${garbage.statusCode} plain=${plain.statusCode} orphan=${orphan.statusCode}; no marks`);
    await t.app.close();
  });

  it("export-intent refuses another user's highlight (403, no mark)", async () => {
    const t = await buildTestApp();
    const owner = await register(t.app, "owner-7896@test.dev");
    const other = await register(t.app, "other-7896@test.dev");
    const job = await t.store.createJob({ ownerId: owner.id, source: "file" });
    const clip = await seedClip(t, { id: "h-foreign", jobId: job.id, ownerId: owner.id, bytes: BYTES_A });

    const res = await t.app.inject({
      method: "POST",
      url: `/highlights/${clip.id}/export-intent`,
      headers: { authorization: `Bearer ${other.token}` },
      payload: { via: "copy_link" },
    });
    expect(res.statusCode).toBe(403);
    expect(t.store.getHighlight(clip.id)!.exportedAt).toBeUndefined();

    const batch = await t.app.inject({
      method: "POST",
      url: "/highlights/export-intent",
      headers: { authorization: `Bearer ${other.token}` },
      payload: { ids: [clip.id], via: "copy_urls" },
    });
    expect(batch.statusCode).toBe(200);
    expect(batch.json().marked).toEqual([]);
    expect(batch.json().skipped).toEqual([clip.id]);
    expect(t.store.getHighlight(clip.id)!.exportedAt).toBeUndefined();
    await t.app.close();
  });
});
