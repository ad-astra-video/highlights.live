import { describe, it, expect } from "vitest";
import {
  batchManifest,
  captionNarrative,
  clipFileName,
  clipUrl,
  highlightInstant,
  seedCaption,
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

  it("prefills the event type and timestamp ahead of the narrative", () => {
    expect(seedCaption(hl({ localizedTs: 69.4 }), log)).toBe(
      "GOAL · T+69s — Argentina breaks the deadlock — the ball is in the net."
    );
  });

  it("falls back to the clip start when no localization instant exists", () => {
    // start 60 is closest to entry 2 (68) of the three windows.
    expect(captionNarrative(hl({ start: 60 }), log)).toBe(
      "Argentina breaks the deadlock — the ball is in the net."
    );
  });

  it("uses the highlight's own decide reason when the job has no summary log", () => {
    expect(seedCaption(hl({ reason: "Ball crossed the line at the far post." }))).toBe(
      "GOAL · T+60s — Ball crossed the line at the far post."
    );
  });

  it("still yields a postable caption when nothing else is known", () => {
    expect(seedCaption(hl({ eventType: undefined, reason: undefined }))).toBe("Highlight · T+60s");
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
