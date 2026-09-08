import base64, glob, os, subprocess, sys
import httpx

VOD = sys.argv[1] if len(sys.argv) > 1 else "/tmp/v.mp4"
FR = sys.argv[2] if len(sys.argv) > 2 else "/tmp/frames2"
os.makedirs(FR, exist_ok=True)
subprocess.run(["ffmpeg", "-y", "-i", VOD, "-vf", "fps=1,scale=320:180", "-q:v", "3",
                os.path.join(FR, "frame_%04d.jpg")], check=True, capture_output=True)

files = sorted(glob.glob(os.path.join(FR, "frame_*.jpg")))
print("frames:", len(files))
sid = "debug-sess"
c = httpx.Client(base_url="http://127.0.0.1:8090")
for i, f in enumerate(files):
    b64 = base64.b64encode(open(f, "rb").read()).decode()
    r = c.post("/app/analyze", json={"seq": i, "timestamp": float(i), "image": b64},
               headers={"X-Session-Id": sid})
    body = r.json()
    cand = body.get("candidate") if isinstance(body, dict) else None
    tracks = body.get("tracks", [])
    if cand:
        print(f"frame {i}: CANDIDATE {cand} tracks={len(tracks)}")
    elif tracks:
        print(f"frame {i}: tracks={[ (t['slot'], [round(x,2) for x in t['bbox']]) for t in tracks ]}")
    else:
        print(f"frame {i}: no tracks")
