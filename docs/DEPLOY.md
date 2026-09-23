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

## Live-payment durability (ADAAAA-3932)

The paid path (live/VOD -> orchestrator -> remote signer) is the source of the
recurring 402. Two things must survive every redeploy — both are documented in
`.env.example` at the repo root:

1. **Orchestrator ticket EV.** `docker/docker-compose.yml` hard-codes
   `- -ticketEV=80000000000` on the `orchestrator` service. Do not lower it:
   the default 8e9 makes go-livepeer size ~454-ticket live-payment lottery
   batches, which the signer rejects with 400 `numTickets N exceeds maximum of
   100` and the session fails 402 before any GPU compute. 8e10 keeps batches
   under the hard cap of 100 with unchanged total EV. Keep `TICKET_EV` in the
   box `.env` at `80000000000` too.

2. **SIGNER_URL + PAYER_ADDRESS.** These are required, non-empty values in the
   box `.env` (`SIGNER_URL=http://signer:7936`, `PAYER_ADDRESS=<payer
   address>`). The compose placeholders are `${SIGNER_URL:-}` /
   `${PAYER_ADDRESS:-}`, so if they are missing from `.env` a container
   recreate resolves them to empty and every paid session fails 402 "invalid
   live runner payment signer address". `SIGNER_AUTH_TOKEN` is the shared
   bearer secret sent to the remote signer and must also be in `.env`.

Define the full set in `.env` (copy `.env.example`). Never commit a real
`.env`; it holds `SIGNER_AUTH_TOKEN`, `ORCHESTRATOR_ETH_PASSWORD`, database and
SMTP credentials. After a repo-based redeploy, confirm with:

```sh
docker inspect highlights-orchestrator --format '{{.Config.Cmd}}'   # has -ticketEV=80000000000
docker logs highlights-orchestrator | grep TicketEV                  # | TicketEV | 80000000000 |
docker inspect highlights-media --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E 'SIGNER_URL|PAYER_ADDRESS'
```

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
