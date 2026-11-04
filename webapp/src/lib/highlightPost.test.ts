import { describe, it, expect } from "vitest";
import {
  batchManifest,
  captionFromTitle,
  captionNarrative,
  clipFileName,
  clipUrl,
  highlightGrounding,
  highlightInstant,
  humanEventLabel,
  MAX_CAPTION_CHARS,
  momentRangeLabel,
  postTitles,
  suggestCaption,
} from "./highlightPost";
import { buildZip, crc32 } from "./zip";
import type { JobDetailHighlight, SummaryLogEntry } from "./jobDetail";

function hl(over: Partial<JobDetailHighlight> = {}): JobDetailHighlight {
  return {
    id: "hl-0000aaaa-bbbb",
    jobId: "job1",
    clipUri: "/clips/clip-1.mp4",
    start: 60,
    end: 80,
    eventType: "GOAL",
    score: 90,
    status: "accepted",
    createdAt: "2026-10-31T00:00:00Z",
    ...over,
  };
}

function entry(seq: number, windowTs: number, text: string): SummaryLogEntry {
  return { seq, ts: "2026-10-31T00:00:00Z", windowTs, text };
}

describe("clipUrl — public, absolute, no auth (ADAAAA-7622)", () => {
  it("resolves a relative clipUri against the page origin", () => {
    expect(clipUrl("/clips/abc.mp4", "https://highlights-server.dpn.gg")).toBe(
      "https://highlights-server.dpn.gg/clips/abc.mp4"
    );
  });

  it("adds the missing leading slash and normalises a trailing origin slash", () => {
    expect(clipUrl("clips/abc.mp4", "https://example.test/")).toBe("https://example.test/clips/abc.mp4");
  });

  it("passes an already-absolute URL through unchanged (never appends a token)", () => {
    expect(clipUrl("https://cdn.test/clips/abc.mp4", "https://example.test")).toBe(
      "https://cdn.test/clips/abc.mp4"
    );
    expect(clipUrl("/clips/abc.mp4", "https://example.test")).not.toContain("token");
  });

  it("returns an empty string for a missing clip", () => {
    expect(clipUrl("", "https://example.test")).toBe("");
  });
});

describe("caption seeding from the summary-log window (ADAAAA-7622)", () => {
  const log: SummaryLogEntry[] = [
    entry(1, 0, "Kick-off, both sides settling in."),
    entry(2, 68, "Argentina breaks the deadlock — the ball is in the net."),
    entry(3, 120, "Substitution for Brazil."),
  ];

  it("picks the window narrative at localizedTs, not the clip start", () => {
    const h = hl({ localizedTs: 69.4, start: 60 });
    expect(highlightInstant(h)).toBe(69.4);
    expect(captionNarrative(h, log)).toBe("Argentina breaks the deadlock — the ball is in the net.");
  });

  it("suggests a post caption from that narrative, with no internal prefix (ADAAAA-7881)", () => {
    expect(suggestCaption(hl({ localizedTs: 69.4 }), log)).toBe(
      "Argentina breaks the deadlock — the ball is in the net."
    );
  });

  it("falls back to the clip start when no localization instant exists", () => {
    // start 60 is closest to entry 2 (68) of the three windows.
    expect(captionNarrative(hl({ start: 60 }), log)).toBe(
      "Argentina breaks the deadlock — the ball is in the net."
    );
  });

  it("uses the highlight's own decide reason when the job has no summary log", () => {
    expect(suggestCaption(hl({ reason: "Ball crossed the line at the far post." }))).toBe(
      "Ball crossed the line at the far post."
    );
  });

  it("still yields a postable caption when nothing else is known", () => {
    expect(suggestCaption(hl({ eventType: undefined, reason: undefined }))).toBe(
      "A highlight was captured in this clip."
    );
  });
});

// ADAAAA-7881: the seed caption used to be an internal observe-log line
// ("GOAL · T+69s — <narrative>"). A caption is customer copy, so it must be one
// social-ready sentence with no pipeline codes in it.
const SCREAMING = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;

function assertPostCaption(caption: string) {
  expect(caption.length).toBeGreaterThan(0);
  expect(caption.length).toBeLessThanOrEqual(MAX_CAPTION_CHARS);
  expect(caption).not.toMatch(/\bT\+\s*\d/);
  expect(caption).not.toContain("·");
  expect(caption).not.toMatch(SCREAMING);
  expect(caption).not.toContain("outcome=");
  expect(caption).toMatch(/[.!?]$/);
}

describe("suggested caption — one social-ready sentence (ADAAAA-7881)", () => {
  const log: SummaryLogEntry[] = [
    entry(1, 0, "Kick-off, both sides settling in."),
    entry(2, 68, "Argentina breaks the deadlock — the ball is in the net."),
    entry(3, 120, "Substitution for Brazil."),
  ];
  // The deployed QA job d61e52f6 (moment 66eabac3, localizedTs 366.2) carries
  // the observe-log line below at its nearest window.
  const deployedLog: SummaryLogEntry[] = [
    entry(1, 363, "The action intensifies as the white-clad team pushes into the final third of the pitch."),
    entry(2, 366, "The action intensifies as the white-clad team pushes into the final third of the pitch."),
    entry(3, 369, "A shot is taken but the keeper collects it."),
  ];

  it("matches the real fixtures and stays inside every caption rule", () => {
    const captions = [
      suggestCaption(hl({ localizedTs: 69.4 }), log),
      suggestCaption(hl({ localizedTs: 366.2, start: 359.2, end: 374.2 }), deployedLog),
      suggestCaption(hl({ reason: "Ball crossed the line at the far post." })),
      suggestCaption(hl({ eventType: undefined, reason: undefined })),
    ];
    for (const caption of captions) assertPostCaption(caption);
    // Multi-sentence copy keeps only its first sentence.
    expect(captions[2]).toBe("Ball crossed the line at the far post.");
  });

  it("strips internal codes out of an observe-log line", () => {
    const internal: SummaryLogEntry[] = [
      entry(1, 70, "GOAL · T+69s — SPORTING_EVENT outcome=scoring_play, the striker finishes from close range."),
    ];
    const caption = suggestCaption(hl({ localizedTs: 69, eventType: "GOAL" }), internal);
    assertPostCaption(caption);
    expect(caption).not.toContain("GOAL");
    expect(caption).not.toContain("SPORTING_EVENT");
    expect(caption).toContain("the striker finishes from close range");
  });

  it("caps a long narrative at 180 characters on a word boundary", () => {
    // Name-free copy: the grounding gate (ADAAAA-7948) replaces an unsourced
    // proper name, so this test keeps the 180-char cap in focus.
    const long = `${"The winger keeps the ball deep in the corner ".repeat(6)}and finally shoots.`;
    const caption = suggestCaption(hl({ reason: long }));
    assertPostCaption(caption);
    // The last character of the body is a whole word, then the period.
    expect(caption.endsWith(".")).toBe(true);
    const body = caption.slice(0, -1);
    expect(long.startsWith(body)).toBe(true);
    expect(long.charAt(body.length)).toMatch(/[\s.]/);
  });

  it("is deterministic — same input, same caption", () => {
    const h = hl({ localizedTs: 69.4 });
    expect(suggestCaption(h, log)).toBe(suggestCaption(h, log));
  });
});

describe("post titles — 2-3 one-line candidates (ADAAAA-7881)", () => {
  const narrativeLog: SummaryLogEntry[] = [
    entry(1, 68, "Argentina breaks the deadlock — the ball is in the net."),
  ];

  function assertTitleSet(titles: string[]) {
    expect(titles.length).toBeGreaterThanOrEqual(2);
    expect(titles.length).toBeLessThanOrEqual(3);
    expect(new Set(titles).size).toBe(titles.length);
    for (const title of titles) {
      expect(title.length).toBeGreaterThanOrEqual(1);
      expect(title.length).toBeLessThanOrEqual(60);
      expect(title).not.toMatch(/[.,;:!?]$/);
    }
  }

  it("takes the narrative's leading clause, the label join and the reason clause", () => {
    const titles = postTitles(
      hl({ localizedTs: 69.4, reason: "The striker finishes from close range." }),
      narrativeLog
    );
    assertTitleSet(titles);
    expect(titles[0]).toBe("Argentina breaks the deadlock");
    expect(titles).toContain("Goal: Argentina breaks the deadlock");
    expect(titles).toContain("The striker finishes from close range");
  });

  it("handles a narrative with no punctuation", () => {
    const titles = postTitles(hl({ localizedTs: 69.4 }), [
      entry(1, 68, "Brazil pushes forward on the counter attack"),
    ]);
    assertTitleSet(titles);
    expect(titles[0]).toBe("Brazil pushes forward on the counter attack");
  });

  it("handles a narrative that already fits in 60 characters", () => {
    const titles = postTitles(hl({ localizedTs: 69.4 }), [entry(1, 68, "Argentina scores.")]);
    assertTitleSet(titles);
    expect(titles[0]).toBe("Argentina scores");
  });

  it("falls back to the decide reason when no narrative exists", () => {
    const titles = postTitles(hl({ reason: "Ball crossed the line at the far post." }));
    assertTitleSet(titles);
    expect(titles[0]).toBe("Ball crossed the line at the far post");
    expect(titles).toContain("Goal: Ball crossed the line at the far post");
  });

  it("still offers two titles when nothing is known", () => {
    const titles = postTitles(hl({ reason: undefined, eventType: undefined }));
    assertTitleSet(titles);
    expect(titles).toEqual(["Highlight", "Highlight moment"]);
  });

  it("never cuts a word when the narrative is longer than a title line", () => {
    const long = "The action intensifies as the white-clad team pushes into the final third of the pitch.";
    const titles = postTitles(hl({ reason: undefined }), [entry(1, 68, long)]);
    assertTitleSet(titles);
    const [first] = titles;
    expect(long.startsWith(`${first} `)).toBe(true);
  });

  it("`Use as caption` applies the title as a sentence", () => {
    expect(captionFromTitle("Argentina breaks the deadlock")).toBe("Argentina breaks the deadlock.");
    expect(captionFromTitle("Argentina breaks the deadlock.")).toBe("Argentina breaks the deadlock.");
    expect(captionFromTitle("")).toBe("");
  });
});

describe("human event labels (ADAAAA-7881)", () => {
  it("maps known pipeline enums to plain words", () => {
    expect(humanEventLabel("GOAL")).toBe("goal");
    expect(humanEventLabel("SPORTING_EVENT")).toBe("sporting moment");
    expect(humanEventLabel("NEAR_MISS")).toBe("near miss");
  });

  it("title-cases an unknown enum instead of leaking it", () => {
    expect(humanEventLabel("KILL_STREAK")).toBe("Kill Streak");
    expect(humanEventLabel("DUNK")).toBe("Dunk");
    expect(humanEventLabel(undefined)).toBe("highlight");
  });
});

describe("momentRangeLabel — the card's dominant identifier (ADAAAA-7881)", () => {
  it("renders the rounded time range the customer reads", () => {
    expect(momentRangeLabel(359.2, 374.2)).toBe("T+359s – T+374s");
    expect(momentRangeLabel(60, 80)).toBe("T+60s – T+80s");
  });
});

describe("clipFileName — collision-free archive entries", () => {
  it("labels by event type, timestamp and a short id", () => {
    expect(clipFileName(hl({ id: "aaaabbbb-cccc-dddd", localizedTs: 69.4 }))).toBe("goal-t69s-aaaabbbb.mp4");
  });

  it("never repeats for two clips of the same event at the same instant", () => {
    const a = clipFileName(hl({ id: "aaaa1111-x", localizedTs: 30 }));
    const b = clipFileName(hl({ id: "bbbb2222-x", localizedTs: 30 }));
    expect(a).not.toBe(b);
  });
});

describe("batchManifest — 5 clips, 5 URLs, 5 captions", () => {
  const items = Array.from({ length: 5 }, (_, i) => ({
    caption: `GOAL · T+${10 * i}s — clip ${i}`,
    url: `https://example.test/clips/c${i}.mp4`,
  }));

  it("emits one caption + one public URL per clip", () => {
    const text = batchManifest(items);
    expect(text).toContain("# Highlights batch — 5 clip(s)");
    for (let i = 0; i < 5; i += 1) {
      expect(text).toContain(`GOAL · T+${10 * i}s — clip ${i}`);
      expect(text).toContain(`https://example.test/clips/c${i}.mp4`);
    }
  });

  it("records a fetch failure next to the URL that still works", () => {
    const text = batchManifest([{ caption: "GOAL · T+1s", url: "https://example.test/clips/c.mp4", error: "HTTP 500" }]);
    expect(text).toContain("clip download failed (HTTP 500)");
    expect(text).toContain("https://example.test/clips/c.mp4");
  });
});

/** Parse a STORE-only archive far enough to prove it is a valid zip. */
function readZip(bytes: Uint8Array) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = bytes.length - 22;
  expect(dv.getUint32(endOffset, true)).toBe(0x06054b50);
  const count = dv.getUint16(endOffset + 10, true);
  const cdOffset = dv.getUint32(endOffset + 16, true);
  const entries: { name: string; data: Uint8Array; crc: number; size: number }[] = [];
  let p = cdOffset;
  const dec = new TextDecoder();
  for (let i = 0; i < count; i += 1) {
    expect(dv.getUint32(p, true)).toBe(0x02014b50);
    const crc = dv.getUint32(p + 16, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    // Local header: 30 + name, then the stored payload.
    expect(dv.getUint32(localOffset, true)).toBe(0x04034b50);
    expect(dv.getUint16(localOffset + 8, true)).toBe(0); // method: store
    const localNameLen = dv.getUint16(localOffset + 26, true);
    const dataStart = localOffset + 30 + localNameLen;
    entries.push({ name, crc, size, data: bytes.subarray(dataStart, dataStart + size) });
    p += 46 + nameLen;
  }
  return entries;
}

describe("buildZip — the batch archive (ADAAAA-7622)", () => {
  it("matches the reference CRC-32 check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("round-trips 5 clips + captions.txt with valid CRCs and sizes", () => {
    const files = Array.from({ length: 5 }, (_, i) => ({
      name: `goal-t${i}s-clip${i}.mp4`,
      data: new Uint8Array([0x00, 0x00, 0x00, 0x18, i, 0xff, 0xaa]),
    }));
    const manifest = new TextEncoder().encode(batchManifest([
      { caption: "GOAL · T+0s", url: "https://example.test/clips/c0.mp4" },
    ]));
    files.push({ name: "captions.txt", data: manifest });

    const bytes = buildZip(files);
    const entries = readZip(bytes);
    expect(entries.map((e) => e.name)).toEqual(files.map((f) => f.name));
    for (const entry of entries) {
      expect(entry.size).toBe(entry.data.length);
      expect(entry.crc).toBe(crc32(entry.data));
    }
    expect(new TextDecoder().decode(entries[5].data)).toContain("https://example.test/clips/c0.mp4");
  });

  it("is deterministic — identical input yields identical bytes", () => {
    const files = [{ name: "a.txt", data: new TextEncoder().encode("hello") }];
    expect(Array.from(buildZip(files))).toEqual(Array.from(buildZip(files)));
  });
});

// ADAAAA-7948 (Inc 3): the seeded caption crosses the same grounding gate as
// the server summary seam — verdict-gated goal claims, sourced names, and no
// internal tokens on a postable surface.
describe("seeded caption grounding (ADAAAA-7948)", () => {
  it("never offers an internal verdict label as a caption", () => {
    const h = hl({ localizedTs: 40, reason: "[near_miss] Audio Burst", outcome: "near_miss" });
    const caption = suggestCaption(h);
    expect(caption).not.toMatch(/[\[\]]|near_miss/i);
    expect(caption).toBe("Audio Burst.");
  });

  it("does not label an unverified moment 'Goal' in the titles", () => {
    const h = hl({ localizedTs: 40, reason: "[near_miss] Audio Burst", outcome: "near_miss" });
    const titles = postTitles(h);
    expect(titles.join(" | ")).not.toMatch(/\[near_miss\]|near_miss/i);
    expect(titles.join(" | ")).not.toMatch(/^Goal:|Goal: Audio/);
  });

  it("rewrites a goal claim in the summary-log narrative when the verdict is not a goal", () => {
    const log: SummaryLogEntry[] = [entry(1, 68, "The striker scores a goal at the near post.")];
    const h = hl({ localizedTs: 69, outcome: "near_miss" });
    const caption = suggestCaption(h, log);
    expect(caption).not.toMatch(/\bscores?\b|\bgoal\b/i);
    expect(caption.length).toBeLessThanOrEqual("The striker scores a goal at the near post.".length + 1);
  });

  it("keeps a real goal caption byte-identical (byte-for-byte passthrough)", () => {
    const log: SummaryLogEntry[] = [entry(1, 68, "No. 9 scores at the near post.")];
    const h = hl({ localizedTs: 69, outcome: "scoring_play" });
    expect(suggestCaption(h, log)).toBe("No. 9 scores at the near post.");
  });

  it("replaces an unsourced name when the caption falls back to the decide reason", () => {
    const h = hl({ localizedTs: 40, reason: "Manuel Ordoñez fires a shot from the box.", outcome: "big_play" });
    const caption = suggestCaption(h);
    expect(caption).not.toContain("Manuel");
    expect(caption).not.toContain("Ordoñez");
  });
});

// ---------------------------------------------------------------------------
// ADAAAA-7958 (contract v3 §3.4): the seeded caption option and the card titles
// consume the highlight's stored corroboration flag. QA measured (job 9fecca77)
// three seeded cards asserting exactly the goals the page called
// "(0 corroborated) ... counted, never asserted as scored".
// ---------------------------------------------------------------------------
describe("seeded caption + card titles consume corroboration (ADAAAA-7958 §3.4)", () => {
  const GOAL_CLAIM = /\b(?:goal|goals|scores?|scored|scoring|in the net|into the net)\b/i;
  const measured = hl({
    outcome: "scoring_play",
    eventType: "GOAL",
    reason: "No. 10 strikes the ball into the net",
  });

  it("an uncorroborated goal seeds no goal claim and no 'Goal:' title", () => {
    const h = { ...measured, corroborated: false };
    const titles = postTitles(h);
    expect(titles.length).toBeGreaterThan(0);
    for (const t of titles) {
      expect(t).not.toMatch(GOAL_CLAIM);
      expect(t.startsWith("Goal")).toBe(false);
    }
    expect(suggestCaption(h)).not.toMatch(GOAL_CLAIM);
  });

  it("a corroborated goal keeps its claim and its 'Goal:' title", () => {
    const h = { ...measured, corroborated: true };
    expect(postTitles(h).some((t) => t.startsWith("Goal:"))).toBe(true);
    const log: SummaryLogEntry[] = [entry(1, 120, "The ball is in the net at the far post")];
    const withLog = { ...h, localizedTs: 120, start: 113, end: 128 };
    expect(suggestCaption(withLog, log)).toMatch(/in the net/i);
    expect(postTitles(withLog, log).some((t) => t.startsWith("Goal:"))).toBe(true);
  });

  it("no corroboration evidence (legacy / VOD) keeps the shipped verdict behaviour", () => {
    const h = { ...measured };
    expect(postTitles(h).some((t) => t.startsWith("Goal:"))).toBe(true);
  });

  it("the banner-string class never reaches the caption even with a summary-log line", () => {
    const log: SummaryLogEntry[] = [entry(1, 120, "No. 6 shoots and scores in the box")];
    const h = hl({ outcome: "scoring_play", eventType: "GOAL", corroborated: false, localizedTs: 120, start: 113, end: 128 });
    expect(suggestCaption(h, log)).not.toMatch(GOAL_CLAIM);
    for (const t of postTitles(h, log)) expect(t).not.toMatch(GOAL_CLAIM);
  });
});

// ADAAAA-7957 (Inc 5, contract v3 §3.1-§3.3 + §3.5): the seeded caption seam is
// the OTHER user surface, and it must not leak what the summary seam rewrites.
// These pin the measured v2 failures (job 9fecca77, grade on ADAAAA-7950) on
// every caption option the card offers, not just the first.
describe("seeded caption options carry the v3 gate (ADAAAA-7957)", () => {
  const CLAIM = /\b(?:scores?|scored|go+al|goals?|gol|net|taps? it in|converts?)\b/i;
  const quietLog = (text: string): SummaryLogEntry[] => [entry(1, 68, text)];

  it("no caption option claims a goal on a not_highlight window", () => {
    const log = quietLog("No. 10 strikes the ball into the net — players celebrate.");
    const h = hl({ localizedTs: 69, outcome: "not_highlight" });
    const caption = suggestCaption(h, log);
    expect(caption).not.toMatch(CLAIM);
    expect(caption).not.toMatch(/[—–]/);
    for (const title of postTitles(h, log)) expect(title, title).not.toMatch(CLAIM);
  });

  it("gates a name on a RAW decide reason (no upstream certification)", () => {
    // The log path passes `null` = "the server certified this against the
    // window's prompt"; a raw reason has no such certification and fails closed.
    const h = hl({ localizedTs: 69, reason: "Manuel Ordoñez moves in the center circle.", outcome: "not_highlight" });
    const caption = suggestCaption(h);
    expect(caption).not.toMatch(/Manuel|Ordoñez/);
    for (const title of postTitles(h)) expect(title, title).not.toMatch(/Manuel|Ordoñez/);
  });

  it("never offers a scorebug OCR clause as a colour beat", () => {
    const log = quietLog("Player strikes ball into net — GOL graphic appears");
    const h = hl({ localizedTs: 69, outcome: "not_highlight" });
    expect(suggestCaption(h, log)).not.toMatch(/GOL|graphic|net/i);
  });

  it("a raw decide reason on the card is name-gated (no upstream certification)", () => {
    const h = hl({ localizedTs: 40, reason: "David Saez shoots from the edge", outcome: "not_highlight" });
    expect(suggestCaption(h)).not.toMatch(/David|Saez/i);
  });
});

// ADAAAA-7958: the card's seeded strings must agree with the ladder banner's OWN
// corroboration rule (`corroborated === true || goalConfirmed === "confirmed_goal"`).
// The measured job 9fecca77 carried NEITHER flag on its three accepted goals, so
// the banner read "3 of 3 ... never asserted as scored" while the cards offered
// "Goal: …" — the exact contradiction AC7 fails on.
describe("seeded card strings agree with the ladder banner (ADAAAA-7958 §3.4)", () => {
  const GOAL_CLAIM = /\b(?:goal|goals|scores?|scored|scoring)\b/i;
  const bare = hl({ outcome: "scoring_play", eventType: "GOAL", localizedTs: 120, start: 113, end: 128, reason: "No. 3 drives into the box and scores" });
  const log: SummaryLogEntry[] = [entry(1, 120, "No. 3 drives into the box and scores")];

  it("fast rail, no corroboration evidence: no 'Goal:' title, no goal claim", () => {
    for (const h of [bare, { ...bare, corroborated: false }]) {
      const titles = postTitles(h, log, highlightGrounding(h, log, true));
      expect(titles.some((t) => t.startsWith("Goal"))).toBe(false);
      for (const t of titles) expect(t).not.toMatch(GOAL_CLAIM);
      expect(suggestCaption(h, log, highlightGrounding(h, log, true))).not.toMatch(GOAL_CLAIM);
    }
  });

  it("fast rail, confirmed_goal: the claim and the 'Goal:' title survive", () => {
    const h = { ...bare, goalConfirmed: "confirmed_goal" as const };
    expect(postTitles(h, log, highlightGrounding(h, log, true)).some((t) => t.startsWith("Goal:"))).toBe(true);
  });

  it("fast rail, corroborated flag: the claim survives", () => {
    const h = { ...bare, corroborated: true };
    expect(postTitles(h, log, highlightGrounding(h, log, true)).some((t) => t.startsWith("Goal:"))).toBe(true);
  });

  it("VOD (fastRail false) keeps the shipped verdict-only behaviour — AC8", () => {
    expect(postTitles(bare, log, highlightGrounding(bare, log, false)).some((t) => t.startsWith("Goal:"))).toBe(true);
    expect(postTitles(bare, log)).toEqual(postTitles(bare, log, highlightGrounding(bare, log)));
  });
});
