import { describe, it, expect } from "vitest";
import {
  buildSession,
  serializeSession,
  parseSession,
  framesFromSession,
  saveSession,
  loadSession,
  clearSession,
  hasSession,
  type DatasetSessionState,
  type StorageLike,
} from "./datasetSession";
import type { CurationFrame } from "./dataset";

function frame(id: string, accepted = true, boxes: CurationFrame["boxes"] = []): CurationFrame {
  return {
    id,
    imageRef: `data/training/extract/b1/frame_${id}.jpg`,
    width: 1280,
    height: 720,
    uri: `/training/frames/data/training/extract/b1/frame_${id}.jpg`,
    phash: `${id}`.padEnd(16, "0"),
    sourceSeq: Number(id.replace(/\D/g, "")) || 0,
    accepted,
    boxes,
  };
}

const box = (id: string, label: CurationFrame["boxes"][number]["label"] = "player"): CurationFrame["boxes"][number] => ({
  id,
  label,
  bbox: [0.1, 0.2, 0.3, 0.4],
});

function session(frames: CurationFrame[]): DatasetSessionState {
  return buildSession({
    ingest: { source: "https://example.com/clip.mp4", inSec: "10", outSec: "40", fps: "1" },
    frames,
    selIdx: frames.length ? 2 : null,
    selBox: frames.length ? frames[0]!.boxes[0]?.id ?? null : null,
    label: "goalkeeper",
    seedJson: '[{"label":"person","bbox":[0,0,0.2,0.2]}]',
  });
}

/** Minimal in-memory Storage that mirrors the browser Storage interface. */
function memStorage(): StorageLike & { entries: Map<string, string> } {
  const m = new Map<string, string>();
  return {
    entries: m,
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

describe("datasetSession browser persistence (ADAAAA-5395 C2)", () => {
  it("round-trips a full session exactly (frames + boxes + labels + ingest)", () => {
    const frames = [
      frame("a", true, [box("b1", "player"), box("b2", "soccer ball")]),
      frame("b", false, [box("c1", "goalkeeper")]),
      frame("c", true, []),
    ];
    const s = session(frames);
    const parsed = parseSession(serializeSession(s))!;
    expect(parsed).not.toBeNull();
    expect(parsed.version).toBe(1);
    expect(parsed.ingest).toEqual(s.ingest);
    expect(parsed.selIdx).toBe(2);
    expect(parsed.label).toBe("goalkeeper");
    expect(parsed.seedJson).toEqual(s.seedJson);
    // exact frame restoration — every annotated field survives
    expect(parsed.frames).toEqual(s.frames);
    expect(parsed.frames[0].boxes).toEqual([
      { id: "b1", label: "player", bbox: [0.1, 0.2, 0.3, 0.4] },
      { id: "b2", label: "soccer ball", bbox: [0.1, 0.2, 0.3, 0.4] },
    ]);
    expect(parsed.frames[0].accepted).toBe(true);
    expect(parsed.frames[1].accepted).toBe(false);
  });

  it("framesFromSession reattaches the server fetch uri from imageRef", () => {
    const s = session([frame("a", true, [box("b1")])]);
    const live = framesFromSession(s);
    expect(live[0].uri).toBe("/training/frames/data/training/extract/b1/frame_a.jpg");
    expect(live).toHaveLength(1);
  });

  it("rejects corrupt / unknown-version / wrong-shape blobs", () => {
    expect(parseSession("not json")).toBeNull();
    expect(parseSession(JSON.stringify({ version: 99, frames: [] }))).toBeNull();
    expect(parseSession(JSON.stringify({ version: 1, ingest: {}, frames: "nope" }))).toBeNull();
    // frame missing required field
    expect(
      parseSession(
        JSON.stringify({
          version: 1,
          savedAt: "x",
          ingest: { source: "s", inSec: "0", outSec: "", fps: "1" },
          frames: [{ id: "a" }],
          selIdx: null,
          selBox: null,
          label: "player",
          seedJson: "",
        })
      )
    ).toBeNull();
    // bad box shape
    const bad = session([frame("a", true, [box("b1")])]);
    (bad.frames[0] as any).boxes = [{ id: "b1", label: 5, bbox: [0, 0, 1] }];
    expect(parseSession(serializeSession(bad))).toBeNull();
  });

  it("save / load / clear / has on a concrete storage round-trips", () => {
    const st = memStorage();
    const s = session([frame("x", true, [box("b1", "referee")]), frame("y")]);
    expect(hasSession(st)).toBe(false);
    expect(saveSession(s, st)).toBe(true);
    expect(hasSession(st)).toBe(true);
    const loaded = loadSession(st)!;
    expect(loaded).not.toBeNull();
    expect(loaded.frames).toEqual(s.frames);
    expect(loaded.frames[0].boxes[0].label).toBe("referee");
    clearSession(st);
    expect(hasSession(st)).toBe(false);
    expect(loadSession(st)).toBeNull();
  });

  it("save / load return null gracefully with no storage", () => {
    // simulate no-platform storage (null)
    expect(loadSession(null)).toBeNull();
    expect(saveSession(session([frame("a")]), null)).toBe(false);
    expect(hasSession(null)).toBe(false);
  });
});
