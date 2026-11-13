/**
 * ADAAAA-8835 (Inc 1): per-job score-bug pin + `scoreboardSurface` provenance.
 *
 * These pin the two properties the ticket grades hardest:
 *  - AC4: an UNPINNED job's `/app/analyze` body is byte-identical (no field, no
 *    key, no empty array) and its calibration object is untouched;
 *  - AC6: the block's `source` is MAPPED from what perceive reported, so an
 *    operator pin can never read as `discovery`, and a declared pin that no
 *    frame has reported yet is `seqFirstSeen: -1`, not a fabricated 0.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { loadConfig } from "../src/config";
import { DirectAdapter } from "../src/livepeer-adapter";
import {
  declaredScoreboardSurface,
  mapScoreboardRoiSource,
  nextScoreboardSurface,
  parseScoreboardRoi,
  sameScoreboardSurface,
} from "../src/scoreboard-surface";
import { scoreboardSurfaceRecorder, withScoreboardRoi } from "../src/api";

describe("parseScoreboardRoi (job create gate)", () => {
  it("treats absent input as a valid no-pin (unpinned submit is unchanged)", () => {
    expect(parseScoreboardRoi(undefined)).toEqual({ ok: true, roi: undefined });
    expect(parseScoreboardRoi(null)).toEqual({ ok: true, roi: undefined });
  });

  it("accepts a normalized ordered box", () => {
    expect(parseScoreboardRoi([0, 0, 0.55, 0.18])).toEqual({ ok: true, roi: [0, 0, 0.55, 0.18] });
    expect(parseScoreboardRoi([0.1, 0.2, 1, 1])).toEqual({ ok: true, roi: [0.1, 0.2, 1, 1] });
  });

  it("rejects a malformed box with a 422-shaped message (never silently drops it)", () => {
    for (const bad of [[0, 0, 0.5], [0, 0, 0.5, 0.2, 1], [0, 0, "x", 0.2], [0, 0, 0.5, 2], [0.6, 0, 0.5, 0.2], [0, 0.3, 0.5, 0.2]]) {
      const r = parseScoreboardRoi(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("invalid_scoreboard_roi");
    }
  });
});

describe("mapScoreboardRoiSource (truthful provenance, AC6)", () => {
  it("maps an operator pin to explicit", () => {
    expect(mapScoreboardRoiSource("explicit")).toBe("explicit");
  });

  it("maps every auto-located/learned box to discovery", () => {
    for (const s of ["discovery", "selector", "learned_crop", "incumbent_proven_box", "restored_proven_box", "vision", "discovery_rejected", "bottom_prior_repair", ""]) {
      expect(mapScoreboardRoiSource(s)).toBe("discovery");
    }
  });

  it("maps the built-in priors to default_top_band", () => {
    for (const s of ["default_top_band", "default_top_band_miss", "abandoned_bottom_prior"]) {
      expect(mapScoreboardRoiSource(s)).toBe("default_top_band");
    }
  });

  it("never reports an unknown source as explicit", () => {
    expect(mapScoreboardRoiSource(undefined)).toBe("discovery");
    expect(mapScoreboardRoiSource("some_new_source")).toBe("discovery");
  });
});

describe("nextScoreboardSurface (monotonic block)", () => {
  it("returns undefined when the observation carries no reported crop", () => {
    expect(nextScoreboardSurface(undefined, { seq: 4 })).toBeUndefined();
    expect(nextScoreboardSurface(undefined, { seq: 4, scoreboardRoi: [0, 0, 1] })).toBeUndefined();
  });

  it("upgrades a declared pin (-1) to the first reporting frame and latches verified", () => {
    const declared = declaredScoreboardSurface([0, 0, 0.5, 0.2]);
    expect(declared.seqFirstSeen).toBe(-1);
    const first = nextScoreboardSurface(declared, {
      seq: 7,
      scoreboardRoi: [0, 0, 0.5, 0.2],
      scoreboardRoiSource: "explicit",
      scoreboardRoiVerified: true,
    });
    expect(first).toEqual({ roi: [0, 0, 0.5, 0.2], source: "explicit", seqFirstSeen: 7, verified: true });
    // verified never regresses for the same box
    const later = nextScoreboardSurface(first, { seq: 9, scoreboardRoi: [0, 0, 0.5, 0.2], scoreboardRoiSource: "explicit" });
    expect(later).toEqual({ roi: [0, 0, 0.5, 0.2], source: "explicit", seqFirstSeen: 7, verified: true });
  });

  it("starts a NEW surface (seq + verified reset) when the box changes", () => {
    const prev = { roi: [0, 0, 0.5, 0.2] as [number, number, number, number], source: "explicit" as const, seqFirstSeen: 3, verified: true };
    const next = nextScoreboardSurface(prev, {
      seq: 40,
      scoreboardRoi: [0.5, 0.5, 1, 1],
      scoreboardRoiSource: "discovery",
    });
    expect(next).toEqual({ roi: [0.5, 0.5, 1, 1], source: "discovery", seqFirstSeen: 40, verified: false });
  });

  it("does not treat a missing seq as a fabricated 0 on a fresh box", () => {
    const next = nextScoreboardSurface(undefined, { scoreboardRoi: [0, 0, 0.5, 0.2], scoreboardRoiSource: "default_top_band" });
    expect(next?.seqFirstSeen).toBe(-1);
  });
});

describe("sameScoreboardSurface", () => {
  it("compares roi, source, seq and verification", () => {
    const a = { roi: [0, 0, 0.5, 0.2] as [number, number, number, number], source: "explicit" as const, seqFirstSeen: 1, verified: false };
    expect(sameScoreboardSurface(a, { ...a })).toBe(true);
    expect(sameScoreboardSurface(a, { ...a, verified: true })).toBe(false);
    expect(sameScoreboardSurface(a, { ...a, roi: [0, 0, 0.5, 0.21] })).toBe(false);
    expect(sameScoreboardSurface(undefined, undefined)).toBe(true);
    expect(sameScoreboardSurface(a, undefined)).toBe(false);
  });
});

describe("withScoreboardRoi (per-analyze calibration delivery)", () => {
  it("leaves an unpinned calibration untouched (AC4 byte-identical)", () => {
    const cal = { homography: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
    expect(withScoreboardRoi(cal, undefined)).toBe(cal);
    expect(withScoreboardRoi(undefined, undefined)).toBeUndefined();
  });

  it("merges the pin beside the pitch calibration", () => {
    const cal = { goalLine: { axis: "y" as const, position: 1, mouthMin: 0, mouthMax: 2 } };
    expect(withScoreboardRoi(cal, [0, 0, 0.5, 0.2])).toEqual({
      goalLine: { axis: "y", position: 1, mouthMin: 0, mouthMax: 2 },
      scoreboardRoi: [0, 0, 0.5, 0.2],
    });
    expect(withScoreboardRoi(undefined, [0.5, 0.5, 1, 1])).toEqual({ scoreboardRoi: [0.5, 0.5, 1, 1] });
  });
});

describe("ADAAAA-8935: the guard must see identity and demotion", () => {
  const IDENTITY = {
    verdict: "consistent" as const,
    kitDistance: 0.11,
    threshold: 0.44,
    kitsPresent: true,
    kitsDiffer: false,
    kitReference: "prior" as const,
    namesMatch: false,
    namesMatched: [],
    names: ["RMA", "BAR"],
    kits: { away: [99, 102, 182] },
    seqFirstSeen: 4,
  };
  const base = {
    roi: [0, 0, 1, 0.25] as [number, number, number, number],
    source: "discovery" as const,
    seqFirstSeen: 276,
    verified: true,
  };

  function storeWith(initial: any) {
    let job: any = { id: "j1", scoreboardSurface: initial };
    const patchJob = vi.fn(async (_id: string, patch: any) => {
      job = { ...job, ...patch };
      return job;
    });
    return { store: { getJob: () => job, patchJob } as any, patchJob };
  }

  it("compares a newly folded identity that the box-only guard could not see", () => {
    expect(sameScoreboardSurface(base, { ...base, identity: IDENTITY })).toBe(false);
    expect(sameScoreboardSurface({ ...base, identity: IDENTITY }, { ...base, identity: IDENTITY })).toBe(true);
    expect(
      sameScoreboardSurface({ ...base, identity: IDENTITY }, { ...base, identity: { ...IDENTITY, verdict: "contradicted" } })
    ).toBe(false);
    // the measurement marker is not part of the measurement: a later fold keeps
    // the block equal, so one measured surface costs one write
    expect(
      sameScoreboardSurface({ ...base, identity: IDENTITY }, { ...base, identity: { ...IDENTITY, seqFirstSeen: 900 } })
    ).toBe(true);
  });

  it("compares the named demotion", () => {
    expect(sameScoreboardSurface(base, { ...base, demotion: "ignored (kits differ)" })).toBe(false);
  });

  it("persists a verdict reported on an ALREADY-persisted box (the served defect)", () => {
    // The served rows: the box landed at seq 276 with no identity, the verdict
    // was measured earlier (seq 4-10) and re-reported on that same box. Before
    // the fix `sameScoreboardSurface` returned true here, so `patchJob` never
    // ran and `scoreboardSurface.identity` was absent on every served job.
    const { store, patchJob } = storeWith({ ...base } as any);
    const rec = scoreboardSurfaceRecorder(store, "j1");
    rec({
      seq: 276,
      scoreboardRoi: [0, 0, 1, 0.25],
      scoreboardRoiSource: "discovery",
      scoreboardRoiVerified: true,
      scoreboardSurfaceIdentity: IDENTITY,
    });
    expect(patchJob).toHaveBeenCalledTimes(1);
    expect(patchJob.mock.calls[0][1].scoreboardSurface.identity.verdict).toBe("consistent");
    expect(patchJob.mock.calls[0][1].scoreboardSurface.identity.seqFirstSeen).toBe(276);

    // AC-B2: an identical block MUST NOT write — a per-frame re-report of the
    // same measurement stays silent, even at a later seq.
    rec({
      seq: 300,
      scoreboardRoi: [0, 0, 1, 0.25],
      scoreboardRoiSource: "discovery",
      scoreboardRoiVerified: true,
      scoreboardSurfaceIdentity: { ...IDENTITY, seqFirstSeen: undefined },
    });
    expect(patchJob).toHaveBeenCalledTimes(1);

    // A NEW verdict on the same box MUST persist.
    rec({
      seq: 302,
      scoreboardRoi: [0, 0, 1, 0.25],
      scoreboardRoiSource: "discovery",
      scoreboardRoiVerified: true,
      scoreboardSurfaceIdentity: { ...IDENTITY, verdict: "contradicted", kitsDiffer: true },
    });
    expect(patchJob).toHaveBeenCalledTimes(2);
    expect(patchJob.mock.calls[1][1].scoreboardSurface.identity.verdict).toBe("contradicted");
    expect(patchJob.mock.calls[1][1].scoreboardSurface.identity.seqFirstSeen).toBe(302);
  });
});

describe("DirectAdapter.analyze body (AC1/AC4: the pin rides every analyze)", () => {
  const cfg = loadConfig({ PERCEIVE_URL: "http://p", DECIDE_URL: "http://d" });
  afterEach(() => vi.restoreAllMocks());

  function stubFetch() {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ seq: 0, tracks: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("sends scoreboardRoi on /app/analyze for a pinned job", async () => {
    const fetchMock = stubFetch();
    const adapter = new DirectAdapter(cfg);
    await adapter.analyze(
      "s",
      { seq: 3, timestamp: 1, imageB64: "AAAA" },
      { gameHint: "soccer", scoreboardRoi: [0, 0, 0.55, 0.18] }
    );
    const [url, init] = fetchMock.mock.calls[0] as unknown as [{}, Record<string, any>];
    expect(url).toBe("http://p/app/analyze");
    expect(JSON.parse(init.body).scoreboardRoi).toEqual([0, 0, 0.55, 0.18]);
  });

  it("omits the key entirely for an unpinned job (no empty array)", async () => {
    const fetchMock = stubFetch();
    const adapter = new DirectAdapter(cfg);
    await adapter.analyze("s", { seq: 3, timestamp: 1, imageB64: "AAAA" }, { gameHint: "soccer" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [{}, Record<string, any>];
    expect(Object.prototype.hasOwnProperty.call(JSON.parse(init.body), "scoreboardRoi")).toBe(false);
  });
});

describe("scoreboardSurfaceRecorder (one write per CHANGE, never per frame)", () => {
  function fakeStore(initial: any) {
    const state: { job: any } = { job: { id: "j1", scoreboardSurface: initial } };
    const patchJob = vi.fn(async (_id: string, patch: any) => {
      state.job = { ...state.job, ...patch };
      return state.job;
    });
    return { store: { getJob: () => state.job, patchJob } as any, patchJob, state };
  }

  it("persists the first reported crop, then stays quiet for the same box", () => {
    const { store, patchJob } = fakeStore(declaredScoreboardSurface([0, 0, 0.5, 0.2]));
    const rec = scoreboardSurfaceRecorder(store, "j1");
    rec({ seq: 5, scoreboardRoi: [0, 0, 0.5, 0.2], scoreboardRoiSource: "explicit", scoreboardRoiVerified: true });
    expect(patchJob).toHaveBeenCalledTimes(1);
    expect(patchJob.mock.calls[0][1]).toEqual({
      scoreboardSurface: { roi: [0, 0, 0.5, 0.2], source: "explicit", seqFirstSeen: 5, verified: true },
    });
    rec({ seq: 6, scoreboardRoi: [0, 0, 0.5, 0.2], scoreboardRoiSource: "explicit", scoreboardRoiVerified: true });
    expect(patchJob).toHaveBeenCalledTimes(1);
  });

  it("ignores an observation with no reported crop (old runner) and never throws", () => {
    const { store, patchJob } = fakeStore(undefined);
    const rec = scoreboardSurfaceRecorder(store, "j1");
    rec({ seq: 1 });
    expect(patchJob).not.toHaveBeenCalled();
  });
});
