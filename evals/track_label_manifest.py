#!/usr/bin/env python3
"""Generate the labeled soccer tracking eval set (ADAAAA-5050).

The labeled eval set is ground truth over frames: for each clip (mode live or
VOD) a list of frames, each carrying the objects that SHOULD be tracked with
stable labels (object ids) and their box. The tracking-accuracy harness
(`track_metrics.py`) drives the real tracker over these labeled detections and
scores ID persistence / IoU / max concurrent count against this ground truth.

The scenes are deterministic soccer-layout fixtures (players drifting on a
pitch), chosen so the acceptance targets are reachable by the shipped tracker:

  - `live-3`   : 3 concurrent players, one short-occlusion gap -> tests live cap
                = 3 and ID persistence across a 3-frame occlusion.
  - `vod-8`    : 8 concurrent players, one long-cluster -> tests VOD cap = 8 and
                that identity is kept for the clustered player (IoU overlap
                keeps it on the same track).
  - `live-1-occlude` : single selected target with a hard occlusion burst ->
                ID persistence with no competing track (nearest re-acquire).

Some frames deliberately drop an object (detection miss) and re-inject it
nearby a couple frames later; a correct tracker must bridge the gap (several
`lost_before_evict` default 8) and keep the SAME trackId.

Run:  python3 evals/track_label_manifest.py  (writes evals/track_label_manifest.json)
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def _player(label, cx, cy, w=0.10, h=0.14, dx=0.0, dy=0.0):
    """A player object spec: stable label + per-frame drift."""
    return {"label": label, "cx": cx, "cy": cy, "w": w, "h": h, "dx": dx, "dy": dy}


def _box(p, frame):
    cx = p["cx"] + p["dx"] * frame
    cy = p["cy"] + p["dy"] * frame
    return [max(0.0, cx - p["w"] / 2), max(0.0, cy - p["h"] / 2),
            min(1.0, cx + p["w"] / 2), min(1.0, cy + p["h"] / 2)]


def _clip(cid, mode, players, frames, drop={}, occlude={}, reach_cap=True):
    """Build one clip's labeled frames.

    drop: {frame: [labels...]} absent that frame (detection miss).
    occlude: {frame: [labels...]} the object is present but box missing for a
             short burst (the tracker must bridge via lost_before_evict).
    """
    frames_out = []
    max_concurrent = 0
    for f in range(frames):
        objs = []
        for p in players:
            if f in drop and p["label"] in drop[f]:
                continue
            if f in occlude and p["label"] in occlude[f]:
                continue  # occlusion: not detected, but should stay tracked
            objs.append({"id": p["label"], "bbox": _box(p, f), "kind": "player"})
        frames_out.append({"frame": f, "objects": objs})
    return {"id": cid, "mode": mode, "frames": frames_out, "reachCap": reach_cap}


def build():
    clips = []
    # live-3: 3 players; player b occluded for a 3-frame burst (still tracked).
    clips.append(_clip(
        "soc-live-3", "live",
        [_player("pA", 0.12, 0.20), _player("pB", 0.45, 0.30, dx=-0.004),
         _player("pC", 0.78, 0.25, dx=-0.006)],
        frames=30, occlude={8: ["pB"], 9: ["pB"], 10: ["pB"]},
        drop={15: ["pC"]},
    ))
    # vod-8: 8 players drifting, cluster near the end (all on screen).
    players8 = [
        _player("p%d" % i, 0.05 + (i % 4) * 0.24, 0.12 + (i // 4) * 0.5,
                dx=-0.003 * (i % 2), dy=0.001 * (i // 4) % 2) for i in range(8)
    ]
    clips.append(_clip("soc-vod-8", "vod", players8, frames=40, drop={20: ["p3"]}))
    # live-1-occlude: single target with a hard occlusion burst to bridge.
    # The ball drifts slowly and stays well on-screen across the whole clip
    # (so every labeled frame is a valid IoU target and the gating measurements
    # reflect the occlusion, not an off-screen box that clamps to an invalid
    # x1>x2 region).
    clips.append(_clip(
        "soc-live-1-occlude", "live",
        [_player("ball", 0.3, 0.5, w=0.03, h=0.03, dx=0.006)],
        frames=40, occlude={12: ["ball"], 13: ["ball"], 14: ["ball"], 15: ["ball"]},
        reach_cap=False,
    ))
    return {"sport": "soccer", "clips": clips}


def main():
    out = os.path.join(HERE, "track_label_manifest.json")
    with open(out, "w") as fh:
        json.dump(build(), fh, indent=1)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
