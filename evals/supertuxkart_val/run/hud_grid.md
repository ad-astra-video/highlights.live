# HUD operating-point grid (ADAAAA-8744 WP3)

- clip sha256: `3da355cc6ffc5e0fa5bbffa25c3025b165cee7bbddd3e96b8f0746a11801b264` (checked before and after)
- manifest sha256: `d19a2240578ba6760d9634cd9932cd48ae49bd245b7085140711c6f1bca73d23` (pinned `d19a2240578ba6760d9634cd9932cd48ae49bd245b7085140711c6f1bca73d23`, checked before and after)
- measured window: 4380-5731 s (1351 s), 1351 frames at 1 fps
- label coverage inside it: 4429.67-5699 s
- match window: -3 s / +2 s (oracle default)

## Grid

| cell | sensitivity | dwell | candidates (in-window) | recall | A1 | FP rate | A2 | silent windows | A3 | candidates/min | A4 | clears |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `s0.08_d2` | 0.08 | 2 | 82 | 0.33 (5/15) | FAIL | 0.9146 | FAIL | 1/13 | FAIL | 3.77 | FAIL | no |
| `s0.08_d3` | 0.08 | 3 | 83 | 0.40 (6/15) | FAIL | 0.9398 | FAIL | 0/13 | FAIL | 3.86 | FAIL | no |
| `s0.08_d4` | 0.08 | 4 | 71 | 0.33 (5/15) | FAIL | 0.9296 | FAIL | 0/13 | FAIL | 3.29 | FAIL | no |
| `s0.12_d2` | 0.12 | 2 | 96 | 0.47 (7/15) | FAIL | 0.9062 | FAIL | 1/13 | FAIL | 4.44 | FAIL | no |
| `s0.12_d3` | 0.12 | 3 | 68 | 0.40 (6/15) | FAIL | 0.8971 | FAIL | 3/13 | FAIL | 3.24 | FAIL | no |
| `s0.12_d4` | 0.12 | 4 | 63 | 0.13 (2/15) | FAIL | 0.9524 | FAIL | 2/13 | FAIL | 3.02 | FAIL | no |
| `s0.18_d2` | 0.18 | 2 | 52 | 0.00 (0/15) | FAIL | 1.0000 | FAIL | 7/13 | FAIL | 2.49 | FAIL | no |
| `s0.18_d3` | 0.18 | 3 | 39 | 0.13 (2/15) | FAIL | 0.9487 | FAIL | 8/13 | FAIL | 1.82 | FAIL | no |
| `s0.18_d4` | 0.18 | 4 | 29 | 0.00 (0/15) | FAIL | 1.0000 | FAIL | 9/13 | FAIL | 1.38 | pass | no |
| `s0.25_d2` | 0.25 | 2 | 25 | 0.13 (2/15) | FAIL | 0.9200 | FAIL | 11/13 | pass | 1.20 | pass | no |
| `s0.25_d3` | 0.25 | 3 | 19 | 0.07 (1/15) | FAIL | 0.9474 | FAIL | 11/13 | pass | 0.93 | pass | no |
| `s0.25_d4` | 0.25 | 4 | 19 | 0.07 (1/15) | FAIL | 0.9474 | FAIL | 11/13 | pass | 0.93 | pass | no |

## Band change-score calibration

| band | window | max score | p50 | p95 | frames |
| --- | --- | --- | --- | --- | --- |
| `race-clock` | whole window (frame-to-frame) | 0.5120 | 0.0612 | 0.2312 | 1350 |
| `race-clock` | within +/-1 s of a labelled instant | 0.4059 | 0.1087 | 0.2545 | 41 |
| `centre-banner` | whole window (frame-to-frame) | 0.6279 | 0.0998 | 0.2371 | 1350 |
| `centre-banner` | within +/-1 s of a labelled instant | 0.2551 | 0.1077 | 0.1969 | 41 |
| `grand-prix-panel` | whole window (frame-to-frame) | 0.5358 | 0.0726 | 0.1675 | 1350 |
| `grand-prix-panel` | within +/-1 s of a labelled instant | 0.2209 | 0.0821 | 0.1744 | 41 |

## Latch trace

cell s0.12/d2 — 100 candidates in the window

| band | latched frames | window frames | first latch t |
| --- | --- | --- | --- |
| `race-clock` | 586 | 1351 | 4432 |
| `centre-banner` | 792 | 1351 | 4391 |
| `grand-prix-panel` | 596 | 1351 | 4391 |

| event | class | t | `race-clock` step | `centre-banner` step | `grand-prix-panel` step | `race-clock` state | `centre-banner` state | `grand-prix-panel` state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `A-start` | race_start | 4429.67 | 0.101 | 0.229 | 0.052 | armed | latched | armed |
| `A-final-lap` | final_lap | 4547.0 | 0.072 | 0.069 | 0.055 | armed | armed | armed |
| `A-finish` | race_finish | 4596.0 | 0.102 | 0.126 | 0.105 | armed | armed | armed |
| `B-start` | race_start | 4764.05 | 0.186 | 0.511 | 0.406 | latched | latched | latched |
| `B-final-lap` | final_lap | 4873.0 | 0.142 | 0.250 | 0.068 | armed | latched | armed |
| `B-finish` | race_finish | 4974.0 | 0.115 | 0.153 | 0.130 | armed | latched | armed |
| `C-start` | race_start | 5126.0 | 0.185 | 0.520 | 0.380 | latched | latched | latched |
| `C-final-lap` | final_lap | 5222.0 | 0.050 | 0.092 | 0.076 | armed | armed | armed |
| `C-finish` | race_finish | 5251.0 | 0.130 | 0.125 | 0.074 | latched | latched | armed |
| `D-start` | race_start | 5341.81 | 0.244 | 0.353 | 0.300 | latched | latched | latched |
| `D-final-lap` | final_lap | 5440.0 | 0.126 | 0.306 | 0.154 | latched | latched | latched |
| `D-finish` | race_finish | 5490.0 | 0.251 | 0.174 | 0.200 | latched | latched | latched |
| `E-start` | race_start | 5544.85 | 0.242 | 0.044 | 0.150 | latched | armed | latched |
| `E-final-lap` | final_lap | 5649.0 | 0.136 | 0.060 | 0.197 | latched | armed | latched |
| `E-finish` | race_finish | 5698.0 | 0.355 | 0.104 | 0.100 | latched | latched | armed |

## Verdict

- chosen cell: none (park)
- verdict: **park**
