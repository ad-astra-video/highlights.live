import { describe, it, expect } from "vitest";
import {
  DetectionTrainingSampleSchema,
  DetectionTrainingBoxSchema,
  SOCCER_TRAINING_LABELS,
  TrainingLabelSchema,
} from "../src/index";
import {
  canonicalizeTrainingLabel,
  seedBoxesFromDetections,
  perceptualHash,
  phashHammingDistance,
  bucketNearDuplicates,
  coverageSummary,
  splitTrainVal,
  serializeManifestJsonl,
  parseManifestJsonl,
  validateManifest,
  buildSample,
  COVERAGE_TARGETS,
} from "../src/training";

const W = 32;
const H = 32;

// Solid-color RGBA buffers (32x32). Deterministic aHash inputs.
function solid(r: number, g: number, b: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    px[i * 4] = r;
    px[i * 4 + 1] = g;
    px[i * 4 + 2] = b;
    px[i * 4 + 3] = 255;
  }
  return px;
}
// Buffer with a single bright square in the top-left quadrant (content differs
// from a flat field in a way aHash must capture).
function patched(top: boolean, r = 40, g = 40, b = 40): Uint8ClampedArray {
  const px = solid(r, g, b);
  if (top) {
    for (let y = 2; y < 12; y++) {
      for (let x = 2; x < 12; x++) {
        const i = (y * W + x) * 4;
        px[i] = 255;
        px[i + 1] = 255;
        px[i + 2] = 255;
      }
    }
  } else {
    for (let y = 20; y < 30; y++) {
      for (let x = 20; x < 30; x++) {
        const i = (y * W + x) * 4;
        px[i] = 255;
        px[i + 1] = 255;
        px[i + 2] = 255;
      }
    }
  }
  return px;
}

describe("DetectionTrainingSampleSchema contract (ADAAAA-5164)", () => {
  it("accepts a valid sample with the closed soccer vocab", () => {
    const s = DetectionTrainingSampleSchema.parse({
      id: "soc-0001",
      imageRef: "data/training/clipA/frame_0001.jpg",
      width: 1280,
      height: 720,
      objects: [
        { label: "player", bbox: [0.1, 0.2, 0.3, 0.4] },
        { label: "soccer ball", bbox: [0.5, 0.6, 0.55, 0.62] },
      ],
    });
    expect(s.objects.length).toBe(2);
    expect(s.objects[1].label).toBe("soccer ball");
  });

  it("exposes exactly the 5-label soccer vocabulary", () => {
    expect(SOCCER_TRAINING_LABELS).toEqual([
      "player",
      "soccer ball",
      "goalkeeper",
      "goal",
      "referee",
    ]);
    for (const l of SOCCER_TRAINING_LABELS) expect(TrainingLabelSchema.parse(l)).toBe(l);
  });

  it("rejects a label outside the closed vocab", () => {
    expect(() =>
      DetectionTrainingSampleSchema.parse({
        id: "x", imageRef: "r", width: 1, height: 1,
        objects: [{ label: "cat", bbox: [0, 0, 1, 1] }],
      })
    ).toThrow();
    expect(() => DetectionTrainingBoxSchema.parse({ label: "cat", bbox: [0, 0, 1, 1] })).toThrow();
  });

  it("rejects non-normalized bboxes and non-positive dimensions", () => {
    const bad = [
      { label: "player", bbox: [-0.1, 0, 1, 1] }, // x1 < 0
      { label: "player", bbox: [0, 0, 1.2, 1] }, // x2 > 1
      { label: "player", bbox: [0, 0, 1, 1] as any },
    ];
    expect(() => DetectionTrainingBoxSchema.parse(bad[0])).toThrow();
    expect(() => DetectionTrainingBoxSchema.parse(bad[1])).toThrow();
    expect(() =>
      DetectionTrainingSampleSchema.parse({ id: "x", imageRef: "r", width: 0, height: 1, objects: [bad[2]] })
    ).toThrow();
  });

  it("buildSample produces a round-tripping contract-valid sample", () => {
    const s = buildSample("soc-2", "data/training/c/f2.jpg", 640, 360, [
      { label: "referee", bbox: [0.2, 0.3, 0.4, 0.5] },
    ]);
    expect(s.width).toBe(640);
    expect(DetectionTrainingSampleSchema.safeParse(s).success).toBe(true);
  });
});

describe("canonicalizeTrainingLabel (mirrors florence.py soccer aliases)", () => {
  it("maps open-set labels onto the closed vocab", () => {
    expect(canonicalizeTrainingLabel("person")).toBe("player");
    expect(canonicalizeTrainingLabel("ball")).toBe("soccer ball");
    expect(canonicalizeTrainingLabel("goalie")).toBe("goalkeeper");
    expect(canonicalizeTrainingLabel("net")).toBe("goal");
    expect(canonicalizeTrainingLabel("referee")).toBe("referee");
    expect(canonicalizeTrainingLabel("Referee")).toBe("referee");
  });
  it("returns null for out-of-scope labels", () => {
    expect(canonicalizeTrainingLabel("cat")).toBeNull();
    expect(canonicalizeTrainingLabel("")).toBeNull();
  });
  it("seedBoxesFromDetections keeps only in-vocab boxes", () => {
    const seeded = seedBoxesFromDetections([
      { label: "person", bbox: [0, 0, 0.2, 0.2] },
      { label: "football", bbox: [0.3, 0.3, 0.4, 0.4] },
      { label: "goalie", bbox: [0.5, 0.5, 0.6, 0.6] },
      { label: "cat", bbox: [0.7, 0.7, 0.8, 0.8] },
    ]);
    expect(seeded.map((s) => s.label)).toEqual(["player", "soccer ball", "goalkeeper"]);
  });
});

describe("perceptual hash + near-dup bucketing", () => {
  it("identical images hash identically (dist 0)", () => {
    const a = perceptualHash(solid(120, 120, 120), W, H);
    const b = perceptualHash(solid(120, 120, 120), W, H);
    expect(a).toBe(b);
    expect(phashHammingDistance(a, b)).toBe(0);
  });
  it("bright patch in one corner is far from bright patch in the other", () => {
    const top = perceptualHash(patched(true), W, H);
    const bot = perceptualHash(patched(false), W, H);
    expect(phashHammingDistance(top, bot)).toBeGreaterThan(8);
  });
  it("small luminance delta stays a near-dup (within threshold)", () => {
    const a = perceptualHash(solid(100, 100, 100), W, H);
    const b = perceptualHash(solid(104, 102, 100), W, H);
    expect(phashHammingDistance(a, b)).toBeLessThanOrEqual(6);
  });
  it("bucketNearDuplicates groups near-dup frames together", () => {
    const frames = [
      { id: "a", phash: perceptualHash(solid(100, 100, 100), W, H) },
      { id: "b", phash: perceptualHash(solid(102, 100, 100), W, H) }, // near-dup of a
      { id: "c", phash: perceptualHash(patched(true), W, H) }, // distinct
    ];
    const buckets = bucketNearDuplicates(frames, 6);
    const sizes = buckets.map((b) => b.length).sort((x, y) => y - x);
    expect(sizes).toEqual([2, 1]);
    const nearPair = buckets.find((b) => b.length === 2)!;
    expect(nearPair.map((f) => f.id).sort()).toEqual(["a", "b"]);
  });
});

describe("coverage accounting vs targets", () => {
  it("counts per label and flags within-range", () => {
    const samples = [
      buildSample("1", "r1", 1, 1, [{ label: "player", bbox: [0, 0, 0.5, 0.5] }]),
      buildSample("2", "r2", 1, 1, [{ label: "player", bbox: [0, 0, 0.5, 0.5] }]),
      buildSample("3", "r3", 1, 1, [{ label: "soccer ball", bbox: [0.2, 0.2, 0.3, 0.3] }]),
    ];
    const c = coverageSummary(samples);
    expect(c.byLabel.player.count).toBe(2);
    expect(c.byLabel["soccer ball"].count).toBe(1);
    expect(c.byLabel.goalkeeper.count).toBe(0);
    expect(c.totalFrames).toBe(3);
    expect(c.totalWithinRange).toBe(false); // below floor of 3000
    expect(COVERAGE_TARGETS.player).toEqual({ min: 4000, max: 6000 });
  });
});

describe("near-dup-aware train/val split (85/15)", () => {
  function sample(id: string, phash: string): DetectionTrainingSampleLike {
    return buildSample(id, `r/${id}.jpg`, 1, 1, []);
  }
  type DetectionTrainingSampleLike = ReturnType<typeof buildSample>;

  it("keeps near-duplicate frames on the same side", () => {
    // a/b are near-dups; c, d, e are visually distinct singles.
    const accepted = [
      sample("a", "aaaaaaaaaaaaaaaa"),
      sample("b", "aaaaaaaaaaaaaaab"), // near-dup of a (1 bit)
      sample("c", "3333333333333333"),
      sample("d", "5555555555555555"),
      sample("e", "7777777777777777"),
    ];
    const phashOf = (id: string): string => {
      switch (id) {
        case "a": return "aaaaaaaaaaaaaaaa";
        case "b": return "aaaaaaaaaaaaaaab";
        case "c": return "3333333333333333";
        case "d": return "5555555555555555";
        default: return "7777777777777777";
      }
    };
    const { train, val } = splitTrainVal(accepted, { phashOf });
    // near-dups a+b must not straddle the split
    const aInVal = val.some((s) => s.id === "a");
    const bInVal = val.some((s) => s.id === "b");
    expect(aInVal).toBe(bInVal);
    // split is not degenerate and preserves every sample
    expect(train.length + val.length).toBe(5);
    expect(train.length).toBeGreaterThan(0);
    expect(val.length).toBeGreaterThan(0);
  });

  it("produces ~an 85/15 split", () => {
    const accepted = Array.from({ length: 100 }, (_, i) => sample(`f${i}`, i.toString(16).padStart(16, "0")));
    const { train, val } = splitTrainVal(accepted, {});
    expect(train.length + val.length).toBe(100);
    const ratio = train.length / 100;
    expect(ratio).toBeGreaterThanOrEqual(0.8);
    expect(ratio).toBeLessThanOrEqual(0.9);
  });
});

describe("Zod-validated JSONL manifests", () => {
  it("serializeManifestJsonl writes one contract-valid sample per line", () => {
    const samples = [
      buildSample("s1", "data/training/a/1.jpg", 1280, 720, [{ label: "player", bbox: [0.1, 0.2, 0.3, 0.4] }]),
      buildSample("s2", "data/training/a/2.jpg", 1280, 720, [{ label: "goal", bbox: [0.2, 0.1, 0.8, 0.5] }]),
    ];
    const jsonl = serializeManifestJsonl(samples);
    const lines = jsonl.trim().split("\n");
    expect(lines.length).toBe(2);
    // shape mirrors track_label_manifest.json: each object entry carries a
    // normalized [x1,y1,x2,y2] bbox and a label (its `kind` counterpart).
    const obj = JSON.parse(lines[0]);
    expect(obj.imageRef).toBe("data/training/a/1.jpg");
    expect(obj.objects[0].label).toBe("player");
    expect(obj.objects[0].bbox).toHaveLength(4);
    for (const n of obj.objects[0].bbox) {
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(1);
    }
    // and re-parsing validates against the shared Zod schema
    const reparsed = parseManifestJsonl(jsonl);
    expect(validateManifest(reparsed).valid).toBe(true);
  });

  it("parseManifestJsonl rejects an invalid line", () => {
    const good = serializeManifestJsonl([buildSample("s", "r", 1, 1, [])]);
    expect(() => parseManifestJsonl(good + '{"id":"bad","objects":[{"label":"cat"}]}\n')).toThrow();
    expect(() => parseManifestJsonl("not json at all\n")).toThrow();
  });

  it("validateManifest reports invalid samples", () => {
    const bad = [buildSample("ok", "r", 1, 1, []), { id: "bad", imageRef: "r", width: 1, height: 1, objects: [{ label: "cat", bbox: [0, 0, 1, 1] }] } as any];
    const v = validateManifest(bad);
    expect(v.valid).toBe(false);
    expect(v.invalidCount).toBe(1);
  });
});
