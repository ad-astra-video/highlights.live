#!/usr/bin/env python3
"""Dense 1 s-step goalmouth scan for the kids_soccer eval (frame-only labeller).

Sends one upscaled frame per whole second to a vision endpoint and records the
goal-mouth action class for that second. The output is the raw evidence layer
the manifest windows cite: for every promoted window the ``frames`` field names
the seconds recorded here.

Why 2x upscaling: at the native 640x360 job frame the same model reported
``open_play`` for the labelled save at t=351-352 and ``ball_in_net`` for the
labelled save-only window at t=622. At 2x (1280x720) it read t=351 as
``goal_mouth_shot``, t=352 as ``keeper_save`` and t=622 as ``keeper_save``,
matching the manifest. Never label from a downscaled frame.

Endpoint: ``SCAN_API`` / ``SCAN_KEY`` env vars (``SCAN_MODEL`` optional). No key
is stored in this file, and the recorded JSONL holds only model output.

Usage
-----
  # one serial worker over the whole video (resumable: skips recorded seconds)
  python3 scan_goalmouth.py --frames /tmp/x2frames --from 0 --to 776 \
      --out results/goalmouth_scan_1s.jsonl

  # split across workers once concurrency has been verified on the endpoint
  python3 scan_goalmouth.py ... --offset 1 --stride 3 --out my_worker.jsonl
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import time

PROMPT = (
    "Soccer broadcast frame. Describe the goalmouth action in one sentence, then answer on a new line: "
    "ACTION=<goal_mouth_shot|keeper_save|ball_in_net|celebration|open_play|closeup_elsewhere>. "
    "A shot means the ball is travelling toward the goal mouth or a keeper/defender is reacting to a shot "
    "in the goal area."
)


def ask(path, api, key, model, timeout=120, max_tokens=200):
    b64 = base64.b64encode(open(path, 'rb').read()).decode()
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": PROMPT},
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b64}},
        ]}],
        "max_tokens": max_tokens,
        "temperature": 0,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    r = subprocess.run(
        ["curl", "-sS", "-m", str(timeout), api,
         "-H", "Content-Type: application/json",
         "-H", "Authorization: Bearer " + key,
         "--data-binary", "@-"],
        input=json.dumps(payload), capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("curl rc=%s %s" % (r.returncode, r.stderr[:120]))
    data = json.loads(r.stdout)
    content = data["choices"][0]["message"].get("content")
    if not content:
        raise RuntimeError("empty content, finish=%s" % data["choices"][0].get("finish_reason"))
    return content.strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--frames', required=True, help='dir with f_{t:04d}.jpg 2x frames')
    ap.add_argument('--from', dest='t0', type=int)
    ap.add_argument('--to', dest='t1', type=int)
    ap.add_argument('--seconds', help='comma-separated second list (instead of --from/--to)')
    ap.add_argument('--out', required=True)
    ap.add_argument('--offset', type=int, default=0)
    ap.add_argument('--stride', type=int, default=1)
    args = ap.parse_args()
    if bool(args.seconds) == (args.t0 is not None and args.t1 is not None):
        sys.exit('pass either --seconds or --from/--to')

    api = os.environ.get('SCAN_API', 'https://vllm.dpn.chat/v1/chat/completions')
    key = os.environ.get('SCAN_KEY')
    model = os.environ.get('SCAN_MODEL', 'deepseek-v4.1-flash')
    if not key:
        sys.exit('SCAN_KEY is required (no key is stored in the repo)')

    if args.seconds:
        ts = sorted({int(x) for x in args.seconds.split(',') if x.strip()})[args.offset::args.stride]
    else:
        assert args.t0 is not None and args.t1 is not None
        ts = list(range(args.t0, args.t1 + 1))[args.offset::args.stride]
    done = set()
    if os.path.exists(args.out):
        for line in open(args.out):
            try:
                done.add(json.loads(line)['t'])
            except Exception:
                pass
    todo = [t for t in ts if t not in done]
    print("todo=%d" % len(todo), flush=True)
    t0 = time.time()
    with open(args.out, 'a') as f:
        for i, t in enumerate(todo):
            txt = 'ERR'
            for attempt in range(3):
                try:
                    txt = ask(f"{args.frames}/f_{t:04d}.jpg", api, key, model)
                    break
                except Exception as e:
                    time.sleep(4)
                    if attempt == 2:
                        txt = 'ERR ' + str(e)[:60]
            f.write(json.dumps({"t": t, "read": txt}) + "\n")
            f.flush()
            print("%d/%d t=%d %s (%.0fs)" % (i + 1, len(todo), t, txt.replace("\n", " ")[:70],
                                             time.time() - t0), flush=True)
    print("done %.0fs" % (time.time() - t0), flush=True)


if __name__ == '__main__':
    main()
