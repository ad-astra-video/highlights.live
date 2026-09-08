#!/usr/bin/env python3
"""Generate a synthetic 'game clip' for local end-to-end testing: a bright box
moving fast across a dark field. The perceive IoU-blob tracker sees a moving
track, accumulates displacement, and (beyond the KILL threshold) emits a KILL
candidate -> decide flags a highlight -> the worker cuts a clip around it.

Usage: gen_vod.py [output.mp4]  (native path; default ./test_vod.mp4)
"""
import os
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image

W, H, FPS, DUR = 320, 180, 1, 8  # 1 fps -> 8 frames
FRAMES = int(DUR * FPS)
SIZE = 16
out = sys.argv[1] if len(sys.argv) > 1 else "test_vod.mp4"

tmpdir = tempfile.mkdtemp(prefix="vod_")
x = float(W * 0.15)
y = float(H * 0.35)
step = 0.08  # move 8% per frame -> |dx|+|dy| ~0.16/frame (> tracker FAST_STEP 0.15) -> KILL candidate

for i in range(FRAMES):
    img = Image.new("L", (W, H), 0)
    px = img.load()
    for yy in range(int(y), min(H, int(y) + SIZE)):
        for xx in range(int(x), min(W, int(x) + SIZE)):
            px[xx, yy] = 255
    img.save(os.path.join(tmpdir, f"f{i:03d}.png"))
    x += step * W
    y += step * H

subprocess.run(
    ["ffmpeg", "-y", "-framerate", str(FPS), "-i", os.path.join(tmpdir, "f%03d.png"),
     "-c:v", "libx264", "-pix_fmt", "yuv420p", out],
    check=True, capture_output=True,
)
print(out)
