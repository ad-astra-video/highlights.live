# HUD operating-point grid (ADAAAA-8744 WP3)

- clip sha256: `3da355cc6ffc5e0fa5bbffa25c3025b165cee7bbddd3e96b8f0746a11801b264` (checked before and after)
- manifest sha256: `d19a2240578ba6760d9634cd9932cd48ae49bd245b7085140711c6f1bca73d23` (pinned `d19a2240578ba6760d9634cd9932cd48ae49bd245b7085140711c6f1bca73d23`, checked before and after)
- labelled window: 4429.67-5699 s (1269 s), 1269 frames at 1 fps
- match window: -3 s / +2 s (oracle default)

## Grid

| cell | sensitivity | dwell | candidates (in-window) | recall | A1 | FP rate | A2 | silent windows | A3 | candidates/min | A4 | clears |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `s0.08_d2` | 0.08 | 2 | 5 | 0.07 (1/15) | FAIL | 0.8000 | FAIL | 13/13 | pass | 0.24 | pass | no |
| `s0.08_d3` | 0.08 | 3 | 7 | 0.00 (0/15) | FAIL | 1.0000 | FAIL | 12/13 | pass | 0.33 | pass | no |
| `s0.08_d4` | 0.08 | 4 | 7 | 0.00 (0/15) | FAIL | 1.0000 | FAIL | 11/13 | pass | 0.33 | pass | no |
| `s0.12_d2` | 0.12 | 2 | 55 | 0.13 (2/15) | FAIL | 0.9636 | FAIL | 3/13 | FAIL | 2.60 | FAIL | no |
| `s0.12_d3` | 0.12 | 3 | 47 | 0.13 (2/15) | FAIL | 0.9574 | FAIL | 3/13 | FAIL | 2.22 | FAIL | no |
| `s0.12_d4` | 0.12 | 4 | 43 | 0.20 (3/15) | FAIL | 0.9302 | FAIL | 4/13 | FAIL | 2.03 | FAIL | no |
| `s0.18_d2` | 0.18 | 2 | 43 | 0.07 (1/15) | FAIL | 0.9767 | FAIL | 5/13 | FAIL | 2.03 | FAIL | no |
| `s0.18_d3` | 0.18 | 3 | 36 | 0.13 (2/15) | FAIL | 0.9444 | FAIL | 6/13 | FAIL | 1.70 | FAIL | no |
| `s0.18_d4` | 0.18 | 4 | 33 | 0.13 (2/15) | FAIL | 0.9394 | FAIL | 6/13 | FAIL | 1.56 | FAIL | no |
| `s0.25_d2` | 0.25 | 2 | 28 | 0.07 (1/15) | FAIL | 0.9286 | FAIL | 8/13 | FAIL | 1.32 | pass | no |
| `s0.25_d3` | 0.25 | 3 | 22 | 0.07 (1/15) | FAIL | 0.9091 | FAIL | 9/13 | FAIL | 1.04 | pass | no |
| `s0.25_d4` | 0.25 | 4 | 21 | 0.07 (1/15) | FAIL | 0.9524 | FAIL | 9/13 | FAIL | 0.99 | pass | no |

## Band change-score calibration

| band | window | max score | p50 | p95 | frames |
| --- | --- | --- | --- | --- | --- |
| `race-clock` | whole window (frame-to-frame) | 0.4888 | 0.0669 | 0.2109 | 1268 |
| `race-clock` | within +/-1 s of a labelled instant | 0.3423 | 0.0964 | 0.2804 | 38 |
| `centre-banner` | whole window (frame-to-frame) | 0.4548 | 0.1050 | 0.2382 | 1268 |
| `centre-banner` | within +/-1 s of a labelled instant | 0.2322 | 0.1188 | 0.1711 | 38 |
| `grand-prix-panel` | whole window (frame-to-frame) | 0.5174 | 0.0780 | 0.1737 | 1268 |
| `grand-prix-panel` | within +/-1 s of a labelled instant | 0.1419 | 0.0878 | 0.1281 | 38 |

## Latch trace

cell s0.08/d2 — 5 candidates in the window

| band | latched frames | window frames | first latch t |
| --- | --- | --- | --- |
| `race-clock` | 1256 | 1269 | 4431 |
| `centre-banner` | 1267 | 1269 | 4431 |
| `grand-prix-panel` | 1259 | 1269 | 4435 |

| event | class | t | `race-clock` step | `centre-banner` step | `grand-prix-panel` step | `race-clock` state | `centre-banner` state | `grand-prix-panel` state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `A-start` | race_start | 4429.67 | 0.106 | 0.093 | 0.045 | armed | armed | armed |
| `A-final-lap` | final_lap | 4547.0 | 0.114 | 0.125 | 0.068 | latched | latched | latched |
| `A-finish` | race_finish | 4596.0 | 0.133 | 0.183 | 0.122 | latched | latched | latched |
| `B-start` | race_start | 4764.05 | 0.219 | 0.158 | 0.081 | latched | latched | latched |
| `B-final-lap` | final_lap | 4873.0 | 0.205 | 0.237 | 0.094 | latched | latched | latched |
| `B-finish` | race_finish | 4974.0 | 0.078 | 0.231 | 0.170 | latched | latched | latched |
| `C-start` | race_start | 5126.0 | 0.148 | 0.125 | 0.081 | latched | latched | latched |
| `C-final-lap` | final_lap | 5222.0 | 0.042 | 0.167 | 0.134 | latched | latched | latched |
| `C-finish` | race_finish | 5251.0 | 0.076 | 0.123 | 0.087 | latched | latched | latched |
| `D-start` | race_start | 5341.81 | 0.249 | 0.235 | 0.095 | latched | latched | latched |
| `D-final-lap` | final_lap | 5440.0 | 0.141 | 0.259 | 0.225 | latched | latched | latched |
| `D-finish` | race_finish | 5490.0 | 0.231 | 0.294 | 0.176 | latched | latched | latched |
| `E-start` | race_start | 5544.85 | 0.068 | 0.083 | 0.094 | latched | latched | latched |
| `E-final-lap` | final_lap | 5649.0 | 0.152 | 0.175 | 0.208 | latched | latched | latched |
| `E-finish` | race_finish | 5698.0 | 0.087 | 0.183 | 0.076 | latched | latched | latched |

## Verdict

- chosen cell: none (park)
- verdict: **park**
