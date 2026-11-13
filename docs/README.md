# highlights.live docs

Operational contracts and the maps that make them checkable. Plans live in
[`plan/`](plan/) and are point-in-time; the contracts below are the current truth.

## Required reading before changing detection

[`highlight-pathways.md`](highlight-pathways.md) — the map of every pathway by
which a moment becomes an identified highlight, notable moment or big play:
capture, Stage-A triggers, window assembly, the decide call, both gate ladders,
clip placement, and the served row.

**Any change that adds, removes or re-orders a pathway must update that map in the
same commit.** That includes a trigger/signal source, window span/cadence/frame
budget, a gate or its order, clip placement/anchoring, the postable or served row
shape, a VOD-only detail pathway, a posture-flag default, or pricing.

```sh
pnpm check:pathways   # cited paths + machine-checked constants (§9 of the map)
pnpm test             # the same check runs as a vitest case
```

The check fails on a renamed/deleted cited path, a cited line past the end of its
file, or an invariant whose code value moved. Fix the map, not the check — the map
is a decision input, so a stale map silently changes what "identified" means.

## Contracts

| Doc | What it is authoritative for |
| --- | --- |
| [`highlight-pathways.md`](highlight-pathways.md) | every identification pathway, the gate order, the posture flags, the machine-checked invariants |
| [`audio-trigger-contract.md`](audio-trigger-contract.md) | what an audio trigger record is (the shared live/VOD detection contract) |
| [`tracked-object.md`](tracked-object.md) | what a "tracked object" is, identity/persistence rules, 3 live / 8 VOD caps |
| [`game-profile-contract.md`](game-profile-contract.md) | the per-type data contract (vocabulary, zones, oracle, triggers, audio thresholds, roster, eval set) |
| [`clip-counting.md`](clip-counting.md) | the one definition of "how many clips?" (raw rows vs postable moments) |
| [`live-observe-lag.md`](live-observe-lag.md) | the content-clock vs wall-clock lag bound on the live observer |
| [`live-window-audio.md`](live-window-audio.md) | per-window audio (ASR text + energy series) on the live rail |
| [`live-decide-enrichment.md`](live-decide-enrichment.md) | the perceive timeline + ASR coverage parts of the live decide payload |
| [`match-context-prompts.md`](match-context-prompts.md) | how team/kit context is resolved and rendered into prompts |
| [`summary-time-log.md`](summary-time-log.md) | the append-only summary log |
| [`fine-tune-data-path.md`](fine-tune-data-path.md) | Florence-2 fine-tune dataset contract |
| [`fine-tune-artifact-delivery.md`](fine-tune-artifact-delivery.md) | LoRA artifact delivery |
| [`per-stream-lora-injection.md`](per-stream-lora-injection.md) | per-stream LoRA injection into perceive |
| [`DEPLOY.md`](DEPLOY.md) | deployment shape |
| [`INTEGRATIONS.md`](INTEGRATIONS.md) | external integrations |
