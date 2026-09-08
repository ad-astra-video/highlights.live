import base64, glob, os, subprocess, sys
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "services", "perceive"))
from app import app

VOD = sys.argv[1]
FR = "/tmp/dbg_frames"
os.makedirs(FR, exist_ok=True)
subprocess.run(["ffmpeg", "-y", "-i", VOD, "-vf", "fps=1,scale=320:180", "-q:v", "3",
                os.path.join(FR, "frame_%04d.jpg")], check=True, capture_output=True)
files = sorted(glob.glob(os.path.join(FR, "frame_*.jpg")))
print("frames:", len(files))

c = TestClient(app)
for i, f in enumerate(files):
    b64 = base64.b64encode(open(f, "rb").read()).decode()
    r = c.post("/app/analyze", json={"seq": i, "timestamp": float(i), "image": b64},
               headers={"X-Session-Id": "dbg"})
    body = r.json()
    cand = body.get("candidate") if isinstance(body, dict) else None
    tracks = body.get("tracks", []) if isinstance(body, dict) else []
    if cand:
        print(f"frame {i}: CANDIDATE {cand}")
    else:
        print(f"frame {i}: tracks={len(tracks)} " + str([(t['slot'], [round(x,2) for x in t['bbox']]) for t in tracks]))
