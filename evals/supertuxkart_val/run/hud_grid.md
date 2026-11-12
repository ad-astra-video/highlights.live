# HUD operating-point grid (ADAAAA-8744 WP3)

- clip sha256: `3da355cc6ffc5e0fa5bbffa25c3025b165cee7bbddd3e96b8f0746a11801b264` (checked before and after)
- manifest sha256: `d19a2240578ba6760d9634cd9932cd48ae49bd245b7085140711c6f1bca73d23` (pinned `d19a2240578ba6760d9634cd9932cd48ae49bd245b7085140711c6f1bca73d23`, checked before and after)
- measured window: 4380-5731 s (1351 s), 1351 frames at 1 fps
- label coverage inside it: 4429.67-5699 s
- match window: -3 s / +2 s (oracle default)

## Grid

| cell | sensitivity | dwell | candidates (in-window) | recall | A1 | FP rate | A2 | silent windows | A3 | candidates/min | A4 | clears |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `s0.08_d2` | 0.08 | 2 | 5 | 0.00 (0/15) | FAIL | 1.0000 | FAIL | 13/13 | pass | 0.31 | pass | no |
| `s0.08_d3` | 0.08 | 3 | 5 | 0.00 (0/15) | FAIL | 1.0000 | FAIL | 13/13 | pass | 0.31 | pass | no |
| `s0.08_d4` | 0.08 | 4 | 5 | 0.00 (0/15) | FAIL | 1.0000 | FAIL | 13/13 | pass | 0.31 | pass | no |
| `s0.12_d2` | 0.12 | 2 | 23 | 0.07 (1/15) | FAIL | 0.9565 | FAIL | 9/13 | FAIL | 1.11 | pass | no |
| `s0.12_d3` | 0.12 | 3 | 25 | 0.07 (1/15) | FAIL | 0.9600 | FAIL | 7/13 | FAIL | 1.20 | pass | no |
| `s0.12_d4` | 0.12 | 4 | 22 | 0.13 (2/15) | FAIL | 0.9091 | FAIL | 7/13 | FAIL | 1.07 | pass | no |
| `s0.18_d2` | 0.18 | 2 | 36 | 0.20 (3/15) | FAIL | 0.9167 | FAIL | 5/13 | FAIL | 1.73 | FAIL | no |
| `s0.18_d3` | 0.18 | 3 | 27 | 0.07 (1/15) | FAIL | 1.0000 | FAIL | 6/13 | FAIL | 1.33 | pass | no |
| `s0.18_d4` | 0.18 | 4 | 23 | 0.00 (0/15) | FAIL | 1.0000 | FAIL | 7/13 | FAIL | 1.16 | pass | no |
| `s0.25_d2` | 0.25 | 2 | 27 | 0.13 (2/15) | FAIL | 0.9259 | FAIL | 7/13 | FAIL | 1.33 | pass | no |
| `s0.25_d3` | 0.25 | 3 | 23 | 0.13 (2/15) | FAIL | 0.9130 | FAIL | 7/13 | FAIL | 1.11 | pass | no |
| `s0.25_d4` | 0.25 | 4 | 23 | 0.13 (2/15) | FAIL | 0.9130 | FAIL | 7/13 | FAIL | 1.11 | pass | no |

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

cell s0.12/d4 — 24 candidates in the window

| band | latched frames | window frames | first latch t |
| --- | --- | --- | --- |
| `race-clock` | 1125 | 1351 | 4461 |
| `centre-banner` | 1022 | 1351 | 4393 |
| `grand-prix-panel` | 933 | 1351 | 4393 |

| event | class | t | `race-clock` step | `centre-banner` step | `grand-prix-panel` step | `race-clock` state | `centre-banner` state | `grand-prix-panel` state |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `A-start` | race_start | 4429.67 | 0.097 | 0.080 | 0.053 | armed | latched | latched |
| `A-final-lap` | final_lap | 4547.0 | 0.070 | 0.081 | 0.080 | latched | latched | latched |
| `A-finish` | race_finish | 4596.0 | 0.084 | 0.141 | 0.118 | latched | latched | latched |
| `B-start` | race_start | 4764.05 | 0.006 | 0.051 | 0.012 | latched | latched | latched |
| `B-final-lap` | final_lap | 4873.0 | 0.190 | 0.134 | 0.067 | latched | latched | latched |
| `B-finish` | race_finish | 4974.0 | 0.122 | 0.195 | 0.151 | latched | latched | latched |
| `C-start` | race_start | 5126.0 | 0.030 | 0.063 | 0.018 | latched | latched | latched |
| `C-final-lap` | final_lap | 5222.0 | 0.081 | 0.111 | 0.092 | latched | latched | latched |
| `C-finish` | race_finish | 5251.0 | 0.091 | 0.112 | 0.070 | latched | latched | latched |
| `D-start` | race_start | 5341.81 | 0.110 | 0.090 | 0.059 | latched | latched | latched |
| `D-final-lap` | final_lap | 5440.0 | 0.088 | 0.194 | 0.085 | latched | latched | latched |
| `D-finish` | race_finish | 5490.0 | 0.251 | 0.272 | 0.172 | armed | latched | latched |
| `E-start` | race_start | 5544.85 | 0.063 | 0.046 | 0.079 | latched | latched | latched |
| `E-final-lap` | final_lap | 5649.0 | 0.114 | 0.082 | 0.083 | armed | latched | latched |
| `E-finish` | race_finish | 5698.0 | 0.187 | 0.160 | 0.109 | latched | latched | armed |

## Verdict

- chosen cell: none (park)
- verdict: **park**
