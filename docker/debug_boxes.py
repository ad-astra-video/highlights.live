import glob, os, subprocess, sys
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "services", "perceive"))
from app.tracker import foreground_blobs

VOD = sys.argv[1]
FR = "/tmp/dbg_frames"
subprocess.run(["ffmpeg", "-y", "-i", VOD, "-vf", "fps=1,scale=320:180", "-q:v", "3",
                os.path.join(FR, "frame_%04d.jpg")], check=True, capture_output=True)
files = sorted(glob.glob(os.path.join(FR, "frame_*.jpg")))
prev = None
for i, f in enumerate(files):
    arr = np.asarray(Image.open(f).convert("L"), dtype=np.float32)
    boxes = foreground_blobs(arr, prev)
    prev = arr
    print(f"frame {i}: nonzeros={int((arr>5).sum())} boxes=" + str([[round(x,3) for x in b] for b in boxes]))
