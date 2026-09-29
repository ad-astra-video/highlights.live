// C — In-memory vector DB of prior-window facts (long-horizon memory, plan §C).
//
// Per-stream/job in-memory store of HIGH-SIGNAL stream facts from at/outside
// the 60 s window. Entries are `{ timestamp, factText, embedding, type,
// entityRef, eventType }`. Ingestion is salience-gated (only confirmed
// highlights / high-confidence facts are embedded — NOT every audio-gate
// firing), so the store stays small and the decide prompt's prior context
// stays clean (protects noise-trigger reliability).
//
// EMBEDDING (A6 cost control): a small deterministic CPU-side embedding — a
// normalized token-vector weighted by inverse document frequency over the
// current store. It is NOT a GPU model and makes no network/Livepeer call — the
// main Livepeer-cost control in the design. Retrieval is cosine similarity over
// L2-normalized vectors (a dot product): microseconds in memory, bounded by a
// small top-k, so it never blocks the paid decision path (A5).
//
// IDF is computed over the stored facts AT QUERY TIME so fact + query vectors
// are scored with the SAME weighting (deterministic, symmetric, no stale-state
// drift). The store is small and retrieval happens only at decide time, so this
// recompute is trivial (~tens of µs for a few hundred facts).
//
// The decide contract already carries `priorContext` (the 60 s window facts,
// plan §B). This module appends a bounded `retrieved` block of long-horizon
// facts so the model sees "player #9 (red) booked at 34:00" from earlier in
// the same stream (the whole-picture / yellow→red narrative).

// --- Embedding -----------------------------------------------------------------

export const EMBED_DIM = 1024;

/** Deterministic FNV-1a 32-bit hash (stable across runs/processes). */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Lowercase word / number tokens of `text` (numbers kept — they carry the
 * player/scoreboard signal). */
export function tokenizeFact(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 || /[0-9]/.test(t));
}

/** Build an idf(term) map over `docTokens`: log(N / df) + 1 smoothing (same
 * shape as standard IDF, floor at 1 so a term seen in every doc is not 0). */
export function buildIdf(docTokens: string[][]): Map<string, number> {
  const n = docTokens.length;
  const df = new Map<string, number>();
  for (const toks of docTokens) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const idf = new Map<string, number>();
  for (const [t, f] of df) idf.set(t, Math.log((n + 1) / (1 + f)) + 1);
  return idf;
}

/** Embed `text` as an L2-normalized IDF-weighted token vector (dim 1024).
 * Feature-hash of each token, signed by the hash bits so collisions cancel
 * into a real cosine geometry. Cheap, deterministic, no GPU/network. */
export function embedFact(text: string, idf: Map<string, number> = new Map(), dim: number = EMBED_DIM): number[] {
  const vec = new Float64Array(dim);
  for (const t of tokenizeFact(text)) {
    const w = idf.get(t) ?? 1;
    const h = fnv1a("w:" + t);
    const idx = h % dim;
    vec[idx] += (h & 1 ? 1 : -1) * w;
  }
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return Array.from(vec);
}

/** Cosine similarity between two L2-normalized embeddings (a dot product). */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

// --- Salience + store ----------------------------------------------------------

/** Salience-gate thresholds (plan §C: only confirmed / high-confidence facts). */
export const SALIENT_HIGH_SCORE_MIN = 70;
/** Event types whose mere presence marks a fact high-confidence (card/OCR/sub/
 * goal-type events are the plan's named salient categories). */
const SALIENT_EVENT_RE = /goal|card|penalt|save|substitut|ocr|score|red|yellow/i;

/** A stored fact (entry shape from plan §C). */
export interface MemoryFact {
  id: string;
  timestamp: number;
  factText: string;
  embedding: number[];
  type: string; // "highlight" | "card" | "goal" | "sub" | "ocr" | "score" | "fact" | ...
  entityRef?: string;
  eventType?: string;
}

/** Salience context used by `isSalient`. */
export interface SalienceInput {
  confirmed?: boolean;
  score?: number;
  eventType?: string;
  hasOcr?: boolean;
}

/** Hard memory bound for the per-stream store (avoids unbounded growth on a
 * long VOD pass / live session). Oldest facts are evicted first. */
export const MEMORY_MAX_FACTS = 200;
/** Small bounded top-k for retrieval (plan §C: "small top-k"). */
export const RETRIEVAL_TOP_K = 5;
/** Token-cost cap for the retrieved long-horizon block injected into the
 * decide prompt (A6: per-decision token-cost increase bounded). */
export const RETRIEVED_CONTEXT_MAX_CHARS = 1600;

/**
 * Salience gate (plan §C): true only for confirmed highlights and
 * high-confidence facts. A bare audio-gate / scene-change firing with no score
 * and no salient event type is NOT embedded — that is the noise-trigger
 * reliability protection and the reason the store stays small.
 */
export function isSalient(input: SalienceInput): boolean {
  if (input.confirmed) return true;
  const score = typeof input.score === "number" ? input.score : 0;
  if (score >= SALIENT_HIGH_SCORE_MIN) return true;
  if (input.hasOcr) return true;
  const et = (input.eventType || "").toLowerCase();
  return SALIENT_EVENT_RE.test(et);
}

/** Bounded in-memory vector store (one per stream/job - owned by LiveRunShared). */
export class FactMemory {
  private facts: MemoryFact[] = [];
  private readonly max: number;

  constructor(max: number = MEMORY_MAX_FACTS) {
    this.max = max;
  }

  get size(): number {
    return this.facts.length;
  }

  clear(): void {
    this.facts = [];
  }

  /** The current store's IDF map (over stored fact texts) — used symmetrically
   * for both fact and query embeddings at retrieval time. */
  private idf(): Map<string, number> {
    return buildIdf(this.facts.map((f) => tokenizeFact(f.factText)));
  }

  /** Ingest a fact. `embedding` is computed here (CPU) against the CURRENT
   * store IDF. Returns the stored entry, or null when the store is empty/cap
   * (cap eviction keeps size bounded). */
  ingest(fact: {
    timestamp: number;
    factText: string;
    type?: string;
    entityRef?: string;
    eventType?: string;
    /** Optional caller-supplied id (used by the labeled eval set). When
     * omitted a per-entry id is generated. */
    id?: string;
  }): MemoryFact | null {
    const idf = this.idf();
    const entry: MemoryFact = {
      id: fact.id ?? `mem-${fact.timestamp}-${fact.type ?? "fact"}`,
      timestamp: fact.timestamp,
      factText: fact.factText,
      embedding: embedFact(fact.factText, idf),
      type: fact.type ?? "fact",
      entityRef: fact.entityRef,
      eventType: fact.eventType,
    };
    this.facts.push(entry);
    if (this.facts.length > this.max) this.facts.shift();
    return entry;
  }

  /** Salience-gated ingest: embeds + stores only when `isSalient(context)`. */
  ingestIfSalient(
    fact: { timestamp: number; factText: string; type?: string; entityRef?: string; eventType?: string; id?: string },
    context: SalienceInput
  ): MemoryFact | null {
    if (!isSalient(context)) return null;
    return this.ingest(fact);
  }

  /** Retrieve top-k facts most similar to `queryText`, ranked by cosine over
   * the CURRENT store IDF (fact + query vectors share the same weighting). */
  query(queryText: string, k: number = RETRIEVAL_TOP_K): { fact: MemoryFact; similarity: number }[] {
    if (!this.facts.length) return [];
    const idf = this.idf();
    const q = embedFact(queryText, idf);
    const scored = this.facts.map((f) => ({ fact: f, similarity: cosine(q, embedFact(f.factText, idf)) }));
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, k);
  }

  /**
   * Assemble the retrieved long-horizon block as bounded text for the decide
   * prompt's prior context. Ranks facts most similar to `currentWindowText`
   * (the 60 s window summary being decided on). Returns "" when the store is
   * empty / query blank, and is hard-capped at `maxChars` (A6 token bound).
   */
  retrievedContextText(currentWindowText: string, k: number = RETRIEVAL_TOP_K, maxChars: number = RETRIEVED_CONTEXT_MAX_CHARS): string {
    if (!this.facts.length || !currentWindowText.trim()) return "";
    const hits = this.query(currentWindowText, k);
    if (!hits.length) return "";
    const lines = hits.map(
      (h) =>
        `[t=${h.fact.timestamp.toFixed(1)}s] ${h.fact.factText}` +
        (h.fact.entityRef ? ` (${h.fact.entityRef})` : "")
    );
    let text = lines.join("\n");
    if (text.length > maxChars) text = text.slice(0, maxChars) + "…";
    return text;
  }
}
