# Postgres persistence + real hosting

Status: approved, ready for implementation planning.

## Problem

`server/index.js` keeps every account, plan, and usage record in a plain
in-memory `Map`. It is lost on every process restart, and the server only
ever runs on `127.0.0.1` — there is no real, permanently reachable,
HTTPS-secured deployment. This spec replaces the in-memory store with a
real Postgres database and puts the server on real hosting, without
changing any of the security properties already built and tested
(password hashing, server-side-only plan/usage derivation, secrets only
ever read from environment variables).

## Scope

In scope:
- A Postgres schema covering exactly what the in-memory store holds today
  (accounts, plan/tier, per-month usage, Stripe customer id, plan
  expiry). No new tables for data the server doesn't currently track.
- Migrating `server/index.js`'s account-store functions from synchronous
  `Map` operations to async Postgres queries via `pg` (node-postgres),
  with no ORM — consistent with the codebase's existing "minimal
  dependencies, no framework" character.
- `DATABASE_URL` read from `process.env` only, same pattern as every
  other secret in this file.
- A restart-survival integration test: register/seed an account against
  a real Postgres, restart the server, confirm the account and its real
  plan/usage are still there and still correctly gated.
- A Render deployment (`render.yaml` blueprint: one web service + one
  managed Postgres instance), giving a real HTTPS address on Render's own
  subdomain with no custom domain or manual TLS setup required.
- `cloud.js`'s `productionApiBase` updated to the real deployed URL once
  it exists. `demoPlan`/`local` modes (`http://127.0.0.1:8787`) stay
  exactly as they are — nothing about local development changes.
- `git init` + a `.gitignore` update so the repo can be pushed to GitHub
  for Render's git-based deploy flow.

Explicitly out of scope (noted for later, not fixed in this pass):
- Referees and resume versions exist only in the client's
  `chrome.storage.local` profile object — there is no server-side table
  for them today, and the tracker-sync feature built earlier only ever
  synced `profile.applications`, not the whole profile. This pass does
  not add profile-wide sync or tables for referees/resume versions. It's
  worth flagging now so it doesn't quietly become "the database exists,
  so obviously everything is backed up" — it isn't, for anything outside
  the accounts table and the tracker's own sync payload.
- Data migration: the existing in-memory store only ever held
  test/demo accounts. The real database starts empty.
- A custom domain — Render's own `*.onrender.com` HTTPS subdomain is
  sufficient for this pass.

## Schema

```sql
CREATE TABLE IF NOT EXISTS accounts (
  token               UUID PRIMARY KEY,
  email               TEXT UNIQUE NOT NULL,
  password_salt       TEXT NOT NULL,
  password_hash       TEXT NOT NULL,
  plan_id             TEXT NOT NULL DEFAULT 'free',
  plan_expires_at     TIMESTAMPTZ,
  stripe_customer_id  TEXT,
  usage_month         TEXT NOT NULL,
  usage_drafts        INT NOT NULL DEFAULT 0,
  usage_resumes       INT NOT NULL DEFAULT 0,
  usage_cover_letters INT NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`token` stays the primary key — it's already the lookup key for every
call site in `server/index.js` (`authenticate()`, webhook handlers,
`chargeAI()`), so this is a storage-engine swap, not a key-shape change.

Tracker-sync's own storage (added in the previous pass, gated by
`plan.cloudSync`) keeps working exactly as it does today — it is not
touched by this migration, and is exactly the boundary case called out
above: it persists `applications` only, nothing else about the profile.

## Server changes (`server/index.js`, new `server/db.js`)

- `server/db.js`: a `pg.Pool` built from `process.env.DATABASE_URL`, and
  `initSchema()` (idempotent `CREATE TABLE IF NOT EXISTS`, run once on
  server startup) so there is no separate migration tool to operate at
  this size.
- `createAccountStore()` → becomes a thin wrapper around the pool
  (kept as the same exported name so `createServer(store)`'s call shape
  in every existing test file doesn't need to change beyond `await`).
- `seedAccount()`, `authenticate()`, `accountByEmail()` → become `async`,
  issue real parameterized queries. `authenticate()` still does nothing
  but look up the bearer token's row — same trust boundary as before.
- Register/login handlers → `INSERT`/`SELECT` against `accounts` instead
  of `Map.set`/`Map.get`. Password hashing (`scrypt`, random salt,
  timing-safe compare) is unchanged — only where the hash is written
  changes.
- `chargeAI()`'s usage increment, and the Stripe/Coinbase webhook plan
  grants → become `UPDATE accounts SET ... WHERE token = $1` instead of
  mutating the in-memory object. Every one of these still re-reads the
  account's real row before deciding anything — a client-body-asserted
  plan/usage field is still never trusted, same rule as today, just
  backed by a real row instead of a Map entry.

## Testing

- Existing `test-server-*.js` files are updated for the now-async store
  functions (`await seedAccount(...)`, etc.) and run against a real
  Postgres — no mock/in-memory substitute, since the whole point of this
  pass is proving durability. This means these tests need a reachable
  `DATABASE_URL` to run at all (documented in the test file's header).
- New `test-server-restart-survival.js`: seed an account and set it to a
  paid plan directly in the database, stop the running server, start a
  *new* server instance against the same `DATABASE_URL`, then confirm
  `/v1/usage` for that same bearer token still reports the correct plan
  and usage. This is the specific bug being fixed, so it gets its own
  dedicated test rather than being folded into the general suite.

## Hosting: Render

Chosen over Railway (dropped its permanent free tier; wants a payment
method before you can do anything) and Fly.io (Docker-first — more
DevOps than a plain Node app with no Dockerfile needs). Render hosts a
plain Node web service and a managed Postgres instance on one platform,
gives automatic HTTPS on a free `*.onrender.com` subdomain with no DNS or
certificate setup, auto-detects `npm start` for a plain Node app with no
Dockerfile required, and deploys from a connected GitHub repo on push.

`render.yaml` blueprint defines both the web service and the Postgres
instance together, so the account-creation side (which only the user can
do) is: create a GitHub account/repo if needed, create a Render account,
connect the repo, deploy the blueprint, done — Render wires
`DATABASE_URL` into the web service's environment automatically when the
two are linked in the same blueprint.

## Sequencing

All of the above (schema, `db.js`, migrated `server/index.js`, updated
tests, `render.yaml`, `git init`) can be written without a reachable
database. Running any of it for real — including the restart-survival
proof and getting a live HTTPS address to report back — requires the
account-creation and deploy steps only the user can perform (see the
step-by-step runbook delivered alongside the implementation). Once a live
`DATABASE_URL` and deployed URL exist, remaining verification (the
restart test against the real instance, `cloud.js`'s `productionApiBase`
pointed at the real address, a smoke-test round trip) happens against
that real deployment, not a local stand-in.
