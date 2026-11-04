import sys, glob, json
sys.path.insert(0, "/srv/perceive")
from PIL import Image
import numpy as np
from app.florence import FlorenceDetector
from app.scoreboard import ScoreboardRoi

JOB = "6ab5647e-954a-4ca6-9b6a-1ddb7bab6992"
REGIONS = {
    "bottom_band": (0.0, 0.78, 1.0, 0.94),
    "bottom_left": (0.0, 0.78, 0.50, 0.92),
    "bottom_right": (0.50, 0.78, 1.0, 0.94),
    "top_band": (0.0, 0.0, 1.0, 0.25),
}
d = FlorenceDetector()
d.load()
frames = sorted(glob.glob("/data/frames/%s/frame_*.jpg" % JOB))[:12]
for fi, path in enumerate(frames, start=1):
    img = np.array(Image.open(path).convert("RGB"))
    row = {"frame": fi}
    for name, box in REGIONS.items():
        try:
            row[name] = d.ocr(img, roi=ScoreboardRoi(*box))
        except Exception as e:
            row[name] = ["ERR %r" % (e,)]
    print(json.dumps(row), flush=True)
print("DONE", flush=True)
