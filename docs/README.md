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

## Public-document hygiene

This repository is public, so nothing under `docs/` — or anywhere else in the
tracked tree — may name a real host, a real address, an operator home path, an
SSH target, or a credential value. Write the placeholder instead and keep the
real value in the box `.env`, the ops vault, or the secrets store.

| Real thing | Placeholder |
| --- | --- |
| production API/web host | `<PUBLIC_HOST>` |
| deploy GPU box hostname | `<GPU_BOX_HOST>` |
| deploy GPU box LAN address | `<GPU_BOX_LAN_IP>` |
| decide host hostname | `<DECIDE_HOST>` |
| decide host LAN address | `<DECIDE_HOST_LAN_IP>` |
| operator account home path | `<OPERATOR_HOME>` |
| ssh user / ssh alias / ssh port | `<SSH_USER>` / `<SSH_HOST_ALIAS>` / `<SSH_PORT>` |
| bearer token, API key, password | `<TOKEN>` / `<PASSWORD>`, or the words "secrets-managed, never committed" |

**Denied classes (the contract the guard enforces, ruling §4):** private LAN
addresses; internal hostnames **bare or in a URL** (a machine name has no scheme
and no `@`, and is denied in every form); the operator home path and username;
the SSH alias and the `user@host` form; and the SSH port *in a context that
makes it a port* (`-p`, `--port=`, an ssh_config `Port`, `ssh://…:N`,
`user@host:N`). A bare number is not a port: recorded eval results carry timing
numbers that must stay replayable. A bare hostname is caught by its deploy-fleet
family — the guard cannot know an arbitrary machine name, so add a new family to
`INTERNAL_HOSTNAME_FAMILIES` in `scripts/check-docs-hygiene.mjs` when the fleet
gains one.

Allowed as-is: loopback (`127.0.0.1`, `0.0.0.0`), the RFC1918 CIDR ranges quoted
as documentation defaults (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`),
compose-network service names (`http://decide:8081`), `example.com` sample
payloads, the two public edge origins (they are in public DNS and Certificate
Transparency — see ruling R3), and container/runner ids (they are API
identifiers, not addresses — `highlights-decide-<id>` names a runner, not a
host).

Check a tree change before committing:

```sh
node scripts/check-docs-hygiene.mjs   # exits 1 on a denied endpoint in any tracked file
```

Acceptable hits, and nothing else: the public GitHub repo URL, the RFC1918 CIDR
defaults, `example.com` / `x.dev` sample payloads, the published product contact
addresses in `legal/` and `INTEGRATIONS.md`, `admin@highlights.local` (the seeded
dev admin), and a placeholder such as `your-app.railway.app`. Any other host,
address or `user@host` is a real endpoint and must become a placeholder.
`ADAAAA-9100` is the sweep that removed the 2026-11 values; the earlier values
stay in git history until a rewrite is approved.
