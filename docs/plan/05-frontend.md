# Chunk 05 — Frontend (operator app first)

Source: plan §5. Browser never opens trickle itself.

1. Jobs + upload (VOD uses hidden persistent session).
2. Review player, accept/reject.
3. Frame debugger: filmstrip + Florence boxes + two SAM3 boxes.
4. Live console: <video> of source, overlay from GET /streams/:id/live SSE, WS-style controls POSTed to /streams/:id/control (server writes onto trickle control or runner WS).
Controls the UI may send: preferLabels, seed, evict, lock, confirm.
Public feed stays on accepted clips only.

## STATUS
- webapp (Vite+React+Tailwind v4, auth login/register, billing, dashboard, landing): DONE.
- Live source controls (start live for screenshare/rtmp/webrtc, poll job status, stop): DONE (per git log; Dashboard).
- Review player with accept/reject: PARTIAL — review API exists (/highlights/:id/review); need to confirm a UI review queue renders clips + accept/reject.
- Frame debugger filmstrip + boxes overlay: NOT DONE.
- Live console overlay + /streams/:id/live SSE + control POST: NOT DONE.
- Public feed (accepted clips only): NOT DONE.
