import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  FactMemory,
  embedFact,
  tokenizeFact,
  isSalient,
  cosine,
  RETRIEVAL_TOP_K,
  MEMORY_MAX_FACTS,
} from "../src/fact-memory";

// --- embedding / core ---------------------------------------------------------

describe("fact-memory embedding (CPU, plan §C)", () => {
  it("embeds deterministically and L2-normalizes (|v| == 1)", () => {
    const a = embedFact("player #9 (red) booked at 34:00");
    const b = embedFact("player #9 (red) booked at 34:00");
    expect(a).toEqual(b); // deterministic across calls
    let norm = 0;
    for (const x of a) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
  });

  it("similar facts score higher than unrelated facts (semantic-ish geometry)", () => {
    const q = embedFact("yellow card for player nine in red");
    const near = embedFact("player #9 (red) booked with a yellow card");
    const far = embedFact("keeper makes a double save to keep the lead");
    expect(cosine(q, near)).toBeGreaterThan(cosine(q, far));
  });

  it("tokenizeFact keeps words + digits, drops noise", () => {
    const t = tokenizeFact("player #9 (red) 34:00!");
    expect(t).toContain("player");
    expect(t).toContain("9");
    expect(t).toContain("red");
    // "34" and "00" both survive as numeric tokens (time/scoreboard signal)
    expect(t).toContain("34");
  });
});

// --- salience gate (plan §C noise-trigger protection) --------------------------

describe("FactMemory salience gate", () => {
  it("ingests a confirmed highlight regardless of score", () => {
    const m = new FactMemory();
    const e = m.ingestIfSalient(
      { timestamp: 2000, factText: "highlight GOAL: ball in net", type: "highlight" },
      { confirmed: true, score: 40 }
    );
    expect(e).not.toBeNull();
    expect(m.size).toBe(1);
  });

  it("ingests a high score or salient event type even when not confirmed", () => {
    const m = new FactMemory();
    expect(m.ingestIfSalient({ timestamp: 1, factText: "x" }, { score: 80 })).not.toBeNull();
    expect(m.ingestIfSalient({ timestamp: 2, factText: "y" }, { eventType: "CARD" })).not.toBeNull();
    expect(m.ingestIfSalient({ timestamp: 3, factText: "z" }, { hasOcr: true })).not.toBeNull();
    expect(m.size).toBe(3);
  });

  it("rejects a bare low-score / non-salient firing (the noise trigger)", () => {
    const m = new FactMemory();
    expect(isSalient({ score: 5, eventType: "audio_gate" })).toBe(false);
    expect(m.ingestIfSalient({ timestamp: 1, factText: "n" }, { score: 5, eventType: "audio_gate" })).toBeNull();
    expect(m.size).toBe(0);
  });

  it("bounds the store to MEMORY_MAX_FACTS (no growth on long streams)", () => {
    const m = new FactMemory();
    for (let i = 0; i < MEMORY_MAX_FACTS + 50; i++)
      m.ingest({ timestamp: i, factText: `fact about play at ${i}s`, type: "fact" });
    expect(m.size).toBe(MEMORY_MAX_FACTS);
  });
});

// --- retrieval (plan §C / A3) -------------------------------------------------

describe("FactMemory retrieval", () => {
  it("returns ranked top-k matches, most similar first", () => {
    const m = new FactMemory();
    m.ingest({ timestamp: 10, factText: "player #9 (red) booked yellow card" });
    m.ingest({ timestamp: 20, factText: "keeper makes a double save" });
    m.ingest({ timestamp: 30, factText: "penalty converted by #10" });
    const hits = m.query("yellow card for player number nine red", 3);
    expect(hits.length).toBe(3);
    expect(hits[0].fact.factText).toContain("booked yellow card");
    expect(hits[0].similarity).toBeGreaterThanOrEqual(hits[1].similarity);
  });

  it("returns [] from an empty store", () => {
    expect(new FactMemory().query("anything", 3)).toEqual([]);
  });

  it("retrievedContextText returns '' when store empty or query blank", () => {
    const m = new FactMemory();
    expect(m.retrievedContextText("some window")).toBe("");
    m.ingest({ timestamp: 1, factText: "a fact" });
    expect(m.retrievedContextText("")).toBe("");
  });

  it("caps the retrieved context block at RETRIEVED_CONTEXT_MAX_CHARS", () => {
    const m = new FactMemory();
    for (let i = 0; i < 200; i++)
      m.ingest({ timestamp: i, factText: `highlight GOAL with a very long reason text ${"pad".repeat(20)} at ${i}s` });
    const text = m.retrievedContextText("goal highlight reason", 5, 100);
    expect(text.length).toBeLessThanOrEqual(100 + 1); // +1 for ellipsis
  });
});

// --- labeled retrieval eval (plan A3: precision@k >= 0.80) --------------------

describe("ADAAAA-6031 plan A3 — labeled retrieval eval", () => {
  // Load the labeled eval set (same file the handoff will reference).
  const manifestUrl = new URL("../../../evals/fact-memory-label-manifest.json", import.meta.url);
  const manifest = JSON.parse(readFileSync(fileURLToPath(manifestUrl), "utf8"));
  const topK = manifest.acceptance.topK ?? RETRIEVAL_TOP_K;

  it("fact-memory retrieval precision@k meets the >= 80% acceptance bar", () => {
    const m = new FactMemory();
    for (const f of manifest.facts) {
      m.ingest({
        id: f.id,
        timestamp: f.timestamp,
        factText: f.factText,
        type: "fact",
        eventType: f.eventType,
      });
    }
    let totalHits = 0;
    let totalSlots = 0;
    for (const q of manifest.queries) {
      const relevant = new Set(q.relevant);
      const hits = m.query(q.queryText, topK).map((h) => h.fact.id);
      // precision@k = |retrieved ∩ relevant| / k over ALL queries
      for (const id of hits) if (relevant.has(id)) totalHits++;
      totalSlots += topK;
    }
    const precision = totalHits / totalSlots;
    // A3 acceptance: retrieval precision@k >= 80%
    expect(precision).toBeGreaterThanOrEqual(manifest.acceptance.retrievalPrecisionAtKMin);
    // Record the measured value for the handoff.
    (expect.getState as any).note = precision;
  });

  it("reports the measured precision@k value", () => {
    const m = new FactMemory();
    for (const f of manifest.facts) m.ingest({ id: f.id, timestamp: f.timestamp, factText: f.factText, type: "fact" });
    let totalHits = 0;
    let totalSlots = 0;
    for (const q of manifest.queries) {
      const relevant = new Set(q.relevant);
      const hits = m.query(q.queryText, topK).map((h) => h.fact.id);
      for (const id of hits) if (relevant.has(id)) totalHits++;
      totalSlots += topK;
    }
    // eslint-disable-next-line no-console
    console.log(
      `\n[A3] fact-memory retrieval on labeled set: ${totalHits}/${totalSlots} slots = ${((totalHits / totalSlots) * 100).toFixed(1)}% precision@${topK}`
    );
    expect(totalSlots).toBeGreaterThan(0);
  });
});
