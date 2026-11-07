# LFM3-Omni prompting for outcomes — vendor guidance and a CPU re-measure (ADAAAA-8245)

Follow-up to Phase 1 (`evals/LFM3-PHASE1-RESULTS.md`). Phase 1 concluded **NOT ADOPTED**
using an ad-hoc JSON answer prompt. This note answers "how does Liquid suggest prompting for
outcomes", then re-measures the same 49 INC-9 candidates under the vendor-recommended prompt
shape and under Liquid's own decision-model path, so the Phase 1 verdict is attributable to the
signal rather than to the prompt.

CPU only. 0 GPU, 0 Livepeer calls, no production writes. Measured on `livepeer-ai-x99` with
llama.cpp v0.8.0 (`8642541`).

## 1. What Liquid documents

### LFM3-Omni-2B chat (audio understanding)

From <https://docs.liquid.ai/lfm/key-concepts/omni-capabilities#audio-understanding> and the
model card (<https://huggingface.co/LiquidAI/LFM3-Omni-2B>):

- Open-ended audio questions need no system prompt. To ground answers, use the system prompt
  `Answer questions about the provided audio clip. Base every answer only on what can be heard.`
- For multiple choice: **include the choices in the text part and end it with the exact sentence
  `Please choose the answer from the options.`**
- Audio is resampled to 16 kHz mono on load. Text output is greedy. The model is non-reasoning;
  llama.cpp needs `--reasoning off`, and every assistant turn opens with an empty `<think></think>`.
- In `llama cli`, the system prompt goes in `-sys`, and the user turn is `-p "<__media__>"` with
  `--audio clip.wav`. A plain prompt (no system turn) makes the model describe audio rather than
  answer it.

### Bounded outcomes with probabilities: use the decision model, not chat

From <https://docs.liquid.ai/lfm/models/decision-models>, <https://docs.liquid.ai/lfm/models/d1-omni-2b>
and <https://docs.liquid.ai/guides/decision-model-guide>:

- Liquid's answer for classification, routing and yes/no gates is a **decision model**, not
  prompting a chat model and parsing text.
- **d1-Omni-2B is a 2.17B decision model built on LFM3-Omni-2B** that takes audio, questions of
  type `noul` (yes/no → probability), `choice` and `score`, and answers in one forward pass with
  **zero output tokens** and calibrated probabilities. It is not a chat model.
- llama.cpp 0.8.0 (b11960)+ serves it at `POST /v1/systemone`, and supports Noul/Choice/Score over
  text, pictures and audio (typed answers need Transformers). The question is read in one batch, so
  `-b`/`-ub` must hold the state and media (`-b 8192 -ub 8192` for this model).

So the vendor's prescribed way to ask "did a goal outcome happen?" is a `noul` question on
d1-Omni-2B, not a chat prompt. Phase 1 asked LFM3-Omni chat an ad-hoc JSON question and read
logprobs off a second yes/no pass; that is not the documented pattern for either path.

## 2. What was re-measured

`evals/lfm3_prompt_fidelity.py` replays the same 49 INC-9 Stage-A candidates, the same 4 s
16 kHz mono trigger window `[ts-2 s, ts+2 s]`, and the same recorded INC-9 Gemma decisions.

- `--arm chat`: LFM3-Omni-2B Q4_K_M, vendor prompt shape — system prompt above, then one
  multiple-choice turn per predicate (`A. yes / B. no`), ending with
  `Please choose the answer from the options.` Three requests per candidate.
- `--arm d1`: d1-Omni-2B Q8_0, three `noul` questions (crowd eruption, whistle, excited
  commentary) in one `/v1/systemone` call per candidate.

Gate rule is unchanged from Phase 1 (pre-registered, not tuned): keep iff
`crowd_eruption==yes OR whistle==yes` (audio-only arm; `celebration_visible` needs a frame).

## 3. Results

| Arm | AC1 negatives eliminated | AC2 positive clips retained | latency p50 | latency p95 | AC3 (<=300 ms) |
|---|---|---|---|---|---|
| Phase 1 JSON prompt (recorded) | 1/4 | 6/6 | 2272 ms | 2313 ms | FAIL |
| chat, vendor multiple-choice, 3 calls | **2/4** | 6/6 | 2236 ms | **5391 ms** | FAIL |
| chat, single consolidated call | n/a (collapsed to one answer) | n/a | — | 1299 ms | FAIL |
| d1-Omni-2B noul, t=0.5 | **2/4** | 6/6 | 2178 ms | **2958 ms** | FAIL |
| d1-Omni-2B noul, t=0.6 | **3/4** | 5/6 (1 positive lost) | 2178 ms | 2958 ms | FAIL |

Per-predicate rates, chat arm (Gemma-accepted candidates, 22 positive / 9 negative):
`crowd_eruption` yes 10/22 pos vs 3/9 neg; `whistle` 7/22 vs 0/9; `commentary_excited` 10/22 vs 5/9.

d1 probabilities (same population): crowd 0.559 mean pos vs 0.454 neg (ranges 0.138-0.854 vs
0.185-0.782); whistle 0.364 vs 0.202 (0.101-0.667 vs 0.098-0.522); commentary 0.431 vs 0.273
(0.204-0.857 vs 0.160-0.441). Ranges overlap for every predicate.

Resource position: llama-server RSS **2.24 GB** for d1 (2.22 GB for the chat arm) vs the AC4
2 GB bar; `nvidia-smi` unchanged before/during/after (3090 Ti 22336 MiB, 5070 Ti 6764 MiB);
0 Livepeer decide calls.

## 4. Reading

Prompting does move the number, and in the documented direction: the vendor multiple-choice
shape and the vendor decision model both get 2/4 negatives at zero positive-clip loss, versus
1/4 for the ad-hoc JSON prompt. But:

- AC1 needs >= 3 of 4 at zero positive loss. Only the d1 threshold sweep reaches 3/4 (t=0.6), and
  it loses a positive clip at the same time.
- AC3 is not reachable by prompt shape. The chat arm is ~2.2 s p50 for three turns; even a single
  consolidated turn is ~1.3 s p95. d1's single forward pass is 2.2 s p50 / 3.0 s p95 on 16 CPU
  threads. Every configuration is an order of magnitude over the 300 ms bar.
- The predicate distributions still overlap. `crowd_eruption` is yes on 10/22 positives and 3/9
  negatives; d1's crowd probability means differ by 0.10 with overlapping ranges.

**Phase 1 disposition is unchanged: NOT ADOPTED, no Phase 2.** The corrected prompting makes the
evidence stronger, not weaker: the vendor's own recommended outcome path on this CPU box misses
both the discrimination bar and the latency bar.

## 5. Reproduction

```sh
# chat arm (vendor prompt shape)
python3 evals/lfm3_prompt_fidelity.py --arm chat --server http://127.0.0.1:8099 \
  --candidates candidates49.json --out pf_chat2.jsonl --summary pf_chat2_summary.json

# d1 arm (noul probabilities, one pass)
python3 evals/lfm3_prompt_fidelity.py --arm d1 --server http://127.0.0.1:8100 \
  --candidates candidates49.json --out pf_d1b.jsonl --summary pf_d1b_summary.json
```

Server commands (CPU only):

```sh
llama-server -m LFM3-Omni-2B-Q4_K_M.gguf -mm mmproj-LFM3-Omni-2B-Q4_K_M.gguf \
  --host 127.0.0.1 --port 8099 -ngl 0 --no-mmproj-offload -t 16 --ctx-size 8192 \
  --reasoning off --temp 0
llama-server -m d1-Omni-2B-Q8_0.gguf -mm mmproj-d1-Omni-2B-Q8_0.gguf \
  --host 127.0.0.1 --port 8100 -ngl 0 --no-mmproj-offload -t 16 -b 8192 -ub 8192 \
  --ctx-size 8192
```

`candidates49.json` is the 49-row list from `evals/inc9-trace-frames.json` +
`evals/label-manifest.json` (same loader as `evals/lfm3_predicate_eval.py`).

## 6. Pitfall found in the llama.cpp systemone path

The Liquid docs' llama.cpp example passes the clip as a top-level `"audio": "data:audio/wav;base64,..."`.
In this build (`v0.8.0`, `8642541`) that key is **ignored**: the request succeeds, `usage.input_tokens`
is 105, and every clip returns byte-identical probabilities (crowd 0.2459, whistle 0.4259,
commentary 0.5455) — i.e. the model answered from the questions alone. Media must go in
`files` (alias `images`) as a data URI, or in a chat-form `state` as an `input_audio` part.
With `files`, the same goal clip returns commentary 0.847-0.875 and a warm-up clip 0.161-0.171,
confirming the audio is actually read. Any future d1 evaluation must assert that probabilities
vary across clips before scoring them.
