"""Prove real Florence-2 <OD> detection on an actual photo (device-selectable).

Usage:
  .venv/Scripts/python.exe docker/florence_probe.py <image.png> [device]
device: auto | cpu | directml | cuda   (default auto)
"""
import sys, time, urllib.request

sys.path.insert(0, "services/perceive")
from app.florence import FlorenceDetector  # noqa: E402
from PIL import Image
import numpy as np

IMG = sys.argv[1] if len(sys.argv) > 1 else "docker/data/person.jpg"
DEV = sys.argv[2] if len(sys.argv) > 2 else "auto"

# fetch a real photo with people if the local path is missing
if IMG == "docker/data/person.jpg":
    urls = [
        "https://cocodataset.org/images/person-bike.jpg",
        "https://images.pexels.com/photos/1287986/pexels-photo-1287986.jpeg?auto=compress&h=500",  # group of people
    ]
    for u in urls:
        try:
            req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=20) as r, open(IMG, "wb") as f:
                f.write(r.read())
            print(f"downloaded {u}")
            break
        except Exception as e:
            print("fetch fail", u, e)

img = np.asarray(Image.open(IMG).convert("RGB"))
print("image", img.shape)

d = FlorenceDetector(device=DEV)
t0 = time.time()
d.load()
print("loaded on", d.device_label, f"{time.time()-t0:.1f}s")
t0 = time.time()
det = d.detect(img)
print(f"inference {time.time()-t0:.2f}s  -> {len(det)} objects")
for o in det[:12]:
    b = [round(x, 3) for x in o["bbox"]]
    print(f"  {o['label']:>20} {b}")
