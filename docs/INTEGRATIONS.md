# highlights.live — Integration Setup Guide

How to stand up every external integration: **auth**, **Stripe billing** (subscriptions
+ pay-as-you-go), and the **go-livepeer remote-signer / orchestrator** path. Follow the
numbered sections; each ends with an env var to set.

---

## 1. Auth

Users are stored in SQLite (`DATABASE_PATH`, default `data/highlights.db`). Passwords are
bcrypt-hashed; sessions are JWTs signed with `JWT_SECRET`.

- `POST /auth/register {email, password}` — create a user (password ≥ 8 chars).
  Returns `{ token, user }`.
- `POST /auth/login {email, password}` — returns `{ token, user }`.
- Attach the token: `Authorization: Bearer <token>`.
- Roles: `user` (their own data only) and `admin`. The **admin can review highlights**
  (`POST /highlights/:id/review`), users cannot.

Env:

| Var | Required | Default | Notes |
|---|---|---|---|
| `JWT_SECRET` | prod | `dev-insecure-secret-change-me` | **Must change in prod.** |
| `ADMIN_EMAIL` | no | `admin@highlights.local` | Seeded at startup. |
| `ADMIN_PASSWORD` | no | `admin` | Seeded admin login (dev). Set a real one in prod. |

The dev admin is `admin@highlights.local` / `admin`. Change both via env.

---

## 2. Billing model

Two tiers (see `services/server/src/billing.ts`):

- **Starter (free)** — `FREE_HIGHLIGHTS` included clips **lifetime** (default `3`).
  Once used, `POST /jobs` returns **402** with `upgrade: "/billing/checkout"`. This block
  stops free-$5-style farming without a card.
- **Pro (Stripe subscription)** — fixed monthly base (e.g. $9/mo) with `PLAN.includedHighlights`
  (default `25`) per period. Every clip after the included quota is billed **pay-as-you-go**
  via a Stripe *metered usage record* on the subscription.

Key endpoints (all require `Authorization`):

- `GET /billing/plans` — public plan list.
- `POST /billing/checkout` — returns a Stripe **Checkout** URL to subscribe.
- `POST /billing/portal` — returns the Stripe **Customer Portal** URL (manage/cancel).
- `GET /billing/status` — `{ tier, status, usedHighlights, freeHighlights }`.
- `POST /stripe/webhook` — receives Stripe webhooks (no auth; verified by signature).

Usage metering flow:
1. Job runs; each highlight calls `billing.onHighlightCreated(user, sub)`.
2. DB counter increments (`usage_events` row) for all tiers.
3. If Pro + usage-based item configured, overage posts a Stripe usage record
   (`subscriptionItems.createUsageRecord`, action `increment`) → billed on the next invoice.

---

## 3. Stripe setup (steps)

1. **Account + key** — create a Stripe account; copy the **Secret key** (`sk_live_...` /
   `sk_test_...`). Set `STRIPE_SECRET_KEY`.

2. **Base subscription price** — Dashboard → Product catalog → **Add product**
   "Highlights Pro" → **Add price**: recurring, monthly, e.g. `$9.00 USD / month`.
   Copy that **Price API ID** (`price_...`) → `STRIPE_PRICE_PRO`.

3. **Metered (usage) price** — on the Pro product add a **second price**:
   **Pay as you go / usage-based**, billing *"usage-based"*, aggregate *"metered"* / "last
   value", e.g. `$0.50 USD / unit`, `1 unit = 1 highlight`. Copy its Price API ID →
   `STRIPE_PRICE_USAGE`. This line is added to the Pro subscription in Checkout; the server
   meters overage against it.

4. **Webhook** — Stripe Dashboard → Developers → Webhooks → **Add endpoint**:
   URL `https://<server>/stripe/webhook`. Subscribe to events:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   Copy the **Signing secret** (`whsec_...`) → `STRIPE_WEBHOOK_SECRET`.

   For local testing use the Stripe CLI:
   ```
   stripe listen --forward-to localhost:3000/stripe/webhook
   ```
   (prints a `whsec_...` to use as `STRIPE_WEBHOOK_SECRET`).

5. **Return URLs** — set `PUBLIC_BASE_URL` to your public origin (e.g.
   `https://your-app.railway.app`) so Checkout/Portal redirect back correctly.

Env summary for Stripe: `STRIPE_SECRET_KEY`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_USAGE`,
`STRIPE_WEBHOOK_SECRET`, `PUBLIC_BASE_URL`.

> Billing auto-disables (server logs a warning; `GET /jobs` still enforces the free quota)
> until `STRIPE_SECRET_KEY` + `STRIPE_PRICE_PRO` are set — handy for local/CI.

---

## 4. Local run (offchain, no Stripe)

```
docker compose -f docker/docker-compose.yml up -d --build
bash docker/e2e.sh          # registers a user, runs a job through the orchestrator
```

Server env for the compose stack:
```
PORT=3000
JWT_SECRET=dev-secret
ADMIN_EMAIL=admin@highlights.local
ADMIN_PASSWORD=admin
FREE_HIGHLIGHTS=3          # free farming cap (0 = block free allowance entirely)
DATABASE_PATH=/data/highlights.db
ORCHESTRATOR_URL=https://orchestrator:8935
NODE_TLS_REJECT_UNAUTHORIZED=0   # only while the local orchestrator has a self-signed cert
```
`docker/Dockerfile.server` already sets the runtime bits; add the above via the compose
`environment:` block (see `docker-compose.yml` `server` service).

---

## 5. Railway deployment (server + remote signer, two services)

See `infra/railway/README.md` for the exact two-service split. Summary:

- **Server** — public domain, port 3000. Env: everything in §1–§3 plus `DATABASE_PATH`
  pointed at a persistent volume, and `SIGNER_URL` (only on the on-chain path below).
- **Remote signer** (go-livepeer `-remoteSigner`) — **no public domain**; the server reaches
  it only via private DNS (`http://<signer-service>.railway.internal:7936`). It holds the
  ETH keystore and talks to Arbitrum. Needs `ARBITRUM_RPC`, `ETH_PASSWORD`, `SIGNER_AUTH_TOKEN`.
  Cannot run on `-network offchain`.

On-chain payment flow (requires a funded Arbitrum wallet + a livepeer deposit made via the
signer CLI): reserve → `402 Payment Required` → server calls
`signer.generateLivePayment(...)` → retries with `Livepeer-Payment` / `Livepeer-Segment`
headers → refresh per interval (`packages/livepeer-session`).

---

## 6. End-to-end verification

- `npm test` — 37 TS tests (auth, billing w/ Stripe stub, quota gate, real-ffmpeg job,
  contracts, livepeer-session).
- Python suites: `services/perceive` (11) and `services/decide` (5).

Quick manual auth smoke against a running server:
```
TOKEN=$(curl -s -X POST localhost:3000/auth/register -H 'content-type: application/json' \
  -d '{"email":"me@x.dev","password":"password123"}' | jq -r .token)
curl -s localhost:3000/billing/status -H "authorization: Bearer $TOKEN"
```
