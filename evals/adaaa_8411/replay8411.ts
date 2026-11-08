// ADAAAA-8411 — re-runnable $0 proof for the AC4 residual (Phase D FAIL).
//
// Run inside a highlights-server container (tsx + the deployed @highlights/events):
//
//   docker cp evals/adaaa_8411/replay8411.ts highlights-server:/app/replay8411.ts
//   docker exec -w /app highlights-server ./node_modules/.bin/tsx replay8411.ts 755fd1f5-babc-44b3-803e-452ae64bcc9c
//
// Section A replays the WRITE seam (`storedSurfaceFor`, the same derivation
// `acceptVideoDecision` runs) over every stored `decide_audit` row of the job and
// censuses the stored caption: empty / present / present-but-equal-to-the-title.
// Section B reads the stage the customer sees — the same projections the detail
// route serves (`projectPostTitle` + `projectAnnouncerCaption`) over the job's
// stored highlights — and prints the caption census, which is the number AC4
// grades. CPU only, no decide call, no leg: $0.
import pg from "pg";

import {
  projectAnnouncerCaption,
  projectPostTitle,
  postTitleTeamSubject,
  storedSurfaceFor,
} from "@highlights/events";

const JOB_PREFIX = (process.argv[2] ?? "755fd1f5").slice(0, 8);

async function sqlRows(sql: string): Promise<Record<string, string>[]> {
  const client = pg.Client ? new pg.Client({ connectionString: process.env.DATABASE_URL }) : null;
  if (!client) throw new Error("no pg client");
  await client.connect();
  try {
    const res = await client.query(sql);
    return res.rows as Record<string, string>[];
  } finally {
    await client.end();
  }
}

function parseReply(raw: string): any {
  if (!raw) return null;
  const text = raw.trim().replace(/^```(?:json)?|```$/gm, "").trim();
  const i = text.indexOf("{");
  const j = text.lastIndexOf("}");
  if (i < 0 || j < 0) return null;
  try {
    return JSON.parse(text.slice(i, j + 1));
  } catch {
    return null;
  }
}

async function main() {
  const audit = await sqlRows(
    `select id, raw_reply, prompt_text from decide_audit where job_id like '${JOB_PREFIX}%' order by created_at`
  );
  // ---- A. the WRITE seam over every stored decide row ----------------------
  const writeCensus = { rows: 0, captioned: 0, empty: 0, sameAsTitle: 0, factCopies: [] as string[] };
  for (const r of audit) {
    const o = parseReply(r.raw_reply ?? "");
    if (!o) continue;
    const verdict = String(o.outcome ?? "").toLowerCase();
    const surface: any = storedSurfaceFor(
      { reason: o.reason, postTitle: o.postTitle, outcome: o.outcome, eventType: o.eventType } as never,
      {
        verdict,
        eventType: o.eventType ?? null,
        promptText: r.prompt_text ?? "",
        corroborated: verdict === "scoring_play" ? true : null,
      } as never
    );
    const caption = String(surface.caption ?? "").trim();
    const title = String(surface.postTitle ?? "").trim();
    writeCensus.rows += 1;
    if (caption) writeCensus.captioned += 1;
    else writeCensus.empty += 1;
    if (caption && title && caption === title) writeCensus.sameAsTitle += 1;
    if (caption && caption !== String(surface.reason ?? "").trim()) {
      writeCensus.factCopies.push(`${r.id.split("::")[1] ?? r.id}: ${caption}`);
    }
  }
  console.log("A. write seam", JSON.stringify(writeCensus, null, 1));

  // ---- B. the SERVED surface (the stage AC4 grades) ------------------------
  const hlRows = await sqlRows(
    `select id, record::text as record from highlights where job_id like '${JOB_PREFIX}%'`
  );
  const rows = hlRows
    .map((r) => ({ id: r.id, ...(JSON.parse(r.record ?? "{}") as any) }))
    .filter((h) => h && h.outcome);
  let degrade = 0;
  let served = 0;
  let model = 0;
  for (const h of rows) {
    const title = projectPostTitle({ ...h, reasonRaw: h.reason_raw ?? null } as never, {
      subject: postTitleTeamSubject({ ...h, reasonRaw: h.reason_raw ?? null } as never, null),
    });
    const caption = projectAnnouncerCaption({ ...h, reasonRaw: h.reason_raw ?? null } as never, title);
    served += 1;
    if (caption.trim() === title.trim()) degrade += 1;
    if (h.postTitle) model += 1;
    console.log(
      `  ${h.id.slice(0, 8)} ${String(h.outcome).padEnd(13)} title=${JSON.stringify(title)} caption=${JSON.stringify(caption)}${
        caption.trim() === title.trim() ? "  <-- DEGRADE" : ""
      }`
    );
  }
  console.log(
    `B. served rows=${served} non-degrade=${served - degrade}/${served} degrad=${degrade} model-title=${model} deterministic-title=${served - model}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
