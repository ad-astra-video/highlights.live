#!/usr/bin/env python3
"""Build 1 s-step contact sheets from cached job frames (kids_soccer eval).

Each sheet is a grid of frames taken at consecutive seconds (``t`` = whole
second, frame file ``f_{t:04d}.jpg`` = job frame ``seq = 3*t``). Every cell is
labelled with its timestamp so a reviewer can cite the exact second a call is
made on, which is what the manifest's ``frames`` field carries.

Usage
-----
  # dense whole-segment scan, 28 s per sheet
  python3 build_contact_sheet.py --frames /tmp/frames --out /tmp/sheets \
      --from 336 --to 777 --per-sheet 28

  # window inspection: one row per window at 1 s steps
  python3 build_contact_sheet.py --frames /tmp/frames --out /tmp/sheets \
      --windows 45,66,84 --pad 3
"""
import argparse
import os

from PIL import Image, ImageDraw, ImageFont

CELL_W, CELL_H = 320, 180
LABEL_H = 16


def frame(frames_dir, t):
    path = f"{frames_dir}/f_{t:04d}.jpg"
    if not os.path.exists(path):
        return None
    im = Image.open(path).convert("RGB")
    if im.size != (CELL_W, CELL_H):
        im = im.resize((CELL_W, CELL_H))
    return im


def label(im, text, color=(255, 255, 0)):
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, len(text) * 6 + 6, LABEL_H - 3], fill=(0, 0, 0))
    d.text((3, 2), text, fill=color, font=ImageFont.load_default())
    return im


def dense(frames_dir, out, t0, t1, per_sheet, cols, quality):
    rows = (per_sheet + cols - 1) // cols
    for bi, start in enumerate(range(t0, t1 + 1, per_sheet)):
        stem = f"dense_{start:04d}_{min(start + per_sheet - 1, t1):04d}"
        path = f"{out}/{stem}.jpg"
        if os.path.exists(path):
            print("skip", path)
            continue
        sheet = Image.new("RGB", (CELL_W * cols, (CELL_H + LABEL_H) * rows), (12, 12, 12))
        for i in range(per_sheet):
            t = start + i
            if t > t1:
                break
            im = frame(frames_dir, t)
            if im is None:
                im = Image.new("RGB", (CELL_W, CELL_H), (40, 0, 0))
            label(im, f"t={t}s")
            sheet.paste(im, ((i % cols) * CELL_W, (i // cols) * (CELL_H + LABEL_H)))
        sheet.save(path, quality=quality)
        print("wrote", path, sheet.size)


def windows(frames_dir, out, mids, pad, tail_pad, cols, quality):
    rows = []
    for mid in mids:
        cells = []
        for t in range(mid - pad, mid + tail_pad + 1):
            im = frame(frames_dir, t)
            if im is None:
                im = Image.new("RGB", (CELL_W, CELL_H), (40, 0, 0))
            label(im, f"t={t}s")
            cells.append(im)
        rows.append((mid, cells))
    width = CELL_W * max(cols, len(rows[0][1]))
    sheet = Image.new("RGB", (width, (CELL_H + LABEL_H) * len(rows)), (12, 12, 12))
    d = ImageDraw.Draw(sheet)
    for r, (mid, cells) in enumerate(rows):
        y = r * (CELL_H + LABEL_H)
        for c, im in enumerate(cells):
            sheet.paste(im, (c * CELL_W, y))
        d.text((width - 90, y + 2), f"w={mid}s", fill=(0, 255, 128),
               font=ImageFont.load_default())
    path = f"{out}/rows_{mids[0]:04d}_{mids[-1]:04d}.jpg"
    sheet.save(path, quality=quality)
    print("wrote", path, sheet.size, len(rows), "rows")


def main():
    global CELL_W, CELL_H
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--from", dest="t0", type=int)
    ap.add_argument("--to", dest="t1", type=int)
    ap.add_argument("--per-sheet", type=int, default=28)
    ap.add_argument("--cols", type=int, default=7)
    ap.add_argument("--cell-w", type=int, default=CELL_W)
    ap.add_argument("--cell-h", type=int, default=CELL_H)
    ap.add_argument("--quality", type=int, default=84)
    ap.add_argument("--windows", default=None,
                    help="comma separated window mids; one row per window")
    ap.add_argument("--pad", type=int, default=3, help="seconds before the mid")
    ap.add_argument("--tail-pad", type=int, default=5, help="seconds after the mid")
    args = ap.parse_args()
    CELL_W, CELL_H = args.cell_w, args.cell_h
    os.makedirs(args.out, exist_ok=True)
    if args.windows:
        mids = [int(x) for x in args.windows.split(",")]
        windows(args.frames, args.out, mids, args.pad, args.tail_pad, args.cols, args.quality)
    else:
        if args.t0 is None or args.t1 is None:
            ap.error("--from and --to are required without --windows")
        dense(args.frames, args.out, args.t0, args.t1, args.per_sheet, args.cols, args.quality)


if __name__ == "__main__":
    main()
