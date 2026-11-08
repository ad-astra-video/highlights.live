#!/usr/bin/env python3
"""ADAAAA-8371 offline decide eval — live 320x180 vs 768x432 at budget 280, multi-clip.

Cells (per rail), on the frozen 37-window kids_soccer manifest:
  live (compact contract, 30 frames): ctrl 280@320x180, 280@768x432,
                                      140@768x432, 70@768x432
  vod  (full contract,  40 frames):  ctrl 280@640x360, 280@1080x608,
                                      140@1080x608, 70@1080x608

Method (why the deltas are attributable)
- Perceive evidence is generated ONCE per (rail, window) by the deployed
  /analyze on a 1 s frame grid, folded exactly like services/server/src/
  analyzer.ts, then held BYTE-IDENTICAL across every cell of that rail. Only
  the image parts (source scale) and mm_processor_kwargs.max_soft_tokens vary.
- The prompt TEXT is built by the DEPLOYED decide module itself
  (app.gemma.build_prompt_parts inside highlights-decide) with the same
  arguments the deployed call uses (has_audio=False, transcript='',
  story_so_far=''), and the wire mirrors app/gemma.py: content = frames +
  images (all image parts first), then the text part = parts["context"];
  system = parts["system"]; temperature 0; thinking off;
  max_tokens 400 (compact) / 1200 (full).
- The deployed decide app's own verdict on a SAMPLE of windows is kept as an
  independent fidelity check against the replayed control cell.
- Frames are extracted once per (n_frames, scale) and cached; evidence and
  control decisions are cached too, and rows append to --out, so a killed run
  resumes instead of restarting.
- $0: direct /v1/chat/completions against the deployed gemma container, no
  Livepeer job, no config change.

Rail order is live-then-vod, so a run that dies mid-way still yields a complete
live verdict.
"""
import argparse
import base64
import glob
import http.client
import json
import os
import subprocess
import sys
import tempfile
import time
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import drive_decide_cycle as D  # noqa: E402  (shipped alongside)

GEMMA = os.environ.get("GEMMA_HOST", "172.20.0.14")
GEMMA_PORT = int(os.environ.get("GEMMA_PORT", "8088"))
MODEL = "cyankiwi/gemma-4-12B-it-qat-AWQ-INT4"

RAILS = {
    "live": {"frames": 30, "ctrl_scale": "320x180", "match_scale": "768x432",
             "compact": True, "max_tokens": 400},
    "vod":  {"frames": 40, "ctrl_scale": "640x360", "match_scale": "1080x608",
             "compact": False, "max_tokens": 1200},
}
CELLS = {
    "live": [("live_ctrl_280_320x180", 280, "ctrl"),
             ("live_280_768x432", 280, "match")],
}


def b64file(path):
    with open(path, "rb") as fh:
        return base64.b64encode(fh.read()).decode()


def extract_cached(clip, scale, n, start, dur, cache_dir, wid):
    """30/40 JPEG frames at `scale` for one window, extracted once and reused."""
    d = os.path.join(cache_dir, "frames", f"{n}_{scale}", wid)
    marker = os.path.join(d, "DONE")
    files = lambda: sorted(glob.glob(os.path.join(d, "f_*.jpg")))  # noqa: E731
    if os.path.exists(marker):
        got = files()
        if len(got) == n:
            return [b64file(f) for f in got]
    os.makedirs(d, exist_ok=True)
    for f in files():
        os.unlink(f)
    w, h = scale.split("x")
    fps = n / dur if dur > 0 else 1.0
    subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{start:.3f}", "-i", clip,
                    "-t", f"{dur:.3f}", "-vf", f"fps={fps:.6f},scale={w}:{h}",
                    "-q:v", "3", "-frames:v", str(n), "-y",
                    os.path.join(d, "f_%04d.jpg")],
                   check=True, capture_output=True)
    got = files()
    if len(got) != n:
        raise RuntimeError(f"extract {wid} {scale}: {len(got)} != {n} frames")
    open(marker, "w").write(str(n))
    return [b64file(f) for f in got]


def vllm(budget, imgs, system, user_text, max_tokens):
    """Direct deployed-gemma call, streamed, so TTFT is prefill not wall."""
    content = [{"type": "image_url",
                "image_url": {"url": "data:image/jpeg;base64," + b}} for b in imgs]
    content.append({"type": "text", "text": user_text})
    body = {"model": MODEL,
            "messages": [{"role": "system", "content": system},
                         {"role": "user", "content": content}],
            "temperature": 0.0, "reasoning_effort": "none",
            "chat_template_kwargs": {"enable_thinking": False},
            "max_tokens": max_tokens, "stream": True,
            "stream_options": {"include_usage": True},
            "mm_processor_kwargs": {"max_soft_tokens": budget}}
    t0 = time.time()
    conn = http.client.HTTPConnection(GEMMA, GEMMA_PORT, timeout=900)
    try:
        conn.request("POST", "/v1/chat/completions", body=json.dumps(body),
                     headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        if resp.status != 200:
            raw = resp.read().decode()[:400]
            conn.close()
            return {"ok": False, "status": resp.status, "error": raw,
                    "wall_s": round(time.time() - t0, 3)}
        ttft = None
        chunks, usage = [], None
        for line in resp:
            s = line.decode("utf-8", "replace").strip()
            if not s.startswith("data:"):
                continue
            data = s[5:].strip()
            if data == "[DONE]":
                break
            try:
                obj = json.loads(data)
            except Exception:  # noqa: BLE001
                continue
            if obj.get("usage"):
                usage = obj["usage"]
            ch = obj.get("choices") or []
            if ch:
                c = (ch[0].get("delta") or {}).get("content")
                if c:
                    if ttft is None:
                        ttft = time.time() - t0
                    chunks.append(c)
        conn.close()
    except Exception as e:  # noqa: BLE001
        conn.close()
        return {"ok": False, "error": f"connect: {e}", "wall_s": round(time.time() - t0, 3)}
    wall = round(time.time() - t0, 3)
    return {"ok": True, "text": "".join(chunks), "usage": usage,
            "ttft_s": round(ttft, 3) if ttft is not None else None, "wall_s": wall}


def build_parts(items):
    """Run the DEPLOYED build_prompt_parts for each (evidence, n_frames, compact)."""
    code = (
        "import json,sys\n"
        "sys.path.insert(0,'/srv/decide')\n"
        "from app.gemma import build_prompt_parts\n"
        "items=json.load(sys.stdin)\n"
        "out=[]\n"
        "for it in items:\n"
        "    p=build_prompt_parts(it['eventType'], it['evidence'], 'soccer',\n"
        "        n_frames=it['n_frames'], has_audio=False, transcript='',\n"
        "        story_so_far='', compact=it['compact'])\n"
        "    out.append({'key':it['key'],'system':p['system'],'context':p['context'],\n"
        "                'prompt_len':len(p['prompt'])})\n"
        "json.dump(out,sys.stdout)\n"
    )
    p = subprocess.run(["docker", "exec", "-i", "highlights-decide", "python3", "-c", code],
                       input=json.dumps(items).encode(), capture_output=True)
    if p.returncode != 0:
        print("build_parts failed:", p.stderr.decode()[:800], file=sys.stderr)
        sys.exit(1)
    return json.loads(p.stdout.decode())


def decide_app(url, sid, event_type, center, evidence, frames_b64, game_hint, compact):
    """The deployed decide app, with the compact flag the rail actually sends."""
    payload = {
        "sessionId": sid, "eventType": event_type, "timestamp": center,
        "gameHint": game_hint, "evidence": evidence,
        "images": [{"role": "full", "base64": frames_b64[-1]}] if frames_b64 else [],
        "frames": [{"role": "full", "base64": b} for b in frames_b64],
        "reasoningEffort": "none", "compact": compact,
    }
    t0 = time.time()
    try:
        out = D.http_json(f"{url}/highlight", payload, timeout=600.0)
    except Exception as e:  # noqa: BLE001
        return {"isHighlight": False, "outcome": "error",
                "reason": f"decide transport error: {e}"}, round(time.time() - t0, 3)
    return out, round(time.time() - t0, 3)


def clip_of(args, w):
    """A manifest window carries its own clip; multi-clip corpora are the point."""
    return w.get("clip") or args.clip


def evidence_for(rail, cfg, w, args, audio, cache_dir):
    """Deployed-perceive evidence for one window, cached and rail-specific."""
    wid = w["id"]
    path = os.path.join(cache_dir, "evidence", rail, f"{wid}.json")
    if os.path.exists(path):
        return json.load(open(path))
    start, end = float(w["t_start"]), float(w["t_end"])
    dur = max(0.5, end - start)
    center = round((start + end) / 2.0, 3)
    sid = f"eval8343-{rail}-{wid}-{uuid.uuid4().hex[:6]}"
    n_ev = max(2, int(round(dur)))
    with tempfile.TemporaryDirectory(prefix="ev8343_") as td:
        ev_frames = extract_cached_plain(clip_of(args, w), cfg["ctrl_scale"], n_ev, start, dur, td)
    sigs = []
    for i, b in enumerate(ev_frames):
        ts = round(start + i * dur / max(1, len(ev_frames) - 1), 3)
        try:
            obs, _cand = D.analyze_frame(args.perceive, sid, i, ts, b,
                                         args.game_hint, ["player", "soccer ball", "goal"])
        except Exception as e:  # noqa: BLE001
            print(f"  perceive err {rail} {wid}@{i}: {e}", flush=True)
            continue
        sig = D.observation_signal(obs if isinstance(obs, dict) else {})
        sig["ts"] = ts
        sigs.append(sig)
    audio_map = audio if isinstance(audio, dict) else {args.clip: audio}
    ce, kind, levels = D.crowd_energy(audio_map[clip_of(args, w)], center)
    reaction = {"crowdEnergy": ce, "audioKind": kind,
                "humansInMotion": max((len(s["tracks"]) for s in sigs), default=0),
                "ballSpeedMps": round(max((s["ballVelocity"] for s in sigs), default=0.0), 4),
                "ballPossessionId": next((s["ballPossession"] for s in sigs
                                          if s["ballPossession"]), "")}
    evidence = D.fold_window_evidence(sigs, reaction, levels)
    out = {"window": wid, "rail": rail, "center": center, "n_ev_frames": len(ev_frames),
           "n_sig": len(sigs), "evidence": evidence}
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(out, open(path, "w"))
    return out


def extract_cached_plain(clip, scale, n, start, dur, td):
    """One-off extraction into a throwaway dir (the 1 s evidence grid)."""
    w, h = scale.split("x")
    fps = n / dur if dur > 0 else 1.0
    subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{start:.3f}", "-i", clip,
                    "-t", f"{dur:.3f}", "-vf", f"fps={fps:.6f},scale={w}:{h}",
                    "-q:v", "3", "-frames:v", str(n), "-y",
                    os.path.join(td, "e_%03d.jpg")],
                   check=True, capture_output=True)
    fs = sorted(f for f in os.listdir(td) if f.startswith("e_"))
    return [b64file(os.path.join(td, f)) for f in fs]


def control_sample(wins, n):
    """Deterministic spread of windows for the fidelity sample."""
    if n <= 0 or n >= len(wins):
        return list(wins)
    if n == 1:
        return [wins[0]]
    step = (len(wins) - 1) / (n - 1)
    return [wins[int(round(k * step))] for k in range(n)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--clip", default="/home/brad/videojev-pilot/clips/kids-soccer.mp4")
    ap.add_argument("--perceive", default="http://172.20.0.5:8080")
    ap.add_argument("--decide", default="http://172.20.0.12:8081")
    ap.add_argument("--game-hint", default="soccer")
    ap.add_argument("--cache", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--rails", default="live,vod")
    ap.add_argument("--cells", default="", help="comma list to restrict cells")
    ap.add_argument("--control-limit", type=int, default=6,
                    help="fidelity sample size per rail (0 = skip the app call)")
    ap.add_argument("--limit", type=int, default=0, help="first N windows only (pilot)")
    ap.add_argument("--no-warmup", action="store_true")
    args = ap.parse_args()

    manifest = json.load(open(args.manifest))
    wins = manifest["windows"][: args.limit or None]
    only = {c.strip() for c in args.cells.split(",") if c.strip()}
    os.makedirs(args.cache, exist_ok=True)

    done = set()
    if os.path.exists(args.out):
        for line in open(args.out):
            try:
                r = json.loads(line)
                done.add((r["cell"], r["window"]))
            except Exception:  # noqa: BLE001
                pass
    print(f"windows={len(wins)} rails={args.rails} resume_skip={len(done)}", flush=True)

    clips_seen = []
    for w in wins:
        c = clip_of(args, w)
        if c not in clips_seen:
            clips_seen.append(c)
    audio = {}
    for c in clips_seen:
        audio[c] = D.load_rms_series(c)
        print(f"audio {c} seconds={len(audio[c])}", flush=True)
    prov = {
        "manifest": os.path.basename(args.manifest),
        "manifest_sha256": subprocess.run(["sha256sum", args.manifest],
                                          capture_output=True, text=True).stdout.split()[0],
        "clips": {c: {"sha256": subprocess.run(["sha256sum", c],
                                              capture_output=True, text=True).stdout.split()[0],
                      "bytes": os.path.getsize(c)} for c in clips_seen},
        "gemma": {"host": GEMMA, "port": GEMMA_PORT, "model": MODEL,
                  "image": subprocess.run(["docker", "inspect", "highlights-gemma",
                                           "-f", "{{.Image}}"],
                                          capture_output=True, text=True).stdout.strip(),
                  "cmd": json.loads(subprocess.run(["docker", "inspect", "highlights-gemma",
                                                    "-f", "{{json .Config.Cmd}}"],
                                                   capture_output=True, text=True).stdout)},
        "decide_image": subprocess.run(["docker", "inspect", "highlights-decide",
                                        "-f", "{{.Image}}"],
                                       capture_output=True, text=True).stdout.strip(),
        "perceive_image": subprocess.run(["docker", "inspect", "highlights-perceive",
                                          "-f", "{{.Image}}"],
                                         capture_output=True, text=True).stdout.strip(),
        "rails": RAILS, "cells": CELLS, "started": time.strftime("%Y-%m-%dT%H:%M:%SZ",
                                                                time.gmtime()),
    }
    json.dump(prov, open(os.path.join(args.cache, "provenance.json"), "w"), indent=1)
    print("provenance:", json.dumps({k: prov[k] for k in
                                     ("manifest_sha256", "decide_image", "perceive_image")}),
          flush=True)

    for rail in [r.strip() for r in args.rails.split(",") if r.strip()]:
        cfg = RAILS[rail]
        # ---------------- evidence, once per rail -------------------
        ev = {}
        t0 = time.time()
        for w in wins:
            ev[w["id"]] = evidence_for(rail, cfg, w, args, audio, args.cache)
        print(f"[{rail}] evidence ready for {len(ev)} windows in "
              f"{round(time.time() - t0, 1)}s", flush=True)

        # ---------------- fidelity sample: the deployed decide app ---
        cpath = os.path.join(args.cache, "control", f"{rail}.json")
        ctrl = json.load(open(cpath)) if os.path.exists(cpath) else {}
        sample = control_sample(wins, args.control_limit)
        for w in sample:
            wid = w["id"]
            if wid in ctrl:
                continue
            start, end = float(w["t_start"]), float(w["t_end"])
            dur = max(0.5, end - start)
            imgs = extract_cached(clip_of(args, w), cfg["ctrl_scale"], cfg["frames"],
                                  start, dur, args.cache, wid)
            dec, lat = decide_app(args.decide, f"eval8343-app-{rail}-{wid}", "SPORTING_EVENT",
                                  ev[wid]["center"], ev[wid]["evidence"], imgs,
                                  args.game_hint, cfg["compact"])
            ctrl[wid] = {"decision": dec, "latency_s": lat, "n_img": len(imgs)}
            print(f"  app[{rail}] {wid} outcome={dec.get('outcome')} "
                  f"isHL={dec.get('isHighlight')} lat={lat}s", flush=True)
            os.makedirs(os.path.dirname(cpath), exist_ok=True)
            json.dump(ctrl, open(cpath, "w"), indent=1)

        # ---------------- prompts for this rail ---------------------
        items = [{"key": f"{rail}|{w['id']}", "eventType": "SPORTING_EVENT",
                  "evidence": ev[w["id"]]["evidence"], "n_frames": cfg["frames"],
                  "compact": cfg["compact"]} for w in wins]
        parts = {p["key"]: p for p in build_parts(items)}
        print(f"[{rail}] prompts built={len(parts)}/{len(items)} "
              f"sys_chars={len(parts[items[0]['key']]['system'])}", flush=True)

        # ---------------- the cells --------------------------------
        for cell, budget, kind in CELLS[rail]:
            if only and cell not in only:
                continue
            scale = cfg["ctrl_scale"] if kind == "ctrl" else cfg["match_scale"]
            todo = [w for w in wins if (cell, w["id"]) not in done]
            if not todo:
                print(f"  {cell}: already complete", flush=True)
                continue
            if not args.no_warmup:
                w0 = todo[0]
                try:
                    wi = extract_cached(clip_of(args, w0), scale, cfg["frames"],
                                        float(w0["t_start"]),
                                        max(0.5, float(w0["t_end"]) - float(w0["t_start"])),
                                        args.cache, w0["id"])
                    p0 = parts[f"{rail}|{w0['id']}"]
                    vllm(budget, wi + [wi[-1]], p0["system"], p0["context"], cfg["max_tokens"])
                except Exception as e:  # noqa: BLE001
                    print(f"  warm fail {cell}: {e}", flush=True)
                print(f"  warm {cell} scale={scale}", flush=True)
            for w in todo:
                wid = w["id"]
                p = parts[f"{rail}|{wid}"]
                imgs = extract_cached(clip_of(args, w), scale, cfg["frames"],
                                      float(w["t_start"]),
                                      max(0.5, float(w["t_end"]) - float(w["t_start"])),
                                      args.cache, wid)
                imgs = imgs + [imgs[-1]]          # deployed wire: frames + images=[last]
                res = vllm(budget, imgs, p["system"], p["context"], cfg["max_tokens"])
                if not res.get("ok"):
                    time.sleep(2)
                    res = vllm(budget, imgs, p["system"], p["context"], cfg["max_tokens"])
                row = {"cell": cell, "rail": rail, "budget": budget, "scale": scale,
                       "window": wid, "n_img": len(imgs), "evidence_key": f"{rail}|{wid}",
                       "sys_chars": len(p["system"]), "ctx_chars": len(p["context"]),
                       "app_decision": ctrl.get(wid, {}).get("decision"),
                       "raw": res.get("text"), "usage": res.get("usage"),
                       "ttft_s": res.get("ttft_s"), "wall_s": res.get("wall_s"),
                       "error": res.get("error"), "at": time.strftime("%H:%M:%S"),
                       "run": os.environ.get("PAPERCLIP_RUN_ID", "")}
                with open(args.out, "a") as f:
                    f.write(json.dumps(row) + "\n")
                print(f"  {cell} {wid} n={len(imgs)} "
                      f"pt={(res.get('usage') or {}).get('prompt_tokens')} "
                      f"ok={res.get('ok')} ttft={res.get('ttft_s')} wall={res.get('wall_s')} "
                      f"err={(res.get('error') or '')[:50]}", flush=True)
            print(f"  {cell} DONE", flush=True)

    print("all cells complete", flush=True)


if __name__ == "__main__":
    main()
