# d1-Omni-2B: temperature sweep and vendor/community prompt shapes

Follow-up measurement on [ADAAAA-8245](/ADAAAA/issues/ADAAAA-8245). CEO ask: *"explore the d1 model more with
different temps and research online for how others are prompting it."*

Population is unchanged from Phase 1: the 49 INC-9 Stage-A candidates on the 10 INC-5 labeled clips, replayed
from `evals/inc9-candidates-49.json` and scored against the **recorded** INC-9 Gemma decisions (no
perceive/decide re-run → 0 GPU, $0 Livepeer). Per-candidate trigger window `[ts-2.0s, ts+2.0s]`, 16 kHz mono.
CPU-only on `livepeer-ai-x99`, llama.cpp v0.8.0 (`8642541` / b11960), `d1-Omni-2B-Q8_0` + Q8_0 mmproj,
`-ngl 0 --no-mmproj-offload -t 16 --ctx-size 8192 -b 8192 -ub 8192`.

## 1. Temperature: there is nothing to sweep, and it would not help

d1 is a decision model: it writes no tokens. llama.cpp reads the answer at the label logits and applies a
**calibration temperature** that comes from GGUF metadata, not from the request:

- Metadata in this GGUF: `lfm3.decision.temperature.noul = 3.3829832`, `.choice = 3.3829832`,
  `.score = 3.3829832` (also visible in the Ollama manifest as `"default": 3.3829832`, `"temperatures": {}`).
- `tools/server/server-decision.cpp` (`format_answer`): `temperature = has_media && type == LFM2_D1_OMNI ? 1.0f : get_temperature(question)`.
  **Any request carrying audio or an image is pinned to T = 1.0** unless the GGUF also carries
  `lfm3.decision.temperature.image`; this GGUF does not.
- Liquid's model card says the same thing from the other side: *"It reads its answers from a single forward
  pass, so there are no sampling parameters to set."*

Measured, not assumed (artifacts `d1-sweep/probe_temp.log`, `d1-sweep/probe_req_temp.log`):

| Probe | Result |
|---|---|
| `--override-kv lfm3.decision.temperature.image=float:0.5` vs `3.38` vs none | byte-identical probabilities (`crowd` 0.1450023873174336, `whistle` 0.22706543742095797) — overriding an absent key is a no-op in this build |
| request fields `temperature: 0.2`, `temperature: 2.0`, `temp: 0.2, top_k: 1`, `seed: 1234` | byte-identical to baseline |
| same request twice | byte-identical → deterministic, no sampling |

Because the read is a softmax over fixed logits, a temperature that *did* exist would only rescale confidence
(sharpness), not reorder candidates: `p ≥ t` at temperature `T` is a monotone threshold on the same logit gap.
I swept that anyway, as a sensitivity analysis: the recorded T = 1.0 probabilities were rescaled to
`T ∈ {0.25, 0.5, 0.75, 1, 1.5, 2, 4}` (implied-logit transform) and re-thresholded across 49 gate thresholds per
arm. **Feasible operating points (≥ 3/4 negative clips rejected with 0 positive clips lost) = 0 at every
temperature in every arm.** Temperature cannot buy AC1 on this population, whether or not it is reachable.

## 2. What the vendor and the community say about prompting it

Sources, retrieved 2026-11-07:

- **Primitives** (<https://docs.liquid.ai/lfm/models/decision-models>): `noul` = yes/no with a probability;
  `choice` = pick one from named options with `criteria` descriptions; `score` = position on an ordered rubric.
  *"Calibrate any decision threshold on data from your own use."*
- **Noul vs Score** (<https://docs.liquid.ai/.well-known/skills/decision-model/skill.md>): *"A Noul value near
  0.5 means uncertainty between yes and no; it does not measure degree or intensity. Use Score for degree,
  severity..."* — i.e. ask a *presence* question as noul and an *intensity* question as score, not vice versa.
- **Migration guide** (<https://docs.liquid.ai/guides/decision-model-guide>): confidence bands are the idiomatic
  way to act on a probability (`p > 0.8` block, `p < 0.2` allow, otherwise fall back / human review); choice
  returns `confidence` so a router can defer when it is unsure.
- **llama.cpp / GGUF card** (<https://docs.liquid.ai/lfm/models/d1-omni-2b>, <https://huggingface.co/LiquidAI/d1-Omni-2B-GGUF>):
  needs b11960+, answers `noul`/`choice`/`score` only, media via `files`/`images` data URIs, `-b/-ub` must hold
  state + media (8192).
- **Ollama's documented example** (<https://ollama.com/library/d1-omni:2b>) is the one shape nobody in Phase 1
  had tried: a `noul` with **`criteria` describing `true` and `false`** ("what counts as a yes, what counts as a
  no"). llama.cpp supports it for this model (`server-decision.cpp` accepts `false`/`true`, and `yes`/`no`
  aliases for lfm2-d1-omni).
- **Community**: the only substantive write-up found is <https://blog.authon.dev/run-liquidai-d1-omni-2b-locally>
  (decision model, not chat; 600M vs 2B comparison, Liquids' own benchmarks). No published prompt guidance for
  sports/sound-event goals exists; the docs' example-driven style is the whole public corpus.

## 3. Measured arms (49 candidates, CPU, same windows)

Gate rule per arm is pre-registered as "reject when the gate score is below the threshold"; threshold is chosen
**in-sample** to maximise AC1 subject to 0 positive clips lost (generous to the model).

| Arm (shape) | p50 | p95 | max | AUC (candidate) | best-safe threshold | AC1 | AC2 | precision projection | feasible points |
|---|---|---|---|---|---|---|---|---|---|
| `noul_base` — Phase 1's three noul questions | 1851.9 | 1927.9 | 2277.6 | 0.5657 | 0.30 | 2/4 | 6/6 | 0.800 | 0 |
| `noul_criteria` — Ollama shape: noul + true/false criteria (goal, whistle) | 1154.3 | 1190.2 | 1196.4 | 0.6515 | 0.22 | 2/4 | 6/6 | 0.800 | 0 |
| `noul_event` — event-framed ("did a goal just happen?") | 1194.3 | 1237.7 | 1245.6 | 0.4899 | 0.36 | 2/4 | 6/6 | 0.792 | 0 |
| `choice_goal` — 3-way choice (goal / routine / off-target) | 934.8 | 965.1 | 969.8 | 0.6515 | 0.04 | 2/4 | 6/6 | 0.808 | 0 |
| `choice_goal2` — 2-way choice (goal / no goal) | **751.5** | **776.7** | 789.3 | **0.6717** | 0.06 | 2/4 | 6/6 | 0.808 | 0 |
| `score_crowd` — 3-level crowd-intensity rubric | 858.3 | 889.3 | 918.7 | 0.4495 | — (inverted) | — | — | — | 0 |

The two negatives every arm can eliminate are `soc-off-02` and `soc-warm-02`; `soc-off-01` and `soc-warm-01`
survive every shape and every threshold. Accepted set = 31 candidates (22 positive across 6 positive clips,
9 negative across 4 negative clips).

Class means among Gemma-accepted candidates (noul_base): `crowd_eruption` 0.547 pos vs 0.534 neg (overlapping
ranges), `whistle` 0.358 vs 0.180 (the only durable class difference), `commentary_excited` 0.438 vs 0.266.

### What the shapes buy

- **The documented primitives help, in the direction Liquid's docs predict.** `choice` is Liquid's recommended
  primitive for pick-one-from-many and it has the best AUC (0.672) *and* the lowest latency of any useful arm
  (777 ms p95), because one question replaces three.
- `noul` + explicit `true`/`false` criteria (Ollama's example) is a clear improvement over the bare yes/no
  phrasing: AUC 0.566 → 0.652 at 1.19 s p95, and it is the highest-AUC noul arm.
- **Event framing does not work.** "Did a team score a goal?" scores 0.49 — chance. The 4 s window carries
  the crowd reaction, not the event semantics.
- **Score is the wrong primitive here, and the docs say why.** The rubric measures *intensity*, and the
  negatives (crowd-only warm-up / off-target clips) are actually louder on it: score mean 0.938 on positives vs
  1.118 on negatives, AUC 0.450. Degree ≠ presence.
- Precision projection is met at the best-safe operating point (0.808 ≥ 0.75 bar) even though AC1's literal
  rule (**≥ 3 of 4 negative clips eliminated**) is not: on this 10-clip population 2/4 elimination already
  reaches 80.8% candidate-level precision (71% ungated). That is a defect in the ticket's AC1 text, not a
  reason to adopt — AC3 and AC4 still fail hard.

## 4. AC table after this round (unchanged disposition)

| AC | Bar | Measured | Verdict |
|---|---|---|---|
| AC1 precision | reject ≥ 3 of 4 negatives' accepted GOALs, lose 0 positives | **2/4** in every shape, at every threshold, at every simulated temperature; 0 positive clips lost; precision projection 0.808 (candidate-level) | **FAIL** |
| AC2 recall | 10/10 positives retained | **6/6** positive clips retained, 1 of 22 positive candidates rejected at the best-safe point | **PASS** |
| AC3 latency | added gate p95 ≤ 300 ms | best **776.7 ms** (`choice_goal2`), 1190 ms for the criteria-noul, 1928 ms for the Phase 1 shape | **FAIL** |
| AC4 cost | 0 Livepeer calls, 0 GB VRAM, RSS ≤ 2 GB | 0 decide calls, `nvidia-smi` identical before/during/after (22336 / 6764 MiB); llama-server RSS **2174 MB** both passes | **FAIL** (RSS) |
| AC5 noise split | pre-gate rejects reported separately | unaffected; this gate never touches `audio_gate` | **PASS** |
| AC6 evidence | per-candidate table + command + artifact | `d1-sweep/d1_<arm>.{csv,jsonl}`, per-arm `_summary.json`, `summary_table.json`, probe logs, raw run logs | **PASS** |

**Disposition: NOT ADOPTED, no Phase 2.** Temperature is not a knob in this build. The best documented prompt
shape is a real improvement on paper (AUC 0.57 → 0.67, p95 1928 → 777 ms) but still misses AC1 (2/4 vs 3/4),
AC3 (777 ms vs 300 ms) and AC4 (2.17 GB vs 2 GB). The discrimination limit is in the signal, not the phrasing:
broadcast crowd ambience is present in goals and non-goals alike, and only the whistle predicate separates.

Remaining cheap option, **not run here**: `d1-omni-600M` (587M, 16K ctx, one ≤ 30 s clip) is the only d1 variant
that could plausibly approach the 300 ms bar on CPU; it would need its own AC run before anything else is said
about it.

## 5. Repro

```sh
# on livepeer-ai-x99 (CPU only; 0 GPU, 0 Livepeer)
scp evals/inc9-candidates-49.json /tmp/inc9-candidates-49.json
setsid nohup llama-server -m /home/brad/models/d1-omni/d1-Omni-2B-Q8_0.gguf \
  --mmproj /home/brad/models/d1-omni/mmproj-d1-Omni-2B-Q8_0.gguf \
  --host 127.0.0.1 --port 8110 -ngl 0 --no-mmproj-offload -t 16 \
  --ctx-size 8192 -b 8192 -ub 8192 > /tmp/d1_srv.log 2>&1 &
python3 -u evals/lfm3_d1_temp_prompt_sweep.py --server http://127.0.0.1:8110 \
  --candidates /tmp/inc9-candidates-49.json --out-dir /tmp/d1sweep
```

Temperature probes: `--override-kv lfm3.decision.temperature.image=float:0.5` at server start, then one
`/v1/systemone` request (see `d1-sweep/probe_temp.log`); request-field probe varies `temperature`/`temp`/`seed`
in the body (see `d1-sweep/probe_req_temp.log`).
