# highlights.live — Integration Setup Guide

How to stand up every external integration: **auth**, **Stripe billing** (subscriptions
+ pay-as-you-go), and the **go-livepeer remote-signer / orchestrator** path. Follow the
numbered sections; each ends with an env var to set.

---

## 0. Persistent storage, migrations & backups

All stateful data — **users**, **entitlements/subscriptions**, usage, media
sessions, and the pipeline's **jobs + highlight records** — is stored in one
DB and survives server restarts (`services/server/src/db.ts`, `store.ts`). Two
backends behind one interface:

- **SQLite (dev)** — Node's built-in `node:sqlite` at `DATABASE_PATH`
  (default `data/highlights.db`). Zero-setup local/CI default.
- **PostgreSQL (prod)** — when `DATABASE_URL` is set, the server uses Postgres
  (`pg`) instead of SQLite. `DATABASE_URL` is a standard
  `postgres://user:pass@host:5432/dbname` connection string.

| Var | Default | Notes |
|---|---|---|
| `DATABASE_PATH` | `data/highlights.db` | SQLite file (used only when `DATABASE_URL` is unset). |
| `DATABASE_URL` | — | Postgres connection string. When set, overrides SQLite. |
| `DATABASE_BACKUP_DIR` | `data/backups` | Where `npm run db:backup` writes snapshots. |

**Migrations.** The baseline schema (`CREATE TABLE IF NOT EXISTS`) is applied
idempotently on every boot; column/row *changes* to existing data run as
tracked, versioned migrations recorded in `_schema_migrations` (applied once,
in order). To add a schema change, append a new entry to `MIGRATIONS` in
`services/server/src/db.ts` rather than scattering one-off `ALTER`s. A restart
against an older on-disk DB is therefore safe — pending migrations run
automatically at boot.

**Backups.** `npm run db:backup` (in `services/server`) writes a consistent,
integrity-checked snapshot to `DATABASE_BACKUP_DIR`:
- SQLite: `VACUUM INTO` (atomic even mid-write) + `PRAGMA integrity_check`.
- Postgres: `pg_dump` (must be installed).

Recommended rotation via cron (keep the N most recent yourself):
```cron
0 3 * * * cd <repo>/services/server && npm run db:backup --silent
```

---

## 1. Auth

Users are stored in the DB above (SQLite dev / Postgres prod). Passwords are
bcrypt-hashed; sessions are JWTs signed with `JWT_SECRET`.

- `POST /auth/register {email, password}` — create a user (password ≥ 8 chars).
  Returns `{ token, user }`.
- `POST /auth/login {email, password}` — returns `{ token, user }`.
- `GET /auth/me` (`Authorization: Bearer …`) — session re-hydration: returns the
  current user for the token, or 401 if stale/revoked. The SPA calls this on load
  to restore a logged-in session.
- `POST /auth/forgot {email}` — starts a password reset. Always returns
  `{ ok: true }` (no account enumeration). **Beta**: there is no mailer yet, so a
  real account also returns the single-use `resetToken` inline so the loop can be
  completed; wire it to an email send before public launch.
- `POST /auth/reset {token, password}` — redeems the single-use reset token with
  a new password (≥ 8 chars). Invalid/expired tokens → 400.
- Attach the token: `Authorization: Bearer <token>`.
- Roles: `user` (their own data only) and `admin`. The **admin can review highlights**
  (`POST /highlights/:id/review`), users cannot.

Rate limiting: the four public auth endpoints share an in-process fixed-window
per-IP budget (`AUTH_RATE_LIMIT` requests per `AUTH_RATE_LIMIT_WINDOW_SEC`), so
credential-stuffing / forgot-spam gets a `429` with a `Retry-After` header.

Env:

| Var | Required | Default | Notes |
|---|---|---|---|
| `JWT_SECRET` | prod | `dev-insecure-secret-change-me` | **Must change in prod.** |
| `ADMIN_EMAIL` | no | `admin@highlights.local` | Seeded at startup. |
| `ADMIN_PASSWORD` | no | `admin` | Seeded admin login (dev). Set a real one in prod. |
| `RESET_TOKEN_TTL_SEC` | no | `3600` | Password-reset token lifetime (seconds). |
| `AUTH_RATE_LIMIT` | no | `30` | Max auth requests per IP per window. |
| `AUTH_RATE_LIMIT_WINDOW_SEC` | no | `60` | Rate-limit window (seconds). |

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

- `npm test` — TypeScript tests (auth, billing w/ Stripe stub, quota gate,
  persistence/restart-survival, real-ffmpeg job, contracts, livepeer-session).
- Python suites: `services/perceive` (11) and `services/decide` (5).

Quick manual auth smoke against a running server:
```
TOKEN=$(curl -s -X POST localhost:3000/auth/register -H 'content-type: application/json' \
  -d '{"email":"me@x.dev","password":"password123"}' | jq -r .token)
curl -s localhost:3000/billing/status -H "authorization: Bearer $TOKEN"
```
