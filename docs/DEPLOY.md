# Deploy / reproducible path

Config item 15 from the [ADAAAA-16](/ADAAAA/issues/ADAAAA-16) plan: a
reproducible way to get new builds from repo -> the box (so the tunnel serves
current code). This doc is the source of truth for that path.

## Source of truth

- Repo: `https://github.com/ad-astra-video/highlights.live`
- Branch: `master` (this is what the live box serves)
- Deploy key: `~/.ssh/highlights_live_deploy_ed25519` (SSH host alias
  `github-highlights-live`); grants push to origin/master on this repo.

The beta-gate + waitlist + per-user quota code (entitlement ledger) lives in
`services/server/src/entitlements.ts` and is enforced by `auth.ts` /
`api.ts`. It is on `origin/master`; a fresh clone of master contains it.

## Build contract (reproduce from source)

The repo is a pnpm/npm workspace. The live web app + API are built from
`services/server` (API) and `webapp` (React SPA, output `webapp/dist`).

Local verification that a given HEAD is shippable:

```sh
npm ci
npx vitest run services/server/test/entitlements.test.ts \
  services/server/test/auth.test.ts services/server/test/api.test.ts \
  services/server/test/billing.test.ts services/server/test/waitlist.test.ts \
  services/server/test/wireframe.test.ts   # gate + quota suite
npm run build -w @highlights/webapp        # SPA tsc + vite build
```

## Deploy to the box (livepeer-ai-x99 / highlights-server.dpn.gg)

The live service runs on the `.6` box (livepeer-ai-x99) from the repo source,
served behind the Cloudflare tunnel (`cloudflared`) at
`https://highlights-server.dpn.gg`. The canonical stack is defined in
`docker/docker-compose.yml` (server :3000, media, perceive, decide, gemma,
orchestrator, postgres, email) and is started with:

```sh
git pull origin master          # or fresh: git clone
docker compose -f docker/docker-compose.yml up -d --build
```

Box deploy mechanics (which sync method drops source onto the box, image
rebuild, tunnel routing) are owned by the **Infra Monitor**. Developer owns
getting the code onto `origin/master`; Infra Monitor handles the box leg so
the tunnel serves current master.

## Temporary operator quota lift (ADAAAA-3577)

The per-user monthly clip quota (`BETA_CLIP_QUOTA`, default 10) can be raised
OPERATOR-ONLY, reversibly, and time-boxed for the gate-X K=100 push. It does
NOT change published pricing (PLANS free=10/pro=100, landing copy) or the
canonical 10/mo shown to users (`clipQuotaLimitCanonical` stays the canonical
number).

- `BETA_QUOTA_LIFT=<n>` — set to a positive number to lift enforcement (the
  entitlement hard-stop AND the free-tier generation fee gate) to `n` so the
  N=2 real users can drive toward K=100. Unset to revert.
- `BETA_QUOTA_LIFT_UNTIL=<ISO>` — optional expiry; past this instant the lift
  auto-reverts to `BETA_CLIP_QUOTA`.

Read back the live state via admin analytics `/admin/analytics`: `gateX`
(clips generated vs K=100, `quotaLiftActive`, `effectivePerUserQuota`,
`canonicalPerUserQuota`) and `reliability` (pipeline job done/total %).

## Post-deploy live re-check (acceptance for this task)

After a deploy, confirm the served behavior matches source:

```sh
curl -s https://highlights-server.dpn.gg/health
# {"status":"ok","billing":"disabled"}

# hard beta-gate: non-invited register must be rejected 403 invite_required
curl -s -X POST https://highlights-server.dpn.gg/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"probe@example.com","password":"ChangeMe123!"}'
# 403  {"error":"invite required to create an account","code":"invite_required"}

# public waitlist capture
curl -s -X POST https://highlights-server.dpn.gg/waitlist \
  -H 'Content-Type: application/json' -d '{"email":"probe@example.com"}'
# 200  {"ok":true,"registered":true,...}
```

## Verified deploy (ADAAAA-2505)

- Pushed commit on origin/master: `e7db4cd` (`b3a0afe..e7db4cd master -> master`),
  the merge of local master (with gate+quota commit `0334366`) and the box's
  prior origin/master (compose/gpu work).
- `git ls-remote origin master` -> `e7db4cddb8b147637cf60ba5771e39375a9bd990`.
- Live re-check above re-run against `https://highlights-server.dpn.gg`,
  outputs match the source routes exactly.
