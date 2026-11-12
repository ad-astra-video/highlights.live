# Calibration pass (pre-grid probe) — ADAAAA-8744 WP3

The first pass over the grid used sensitivity spread 0.03/0.05/0.08/0.12 (dwell 2/3/4),
run only to see where the bands' change scores actually sit before fixing the reported
grid's range. It is kept because it shows the same result as the reported grid — no cell
clears A1-A4 — and because `hud_grid_calibration_pass.json` is the `--diagnose` table the
reported grid was centred on (at-rest p50 0.067-0.105, p95 0.174-0.238).

Exports here are the probe cells' candidate files. The `exportPath` values recorded inside
`hud_grid_calibration_pass.json` were written when these files sat one directory up; the
files themselves now live here with the same names. The reported 12-cell grid is
`../hud_grid.json` / `../hud_grid.md`.
