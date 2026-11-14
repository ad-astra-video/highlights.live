// ADAAAA-8973 (Inc 5): `GET /jobs/:id/frames` must be BOUNDED per poll.
//
// The Live Stage no-preview still polls this route every VOD_DETAIL_POLL_MS and
// used to transfer the WHOLE frame list (~93 B/frame, measured on a real job),
// so a live job page left open for an hour grew with session length. These are
// byte- and row-COUNT assertions against the real route (fastify inject), not
// prose:
//
//   AC5.1 — a job with >= 5,000 stored frames: one default poll <= 8 KB, and
//           `sinceSeq=<newest>` serves no rows and <= 300 B.
//   AC5.3 — a job with <= 300 frames serves the SAME payload as before the
//           change (field-for-field, all rows, same order).
//   AC5.4 — no new route name: the still path keeps using this one.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildTestApp } from "./helpers";

const SMALL_JOB = "small-300";
const SMALL_FRAMES = 300;
const LARGE_JOB = "large-5334";
/** The frame count the ticket measured: 5,334 frames = ~500 KB per poll before. */
const LARGE_FRAMES = 5334;

let app: any;
let token: string;

/** Write `n` empty JPEGs into the job's frame dir (the route only lists names). */
function seedFrames(dataDir: string, jobId: string, n: number): void {
  const dir = path.join(dataDir, "frames", jobId);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i += 1) writeFileSync(path.join(dir, `frame_${String(i + 1).padStart(6, "0")}.jpg`), "");
}

interface ServedFrame {
  seq: number;
  uri: string;
  timestamp: number | null;
}

async function getFrames(jobId: string, query = ""): Promise<{ status: number; rows: ServedFrame[]; bytes: number }> {
  const res = await app.inject({
    method: "GET",
    url: `/jobs/${jobId}/frames${query}`,
    headers: { authorization: `Bearer ${token}` },
  });
  const body = res.json() as { frames?: ServedFrame[] };
  return { status: res.statusCode, rows: body.frames ?? [], bytes: Buffer.byteLength(res.payload) };
}

beforeAll(async () => {
  const built = await buildTestApp();
  app = built.app;
  const cfg = built.cfg;
  // Admin-style registration (BETA_GATE is off in the test config).
  const reg = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email: "frames-window-8973@test.dev", password: "password123" },
  });
  expect(reg.statusCode).toBe(200);
  token = reg.json().token as string;
  seedFrames(cfg.dataDir, SMALL_JOB, SMALL_FRAMES);
  seedFrames(cfg.dataDir, LARGE_JOB, LARGE_FRAMES);
});

afterAll(async () => {
  await app?.close?.();
});

describe("AC5.1 — a >= 5,000-frame job polls bounded bytes", () => {
  it("one default poll is <= 8 KB and carries the LATEST window", async () => {
    const { status, rows, bytes } = await getFrames(LARGE_JOB);
    expect(status).toBe(200);
    // ~93 B/frame, so the whole list would be ~500 KB: prove the default is a
    // constant-size window, not O(frames).
    expect(bytes).toBeLessThanOrEqual(8192);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(50);
    // It is the LATEST window: the newest stored frame ends the list.
    expect(rows[rows.length - 1].seq).toBe(LARGE_FRAMES - 1);
    // Contiguous, ascending, and every row keeps the served shape.
    expect(rows[rows.length - 1].seq - rows[0].seq).toBe(rows.length - 1);
    expect(rows[0].uri).toBe(`/jobs/${LARGE_JOB}/frames/${rows[0].seq}`);
  });

  it("a caught-up poll (`sinceSeq` = newest) serves no rows and <= 300 B", async () => {
    const newest = LARGE_FRAMES - 1;
    const { status, rows, bytes } = await getFrames(LARGE_JOB, `?sinceSeq=${newest}`);
    expect(status).toBe(200);
    expect(rows).toEqual([]);
    expect(bytes).toBeLessThanOrEqual(300);
  });

  it("`afterSeq` is a synonym, and both serve strictly-newer rows only", async () => {
    const since = LARGE_FRAMES - 4;
    const bySince = await getFrames(LARGE_JOB, `?sinceSeq=${since}`);
    const byAfter = await getFrames(LARGE_JOB, `?afterSeq=${since}`);
    expect(bySince.rows.map((r) => r.seq)).toEqual([since + 1, since + 2, since + 3]);
    expect(byAfter.rows.map((r) => r.seq)).toEqual([since + 1, since + 2, since + 3]);
    // The incremental answer stays small too.
    expect(bySince.bytes).toBeLessThanOrEqual(8192);
  });

  it("`limit` overrides the default window (the frame debugger's filmstrip)", async () => {
    const { rows, bytes } = await getFrames(LARGE_JOB, "?limit=200");
    expect(rows.length).toBe(200);
    expect(rows[rows.length - 1].seq).toBe(LARGE_FRAMES - 1);
    expect(bytes).toBeLessThanOrEqual(200 * 200); // ~93 B/row + envelope
  });
});

describe("AC5.3 — a <= 300-frame job is unchanged field-for-field", () => {
  it("serves every row, in order, with the pre-change shape", async () => {
    const { status, rows, bytes } = await getFrames(SMALL_JOB);
    expect(status).toBe(200);
    expect(rows.length).toBe(SMALL_FRAMES);
    // The exact payload the route produced before ADAAAA-8973: every frame in
    // list order, `{seq, uri, timestamp}`, timestamp null when unobserved.
    const expected: ServedFrame[] = Array.from({ length: SMALL_FRAMES }, (_, seq) => ({
      seq,
      uri: `/jobs/${SMALL_JOB}/frames/${seq}`,
      timestamp: null,
    }));
    expect(rows).toEqual(expected);
    // And a cursor on a small job is not rejected either.
    const tail = await getFrames(SMALL_JOB, `?sinceSeq=${SMALL_FRAMES - 3}`);
    expect(tail.rows.map((r) => r.seq)).toEqual([SMALL_FRAMES - 2, SMALL_FRAMES - 1]);
    expect(bytes).toBeGreaterThan(0);
  });

  it("a job with no frame dir is still the same 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/jobs/no-such-job/frames",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
