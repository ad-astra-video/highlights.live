// ADAAAA-8405 — re-runnable $0 proof for the PO ship bar (S1-S5).
//
// Run inside a highlights-server container (tsx + the deployed @highlights/events):
//
//   docker cp evals/adaaa_8405/replay8405.ts highlights-server:/app/replay8405.ts
//   docker exec -w /app highlights-server ./node_modules/.bin/tsx replay8405.ts
//
// Section A replays the WRITE gate (`gatePostTitleDetail`) over the 255 stored
// `raw_reply` titles from legs 6dc48814 / cbdfa4af / db6cbb11 / 15622b2d and
// prints, per defect class, what the gate did with each measured offender.
// Section B replays the READ gate (`projectPostTitle`) over every stored row that
// carries a `postTitleGate` token and prints the SERVED title + the S1/S2/S3/S5
// bars and the S4 caption census. CPU only, no decide call: $0.
/**
 * ADAAAA-8405 — $0 replay of the deterministic validators over STORED rows.
 *
 * PO ruling 2026-11-08: no GPU leg. Everything is provable from the rows the
 * post-deploy legs already wrote:
 *
 *   A. the WRITE gate (`gatePostTitleDetail`) over the 255 stored `raw_reply`
 *      titles from legs 6dc48814 / cbdfa4af / db6cbb11 / 15622b2d, per defect
 *      class: what the gate does with each measured offender;
 *   B. the READ gate (`projectPostTitle` -> `servedPostTitleViolations`) over
 *      the 13 stored post-deploy highlight rows: the SERVED title per row and
 *      the S1/S2/S3/S5 bars;
 *   C. the S4 caption census on those rows (stored `caption` empty / equal to
 *      `postTitle`), which the seam fixture proves for new rows.
 *
 * Runs inside `highlights-server` (tsx + the deployed @highlights/events source)
 * so it grades the SHIPPED code, not a copy: `$0`, CPU only, no decide call.
 */
import pg from "pg";

import {
  gatePostTitleDetail,
  postTitleShapeViolations,
  projectPostTitle,
  servedPostTitleViolations,
  hasGoalClaim,
  groundNames,
} from "@highlights/events";

const LEGS = ["6dc48814", "cbdfa4af", "db6cbb11", "15622b2d"];

async function sqlRows(sql: string): Promise<Record<string, string>[]> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const res = await client.query(sql);
    return res.rows as Record<string, string>[];
  } finally {
    await client.end();
  }
}

function _unusedPsqlCsv(sql: string): Record<string, string>[] {
  const out = "";
  // minimal CSV parse with quoted fields
  const rows: string[][] = [];
  let field = "";
  let line: string[] = [];
  let quoted = false;
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (quoted) {
      if (c === '"' && out[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { line.push(field); field = ""; }
    else if (c === "\n") { line.push(field); rows.push(line); line = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || line.length) { line.push(field); rows.push(line); }
  const head = rows.shift() ?? [];
  return rows.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

function parseReply(raw: string): any {
  if (!raw) return null;
  const text = raw.trim().replace(/^```(?:json)?|```$/gm, "").trim();
  const i = text.indexOf("{");
  const j = text.lastIndexOf("}");
  if (i < 0 || j < 0) return null;
  try { return JSON.parse(text.slice(i, j + 1)); } catch { return null; }
}

const PLACE = /\b(?:in|at|on|from|near|inside|around|into)\s+(?:the\s+)?(?:penalty\s+area|box|goal\s+area|six[- ]yard|cent(?:er|re)|midfield|middle\s+third|final\s+third|attacking\s+third|defensive\s+third|near\s+post|far\s+post|touchline|wing|halves?|half|side|edge\s+of\s+the|left|right)\b/i;
const CLAIM = /\b(scores?|scored|scoring|goal|gol|net|equaliz\w*|levels?|leads?|wins?|ahead|\d{1,2}\s*[-–]\s*\d{1,2})\b/i;

async function main() {
  // ---- A. write gate over the 255 stored emitted titles ----------------------
  const titleRows = await sqlRows(
    `select a.job_id, a.raw_reply, a.prompt_text from decide_audit a
     where (${LEGS.map((l) => `a.job_id like '${l}%'`).join(" or ")})
       and a.raw_reply like '%postTitle%'
     order by a.job_id, a.created_at`
  );
  const emit = [] as any[];
  const byClass = { place: [] as string[], claim: [] as string[], name: [] as string[] };
  for (const r of titleRows) {
    const obj = parseReply(r.raw_reply);
    const title = typeof obj?.postTitle === "string" ? obj.postTitle.trim() : "";
    if (!title) continue;
    const outcome = String(obj?.outcome ?? "").toLowerCase();
    const eventType = String(obj?.eventType ?? "");
    const ctx = { verdict: outcome, eventType, promptText: r.prompt_text ?? "", corroborated: false } as any;
    // the gate as the WRITE seam runs it (conservative corroboration: false)
    const gated = gatePostTitleDetail(title, ctx);
    const gatedCorrob = gatePostTitleDetail(title, { ...ctx, corroborated: true });
    const rec = {
      job: r.job_id.slice(0, 8),
      title,
      outcome,
      eventType,
      gate: gated.gate,
      gate_if_corroborated: gatedCorrob.gate,
      violations: gated.violations,
      gated_value: gated.title,
    };
    emit.push(rec);
    if (PLACE.test(title) || postTitleShapeViolations(title).includes("place-chain")) byClass.place.push(title);
    if (CLAIM.test(title) && outcome !== "scoring_play") byClass.claim.push(title);
    if (groundNames(title, r.prompt_text ?? "") !== title) byClass.name.push(title);
  }

  const census = (titles: string[]) => {
    const uniq = Array.from(new Set(titles));
    return { count: titles.length, distinct: uniq.length, titles: uniq };
  };

  // ---- B. read gate over the 13 stored post-deploy highlight rows -------------
  const hlRows = await sqlRows(
    `select h.id, h.record from highlights h
     where h.record like '%postTitleGate%'
     order by h.created_at`
  );
  const served = [] as any[];
  for (const r of hlRows) {
    const rec = JSON.parse(r.record);
    const row = {
      postTitle: rec.postTitle ?? null,
      caption: rec.caption ?? null,
      reason: rec.reason ?? null,
      reasonRaw: rec.reason_raw ?? null,
      eventType: rec.eventType ?? null,
      outcome: rec.outcome ?? null,
      localizedTs: rec.localizedTs ?? rec.start ?? null,
    };
    const servedTitle = projectPostTitle(row, { subject: "" });
    const violations = rec.postTitle ? servedPostTitleViolations(rec.postTitle, row) : [];
    served.push({
      id: r.id.slice(0, 8),
      eventType: rec.eventType,
      outcome: rec.outcome,
      stored: rec.postTitle ?? null,
      gate: rec.postTitleGate ?? null,
      served: servedTitle,
      served_is_stored: servedTitle === (rec.postTitle ?? null),
      violations,
      caption: rec.caption ?? null,
      caption_nonempty: !!String(rec.caption ?? "").trim(),
      caption_eq_title: String(rec.caption ?? "") === String(rec.postTitle ?? ""),
      claim_on_non_scoring: hasGoalClaim(servedTitle) && String(rec.outcome ?? "") !== "scoring_play",
      place_in_served: PLACE.test(servedTitle),
      words: servedTitle.split(/\s+/).length,
      chars: servedTitle.length,
    });
  }

  const postable = served.filter((s) => s.outcome === "scoring_play" || s.outcome === "near_miss");

  console.log("=== A. WRITE gate over emitted titles ===");
  console.log(JSON.stringify({
    legs: LEGS,
    rows: titleRows.length,
    titles_parsed: emit.length,
    place_phrases: census(byClass.place),
    claims_on_non_scoring: census(byClass.claim),
    names_absent_from_copy: census(byClass.name),
    gate_census_all: emit.reduce((acc: Record<string, number>, e) => {
      acc[e.gate] = (acc[e.gate] ?? 0) + 1;
      return acc;
    }, {}),
    gate_census_if_corroborated: emit.reduce((acc: Record<string, number>, e) => {
      acc[e.gate_if_corroborated] = (acc[e.gate_if_corroborated] ?? 0) + 1;
      return acc;
    }, {}),
    // every measured offender and what the gate did with it
    offenders: emit.filter((e) => e.gate !== "accepted" || PLACE.test(e.title) || (CLAIM.test(e.title) && e.outcome !== "scoring_play")),
  }, null, 1));

  console.log("=== B. READ gate over the stored post-deploy highlight rows ===");
  console.log(JSON.stringify({
    rows: served.length,
    stored_titles: served.filter((s) => s.stored).length,
    served_from_model: served.filter((s) => s.served_is_stored).length,
    served_deterministic: served.filter((s) => !s.served_is_stored).length,
    s1_place_in_served: served.filter((s) => s.place_in_served).length,
    s2_claim_on_non_scoring: served.filter((s) => s.claim_on_non_scoring).length,
    s3_ungrounded_name_refused: served.filter((s) => s.violations.includes("ungrounded-name")).length,
    s5_over_70_chars: served.filter((s) => s.chars > 70).length,
    s5_over_10_words: served.filter((s) => s.words > 10).length,
    s5_t_plus: served.filter((s) => /^T\s*\+/i.test(s.served)).length,
    rows_detail: served,
    postable_cards: postable.length,
    s4_postable_with_non_degrade_caption: postable.filter((s) => s.caption_nonempty && !s.caption_eq_title).length,
  }, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
