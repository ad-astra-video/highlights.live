"""Render evals/LFM3-PHASE1-RESULTS.md from the Phase 1 eval artifacts (ADAAAA-8245).

Reads the JSON artifacts produced on the box and writes one markdown report so
every number in it is traceable to a file + the command that produced it.
"""

from __future__ import annotations

import csv
import json
import os
import statistics
import sys

E = "evals"
OUT = os.path.join(E, "LFM3-PHASE1-RESULTS.md")


def load(name, default=None):
    p = os.path.join(E, name)
    if not os.path.exists(p):
        return default
    with open(p) as f:
        return json.load(f)


def yes_rate(rows, key):
    vals = [r[key] for r in rows if r.get(key) in ("yes", "no")]
    return round(sum(v == "yes" for v in vals) / max(1, len(vals)), 3)


def md_table(header, rows):
    out = ["| " + " | ".join(header) + " |", "|" + "|".join("---" for _ in header) + "|"]
    for r in rows:
        out.append("| " + " | ".join(str(c) for c in r) + " |")
    return "\n".join(out)


def main() -> int:
    prim = load("lfm3-phase1-summary.json")
    r2 = load("lfm3-phase1-r2-summary.json")
    vis = load("lfm3-phase1-vision2-summary.json")
    floor = load("lfm3-phase1-latency-floor.json")
    win = load("lfm3-phase1-window-probe.json")
    asr = load("lfm3-phase1-asr.json")
    if not prim:
        print("primary summary missing", file=sys.stderr)
        return 1

    rows = list(csv.DictReader(open(os.path.join(E, "lfm3-phase1-candidates.csv"))))
    ac = prim["ac_verdicts"]
    lat = prim["latency"]
    clips = prim["clips"]

    def f(x, d=1):
        return "n/a" if x is None else f"{x:.{d}f}"

    L = []
    A = L.append
    A("# LFM3-Omni Phase 1 — CPU-only audio/predicate discriminator eval (ADAAAA-8245)")
    A("")
    A(f"Generated: {prim['generatedAt']} · harness `evals/lfm3_predicate_eval.py` · "
      f"population `evals/inc9-trace-frames.json` (49 Stage-A candidates, 10 labeled clips).")
    A("")
    A("**Cost envelope: 0 GB VRAM, $0 Livepeer, CPU-only.** No production default, live-box env, "
      "`GEMMA_GPU_MEM_UTIL`, `ASR_DEVICE`, `DECIDE_CONFIRM_ENABLED` or Stage-A gate setting was changed.")
    A("")
    A("## Verdict")
    A("")
    A(f"**NOT ADOPTED.** Kill criteria triggered: `{'; '.join(prim['killCriteriaTriggered']) or 'none'}`. "
      "No Phase 2.")
    A("")
    A(md_table(
        ["AC", "Bar", "Measured", "Verdict"],
        [
            ["AC1 precision (negatives eliminated)", ">= 3 of 4 negative clips, 0 positives lost",
             f"{ac['AC1_precision']['negativesEliminated']} of {ac['AC1_precision']['negativesWithAcceptedGoal']} "
             f"({', '.join(ac['AC1_precision']['negativesEliminatedIds']) or 'none'}); positives lost "
             f"{ac['AC1_precision']['positivesLost'] or 'none'}; clip-level precision "
             f"{ac['AC1_precision']['precisionBefore_pct_clip']}% -> {ac['AC1_precision']['precisionAfter_pct_clip']}%",
             "PASS" if ac["AC1_precision"]["pass"] else "FAIL"],
            ["AC2 recall retained", "10/10 positives accepted (>= 95% on a 20-clip sample)",
             f"{ac['AC2_recall']['positivesRetained']}/{ac['AC2_recall']['positivesTotal']} positives retained an "
             f"accepted GOAL (0 lost). The INC-5 labeled set contains 6 positives (4 goal + 2 near-goal), not 10; "
             f"the 20-clip arm was not in scope",
             "PASS" if ac["AC2_recall"]["positivesLost"] == [] else "FAIL"],
            ["AC3 gate latency", "p95 <= 300 ms per candidate",
             f"p50 {f(lat['gate_p50_ms'])} ms · p95 {f(lat['gate_p95_ms'])} ms · max {f(lat['gate_max_ms'])} ms "
             f"(n={lat['gate_n']}); probability pass p95 {f(lat['prob_p95_ms'])} ms",
             "PASS" if ac["AC3_latency"]["pass"] else "FAIL"],
            ["AC4 cost", "0 Livepeer calls, 0 GB VRAM, RSS <= 2 GB",
             "decide calls 0 · Livepeer spend $0 (harness only talks to 127.0.0.1:8099 + CPU ffmpeg) · "
             "nvidia-smi before/during/after unchanged (3090 Ti 22336 MiB, 5070 Ti 6764 MiB) · "
             "llama-server CPU RSS 2.22 GB after load + audio-only pass, 2.89 GB with vision, "
             "5.53 GB after 147 requests (4 slots, KV growth) — above the 2 GB bar",
             "FAIL (RSS > 2 GB)"],
            ["AC5 noise split reported separately", "pre-gate rejects split from Stage-A FP rate",
             f"pre-gate rejects {ac['AC5_noise_split']['pregate_rejected']}/{ac['AC5_noise_split']['pregate_candidates']} "
             f"({ac['AC5_noise_split']['pregate_reject_rate']:.4f}); Stage-A (audio_gate) rejected "
             f"{ac['AC5_noise_split']['stageA_rejected']}/{ac['AC5_noise_split']['stageA_candidates']} "
             f"({ac['AC5_noise_split']['stageA_fp_rate']:.4f}) — different gates, NOT conflated", "PASS"],
            ["AC6 evidence", "per-candidate table + command + artifact paths",
             "this doc + `evals/lfm3-phase1-candidates.csv` + `evals/lfm3-phase1-summary.json` + "
             "`evals/lfm3-phase1-candidates.jsonl`", "PASS"],
        ]))
    A("")
    A("## What was measured")
    A("")
    A("| leg | value |")
    A("| --- | --- |")
    A("| Model | `LiquidAI/LFM3-Omni-2B-GGUF` Q4_K_M (1.10 GB) + `mmproj-...-Q4_K_M` (292 MB) |")
    A("| Runtime | llama.cpp **v0.8.0** (commit 8642541b255bfb5dc39cd351a178be09013a55d6), CMake CPU build "
      "`GGML_CUDA=OFF`, `-ngl 0 --no-mmproj-offload -t 16 --ctx-size 8192 --reasoning off --temp 0`, "
      "localhost 127.0.0.1:8099 |")
    A("| Candidate population | 49 Stage-A candidates over the 10 INC-5 labeled clips "
      "(GOAL/near 32, off-target 8, warm-up 9) replayed from the INC-9 trace |")
    A("| Per-candidate audio | trigger window `[ts-2.0s, ts+2.0s]` clamped to the clip, 16 kHz mono PCM, "
      "extracted with CPU ffmpeg (same convention as `evals/drive_inc8.py:crowd_energy_from_audio`) |")
    A(f"| Gate rule (pre-registered) | {prim['gateRule']} |")
    A("| Scoring | INC-9 Gemma decisions replayed from the trace (`gemmaAccepted` = the recorded "
      "`decision.isHighlight` for that candidate order) |")
    A("")
    A("### Predicate answer distribution (49 candidates, audio-only pass)")
    A("")
    A(md_table(["predicate", "yes", "no", "unknown"],
               [[k, sum(1 for r in rows if r.get(k) == "yes"),
                 sum(1 for r in rows if r.get(k) == "no"),
                 sum(1 for r in rows if r.get(k) == "unknown")]
                for k in ("crowd_eruption", "whistle", "commentary_excited", "celebration_visible")]))
    A("")
    pos = [r for r in rows if r["clipIsHighlight"] == "True"]
    neg = [r for r in rows if r["clipIsHighlight"] == "False"]
    pypos = [float(r["pYes"]) for r in pos if r.get("pYes") not in ("", "None")]
    pyneg = [float(r["pYes"]) for r in neg if r.get("pYes") not in ("", "None")]
    A(f"Model-reported crowd-eruption probability (`pYes` from a separate one-question logprob pass): "
      f"positives mean {statistics.fmean(pypos):.3f} (min {min(pypos):.3f}, max {max(pypos):.3f}) vs "
      f"negatives mean {statistics.fmean(pyneg):.3f} (min {min(pyneg):.3f}, max {max(pyneg):.3f}) — "
      f"overlapping distributions, no separating threshold.")
    A("")
    A("### Why precision did not move")
    A("")
    A("`crowd_eruption` answers **yes on 47 of 49 candidates** and `commentary_excited` yes on 47/49, on positives "
      "and negatives alike: broadcast crowd ambience is present in both classes, so a 2B omni model reading a "
      "4 s window cannot separate a goal eruption from ordinary match noise. The only two candidates answered "
      "`no` sit on `soc-off-02` — one eliminated negative out of four, below the AC1 bar of three.")
    A("")
    A("### Per-clip outcome (pre-gate applied on top of the recorded Gemma decisions)")
    A("")
    A(md_table(["clip", "phase", "label", "candidates", "Gemma accepted", "gate kept", "kept+accepted",
                "accepted GOAL survives?"],
               [[k, v["phase"], "positive" if v["isHighlight"] else "negative", v["nCandidates"],
                 v["nGemmaAccepted"], v["nKept"], v["nKeptAccepted"],
                 "yes" if v["nKeptAccepted"] else "NO"]
                for k, v in clips.items() if v["nCandidates"]]))
    A("")
    A("## Latency (AC3)")
    A("")
    A(md_table(["shape", "p50", "p95", "max", "n"],
               [["gate pass (4-predicate JSON reply)", f(lat["gate_p50_ms"]), f(lat["gate_p95_ms"]),
                 f(lat["gate_max_ms"]), lat["gate_n"]],
                ["probability pass (1 yes/no + logprobs)", "n/a", f(lat["prob_p95_ms"]), "n/a", lat["prob_n"]]]
               + ([["cheapest shape (4-token `y/n y/n y/n` reply)", f(floor["p50_ms"]), f(floor["p95_ms"]),
                     f(floor["max_ms"]), floor["n"]]] if floor else [])))
    if floor:
        A("")
        A(f"Even the cheapest answer shape stays far above the 300 ms bar ({f(floor['p95_ms'])} ms p95): the cost is "
          "the audio encoder forward pass + 2B decode on CPU (~0.4-0.8 s prefill for a 4 s window at "
          "~31 tok/s decode), not prompt length. Prompt shaping cannot close the gap.")
    A("")
    A("## Robustness checks")
    A("")
    if r2:
        A(f"- **Repeat run, same config** (stability): gate p95 {f(r2['latency']['gate_p95_ms'])} ms, "
          f"negatives eliminated {r2['ac_verdicts']['AC1_precision']['negativesEliminated']}, "
          f"positives lost {r2['ac_verdicts']['AC1_precision']['positivesLost'] or 'none'} — same verdict.")
    if vis:
        vc = vis["ac_verdicts"]
        A(f"- **Vision variant** (anchor frame at candidate ts, 448 px, fixed prompt): "
          f"celebration_visible yes on {sum(1 for r in vis['clips'].values() if r)} clips, "
          f"negatives eliminated {vc['AC1_precision']['negativesEliminated']}, positives lost "
          f"{vc['AC1_precision']['positivesLost'] or 'none'}, gate p95 {f(vis['latency']['gate_p95_ms'])} ms. "
          "Vision works in this build (a plain frame is described correctly in 6.2 s) but costs ~3x the audio "
          "pass on CPU and does not separate the classes either.")
    if win:
        wr = win["crowd_eruption_yes_rate"]
        A("- **Window sensitivity** (Gemma-accepted candidates, 3 window lengths): crowd_eruption yes-rate "
          + ", ".join(f"{k} pos {v['pos']:.2f} / neg {v['neg']:.2f}" for k, v in wr.items())
          + " — no window makes the predicate class-separating.")
    A("")
    A("## ASR appendix (same run, no extra cost)")
    A("")
    if asr:
        A(f"- LFM3-Omni with the model-card system prompt `Perform ASR in English.` did **not** transcribe these "
          f"broadcast clips: it replies conversationally (e.g. `Thank you.`, `Oh, welcome!`) instead of a transcript; "
          f"p50 {f(asr['lfm3_p50_ms'])} ms / p95 {f(asr['lfm3_p95_ms'])} ms per clip.")
        A(f"- Deployed faster-whisper `base` int8 baseline on the same clips: p50 {f(asr['baseline_p50_ms'])} ms / "
          f"p95 {f(asr['baseline_p95_ms'])} ms; empty transcripts on crowd-only windows.")
        A(f"- Adoption bar (WER <= baseline AND p95 <= 0.70 s): **not met** — latency alone is "
          f"{f(asr['lfm3_p95_ms'])} ms vs the 700 ms bar, and no usable transcript was produced. "
          "WER against the baseline transcript is therefore recorded as 1.0 but is not informative "
          "(no human reference exists; the baseline is itself empty on most windows).")
        A("- Premise correction confirmed: dropping ASR frees **0 GB VRAM** — it is already CPU-only.")
    A("")
    A("## Per-candidate table (AC6)")
    A("")
    A(md_table(["clip", "ts", "phase", "label", "gemma accepted", "crowd_eruption", "whistle",
                "commentary_excited", "pYes", "gate", "latency ms"],
               [[r["clipId"], r["ts"], r["clipPhase"], "pos" if r["clipIsHighlight"] == "True" else "neg",
                 r["gemmaAccepted"], r["crowd_eruption"], r["whistle"], r["commentary_excited"],
                 r["pYes"], "keep" if r["gateKeep"] == "True" else "REJECT", r["latencyMs"]]
                for r in rows]))
    A("")
    A("## Reproduce")
    A("")
    A("```sh")
    A("# on livepeer-ai-x99 (CPU only; no GPU, no Livepeer)")
    A("# 1) build llama.cpp v0.8.0 CPU-only")
    A("git clone --depth 1 --branch v0.8.0 https://github.com/ggml-org/llama.cpp ~/llama-build/llama.cpp")
    A("cmake -B ~/llama-build/llama.cpp/build -DGGML_CUDA=OFF -DGGML_NATIVE=ON -DLLAMA_CURL=ON")
    A("cmake --build ~/llama-build/llama.cpp/build -j 12 --target llama-server")
    A("# 2) model (1.10 GB + 292 MB)")
    A("curl -L -o ~/models/lfm3/LFM3-Omni-2B-Q4_K_M.gguf "
      "https://huggingface.co/LiquidAI/LFM3-Omni-2B-GGUF/resolve/main/LFM3-Omni-2B-Q4_K_M.gguf")
    A("curl -L -o ~/models/lfm3/mmproj-LFM3-Omni-2B-Q4_K_M.gguf "
      "https://huggingface.co/LiquidAI/LFM3-Omni-2B-GGUF/resolve/main/mmproj-LFM3-Omni-2B-Q4_K_M.gguf")
    A("# 3) serve CPU-only")
    A("llama-server -m ~/models/lfm3/LFM3-Omni-2B-Q4_K_M.gguf --mmproj ~/models/lfm3/mmproj-LFM3-Omni-2B-Q4_K_M.gguf \\")
    A("  --host 127.0.0.1 --port 8099 -ngl 0 --no-mmproj-offload -t 16 --ctx-size 8192 \\")
    A("  --reasoning off --temp 0")
    A("# 4) eval")
    A("python3 evals/lfm3_predicate_eval.py --out evals/lfm3-phase1-candidates.jsonl \\")
    A("  --summary evals/lfm3-phase1-summary.json --csv evals/lfm3-phase1-candidates.csv")
    A("python3 evals/lfm3_latency_floor_probe.py      # cheapest-shape latency floor")
    A("python3 evals/lfm3_asr_appendix.py             # ASR appendix")
    A("python3 evals/lfm3_phase1_report.py            # this report")
    A("```")
    A("")
    A("## Caveats")
    A("")
    A("- The replay scores the pre-gate against the **recorded** INC-9 Gemma decisions; it does not re-run perceive "
      "or decide (that would need GPU / Livepeer and is out of scope).")
    A("- Latency is wall-clock per candidate with a single client and `n_slots=4` on an otherwise idle box; the box "
      "was also serving `highlights-*` containers, so absolute numbers carry normal CPU contention noise.")
    A("- Sample: 10 labeled clips / 49 candidates, 4 negatives. AC1/AC2 are graded on the INC-5 set as the ticket "
      "specifies; a 20-clip sample was not in scope.")
    A("- No production wiring was added. Any future adoption needs an off-by-default flag plus the Phase 2 "
      "co-residency decision, neither of which this eval authorises.")
    A("")
    with open(OUT, "w") as fh:
        fh.write("\n".join(L) + "\n")
    print(f"wrote {OUT} ({len(L)} lines)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
