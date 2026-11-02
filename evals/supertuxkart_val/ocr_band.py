"""OCR reader pass over one band of the SuperTuxKart half of the CC0 onFOSS clip.

Usage: python3 ocr_band.py <band>
Writes <scratch>/ocr_<band>.json
"""
import glob
import json
import os
import sys
import time

from PIL import Image
import numpy as np
from rapidocr_onnxruntime import RapidOCR

S = os.environ["PAPERCLIP_RUN_SCRATCH_DIR"]
T0 = 4380
band = sys.argv[1]
SCALE = {"clock": 4, "banner": 6, "gp": 4}[band]

files = sorted(glob.glob(f"{S}/frames/{band}/*.jpg"))
ocr = RapidOCR()
recs = []
t0 = time.time()
for i, f in enumerate(files):
    im = Image.open(f).convert("RGB")
    im = im.resize((im.width * SCALE, im.height * SCALE), Image.LANCZOS)
    res, _ = ocr(np.array(im))
    # NOTE: OCR boxes for these crops are far outside the image; the reader is
    # used as "what text does this band show", not as a locator.
    recs.append({"t": T0 + i,
                 "texts": [[str(txt), round(float(c), 3)] for b, txt, c in (res or [])]})
    if i and i % 200 == 0:
        print(band, i, "%.0fs" % (time.time() - t0), flush=True)

json.dump(recs, open(f"{S}/ocr_{band}.json", "w"))
print("DONE", band, len(files), "%.0fs" % (time.time() - t0))
