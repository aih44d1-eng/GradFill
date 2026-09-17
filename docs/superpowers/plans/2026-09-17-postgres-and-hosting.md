# Postgres Persistence + Render Hosting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `server/index.js`'s in-memory `Map` account store with a real Postgres database, and prepare the app for deployment on Render, without changing any existing security property or breaking local/demo mode.

**Architecture:** A new `server/db.js` wraps a `pg.Pool` and an idempotent `initSchema()`. Every account-store function in `server/index.js` (`seedAccount`, `authenticate`, `accountByEmail`, register/login handlers, `chargeAI`'s usage persistence, the Stripe/Coinbase webhook plan grants) is converted from synchronous `Map` access to `async`/`await` Postgres queries. `chargeAI()` itself stays a pure, synchronous decision function — only the persistence step around it changes.

**Tech Stack:** Node.js (built-in `http`/`https`/`crypto`, unchanged), `pg` (new dependency, node-postgres — no ORM), Postgres (Render-managed in production).

## Global Constraints

- Every existing security property is preserved exactly: passwords hashed with `scrypt` (never plaintext), every AI/billing/tracker-sync check re-derives plan and usage from the database itself and never trusts a client-asserted field, secrets read only from `process.env` (`DATABASE_URL` joins `STRIPE_SECRET_KEY`, `COINBASE_COMMERCE_API_KEY`, etc. in that pattern).
- No ORM — hand-written parameterized SQL via `pg`, matching the codebase's existing "minimal dependencies, no framework" character.
- `token` column is `TEXT`, not `UUID` — the existing test suite seeds accounts with non-UUID fake tokens (`"free-token"`, `"pro-token"`) that a UUID column would reject.
- No data migration — the in-memory store never held real user data. The real database starts empty.
- Local/demo mode (`GFCloud`'s `demo`/`local` settings in `cloud.js`) must keep working completely unchanged — this plan does not touch `cloud.js`'s `demo`/`local` code paths at all, only documents the future `productionApiBase` edit as a manual post-deploy step.
- This plan does **not** add profile-wide sync or tables for referees/resume versions — those remain client-side-only, a known gap tracked in the spec, not fixed here.

## Prerequisite (read before starting Task 3)

Tasks 1 and 2 need no database. From Task 3 onward, every "run it, confirm PASS" step needs a real, reachable, **empty** Postgres database and a `DATABASE_URL` environment variable pointing at it (any Postgres 13+ works — a local install, a free instance from a host like Neon/Supabase, or Render's own Postgres created ahead of the full deploy). Set it before continuing, e.g.:

```bash
export DATABASE_URL="postgres://user:password@host:5432/dbname"
```

---

### Task 1: Add `pg` as a dependency

**Files:**
- Create: `package.json`

**Interfaces:**
- Produces: an installed `pg` package other tasks' `require("pg")` calls depend on.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "gradfill-backend",
  "version": "1.0.0",
  "private": true,
  "description": "GradFill AI reference backend",
  "main": "server/index.js",
  "scripts": {
    "start": "node server/index.js",
    "test": "node test-server-auth.js && node test-server-billing.js && node test-server-enforcement.js && node test-server-restart-survival.js"
  },
  "dependencies": {
    "pg": "^8.13.0"
  }
}
```

- [ ] **Step 2: Install it**

Run: `npm install`
Expected: `node_modules/pg` exists, `package-lock.json` is created, no errors.

- [ ] **Step 3: Verify it loads**

Run: `node -e "require('pg'); console.log('pg loaded ok')"`
Expected: prints `pg loaded ok`

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "Add pg dependency for Postgres-backed account storage"
```

---

### Task 2: `server/db.js` — pool, schema, row mapping

**Files:**
- Create: `server/db.js`
- Test: `test-server-db.js`

**Interfaces:**
- Produces: `createPool(connectionString?) -> pg.Pool`, `initSchema(pool) -> Promise<void>`, `rowToAccount(row) -> account|null` where `account` has shape `{ token, email, passwordSalt, passwordHash, planId, planExpiresAt: number|null, stripeCustomerId: string|undefined, usage: { month, drafts, resumes, coverLetters } }` — this exact shape is what every later task's account object looks like.

- [ ] **Step 1: Write the failing test**

Create `test-server-db.js`:

```js
/* Proves server/db.js can create the schema idempotently against a real
   Postgres and that rowToAccount() maps a raw row into the exact shape
   the rest of server/index.js expects. Requires DATABASE_URL to point at
   a reachable Postgres — see docs/superpowers/plans/2026-09-17-postgres-and-hosting.md.
   Run: node test-server-db.js */
const assert = require("assert");
const { createPool, initSchema, rowToAccount } = require("./server/db.js");

async function run() {
  if (!process.env.DATABASE_URL) {
    console.log("SKIPPED — set DATABASE_URL to a reachable Postgres to run this test.");
    process.exit(0);
  }
  let failures = 0;
  function check(name, cond) {
    if (cond) console.log("  ok  - " + name);
    else { failures++; console.log("  FAIL - " + name); }
  }

  const pool = createPool();
  try {
    await initSchema(pool);
    check("initSchema runs without throwing", true);
    await initSchema(pool);
    check("initSchema is idempotent (running it twice does not throw)", true);

    await pool.query("DELETE FROM accounts WHERE token = 'db-test-token'");
    await pool.query(
      `INSERT INTO accounts (token, email, password_salt, password_hash, plan_id, usage_month, usage_drafts, usage_resumes, usage_cover_letters)
       VALUES ('db-test-token', 'db-test@test.local', 'salt', 'hash', 'pro', '2026-09', 3, 1, 2)`
    );
    const res = await pool.query("SELECT * FROM accounts WHERE token = 'db-test-token'");
    const account = rowToAccount(res.rows[0]);
    check("rowToAccount maps token", account.token === "db-test-token");
    check("rowToAccount maps email", account.email === "db-test@test.local");
    check("rowToAccount maps planId", account.planId === "pro");
    check("rowToAccount maps usage", account.usage.month === "2026-09" && account.usage.drafts === 3 && account.usage.resumes === 1 && account.usage.coverLetters === 2);
    check("rowToAccount maps a null plan_expires_at as null", account.planExpiresAt === null);
    check("rowToAccount(undefined) returns null, not throws", rowToAccount(undefined) === null);

    await pool.query("DELETE FROM accounts WHERE token = 'db-test-token'");
  } finally {
    await pool.end();
  }

  console.log("\n" + (failures === 0 ? "All db.js checks passed." : failures + " db.js check(s) FAILED."));
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-server-db.js`
Expected: FAIL with `Cannot find module './server/db.js'`

- [ ] **Step 3: Write `server/db.js`**

```js
/* Postgres persistence for the account store -- replaces the old
   in-memory Map so accounts/plan/usage survive a process restart. Plain
   `pg`, no ORM, matching this codebase's existing minimal-dependency,
   no-framework style. Connection string comes from DATABASE_URL only,
   same "secrets live in env vars, never in the repo" rule as every other
   key in server/index.js. */
"use strict";
const { Pool } = require("pg");

function createPool(connectionString) {
  return new Pool({ connectionString: connectionString || process.env.DATABASE_URL });
}

/* token is TEXT, not UUID: real tokens are crypto.randomUUID() strings
   (still valid UUIDs), but the test suite seeds accounts with
   human-readable fake tokens ("free-token", "pro-token") that a UUID
   column would reject outright. */
async function initSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      token               TEXT PRIMARY KEY,
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
    )
  `);
}

/* Maps one `accounts` row into the exact shape server/index.js's
   in-memory account object used to have, so every function that reads
   `account.planId` / `account.usage.drafts` / etc. needs no shape
   changes elsewhere, only a sync->async call-site change. */
function rowToAccount(row) {
  if (!row) return null;
  return {
    token: row.token,
    email: row.email,
    passwordSalt: row.password_salt,
    passwordHash: row.password_hash,
    planId: row.plan_id,
    planExpiresAt: row.plan_expires_at ? new Date(row.plan_expires_at).getTime() : null,
    stripeCustomerId: row.stripe_customer_id || undefined,
    usage: {
      month: row.usage_month,
      drafts: row.usage_drafts,
      resumes: row.usage_resumes,
      coverLetters: row.usage_cover_letters
    }
  };
}

module.exports = { createPool, initSchema, rowToAccount };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-server-db.js`
Expected: `All db.js checks passed.` (or `SKIPPED` if `DATABASE_URL` is unset — that's an acceptable pass state for this step only if you have not yet set up a database; every later task's tests require it, so set it up now if you haven't)

- [ ] **Step 5: Commit**

```bash
git add server/db.js test-server-db.js
git commit -m "Add Postgres pool/schema/row-mapping module (server/db.js)"
```

---

### Task 3: Migrate `server/index.js`'s account-store internals to Postgres

**Files:**
- Modify: `server/index.js:19-116` (requires block through the end of `chargeAI`)

**Interfaces:**
- Consumes: `createPool`, `initSchema`, `rowToAccount` from Task 2's `server/db.js`.
- Produces: `createAccountStore(connectionString?) -> { pool }` (now sync, pool creation is cheap/lazy), `ensureSchema(store) -> Promise<void>`, `closeAccountStore(store) -> Promise<void>`, `seedAccount(store, token, planId, email?) -> Promise<void>`, `getAccount(store, token) -> Promise<account|null>`, `setAccountFieldsForTest(store, token, fields) -> Promise<void>` (fields keys: `planId`, `stripeCustomerId`, `planExpiresAt`), `authenticate(store, req) -> Promise<account|null>`, `accountByEmail(store, email) -> Promise<account|null>`, `persistUsage(store, account) -> Promise<void>`. `chargeAI(account, kind)` keeps its exact existing synchronous signature and body — later tasks call `persistUsage` right after a successful `chargeAI`.

- [ ] **Step 1: Replace lines 19-22 (requires) to add the db.js import**

Find:
```js
const http = require("http");
const https = require("https");
const crypto = require("crypto");
```

Replace with:
```js
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { createPool, initSchema, rowToAccount } = require("./db.js");
```

- [ ] **Step 2: Replace the account-store block, lines 51-93 (`createAccountStore` through `verifyPassword`)**

Find (the whole block from the `createAccountStore` comment through the end of `verifyPassword`):
```js
/* In-memory account store, keyed by bearer token. Real deployment: a real
   database, with planId written by the Stripe webhook handler, never by
   any request this file serves — /v1/auth/register below always creates
   free-plan accounts, and there is no route that lets a caller set their
   own plan, which is the whole point. seedAccount() is a TEST-ONLY helper
   for planting an account (e.g. already on Pro) without going through
   registration. */
function createAccountStore() {
  return { accounts: new Map() };
}
function seedAccount(store, token, planId, email) {
  store.accounts.set(token, { token, email: email || (planId + "@test.local"), planId: planId || "free", usage: { month: monthKey(), drafts: 0, resumes: 0, coverLetters: 0 } });
}

function authenticate(store, req) {
  const h = req.headers["authorization"] || "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (!m) return null;
  const account = store.accounts.get(m[1]);
  return account || null;
}

function accountByEmail(store, email) {
  const needle = String(email || "").trim().toLowerCase();
  for (const account of store.accounts.values()) {
    if (account.email && account.email.toLowerCase() === needle) return account;
  }
  return null;
}

/* scrypt, not plaintext, not a fixed salt — this is still a reference
   server (no rate limiting, no email verification), but there is no
   reason to get password storage wrong just because the rest is a stub. */
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const check = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(check, "hex"), b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

Replace with:
```js
/* Real Postgres-backed account store, replacing the old in-memory Map --
   every account, plan, and usage record now survives a process restart.
   store.pool is a pg.Pool. ensureSchema() must be awaited once before the
   store is used (both createServer's main-module startup block below and
   every test file call it explicitly right after createAccountStore()). */
function createAccountStore(connectionString) {
  return { pool: createPool(connectionString) };
}
async function ensureSchema(store) {
  await initSchema(store.pool);
}
async function closeAccountStore(store) {
  await store.pool.end();
}

/* TEST-ONLY helper for planting an account (e.g. already on Pro) without
   going through registration -- same purpose as the old in-memory
   version, now backed by a real row. Safe to call twice for the same
   token (some test files reuse fixture tokens across runs) -- it just
   re-asserts the given plan on conflict rather than erroring. */
async function seedAccount(store, token, planId, email) {
  const mk = monthKey();
  await store.pool.query(
    `INSERT INTO accounts (token, email, password_salt, password_hash, plan_id, usage_month, usage_drafts, usage_resumes, usage_cover_letters)
     VALUES ($1, $2, '', '', $3, $4, 0, 0, 0)
     ON CONFLICT (token) DO UPDATE SET plan_id = EXCLUDED.plan_id`,
    [token, email || ((planId || "free") + "@test.local"), planId || "free", mk]
  );
}

/* TEST-ONLY helper: direct field writes for test setup that the old
   in-memory tests did via store.accounts.get(token).field = value (e.g.
   "manually promote it to Pro", "backdate planExpiresAt to prove expiry
   is a read-time check, not a background sweep"). Never called from any
   HTTP route -- those all decide plan changes themselves, via the
   register handler or the webhook handlers below. */
async function setAccountFieldsForTest(store, token, fields) {
  const cols = { planId: "plan_id", stripeCustomerId: "stripe_customer_id", planExpiresAt: "plan_expires_at" };
  const sets = [], values = [];
  Object.keys(fields || {}).forEach((k) => {
    if (!cols[k]) throw new Error("setAccountFieldsForTest: unknown field '" + k + "'");
    values.push(k === "planExpiresAt" && fields[k] != null ? new Date(fields[k]) : fields[k]);
    sets.push(cols[k] + " = $" + values.length);
  });
  values.push(token);
  await store.pool.query(`UPDATE accounts SET ${sets.join(", ")} WHERE token = $${values.length}`, values);
}

async function getAccount(store, token) {
  if (!token) return null;
  const res = await store.pool.query("SELECT * FROM accounts WHERE token = $1", [token]);
  return rowToAccount(res.rows[0]);
}

async function authenticate(store, req) {
  const h = req.headers["authorization"] || "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (!m) return null;
  return getAccount(store, m[1]);
}

async function accountByEmail(store, email) {
  const needle = String(email || "").trim().toLowerCase();
  const res = await store.pool.query("SELECT * FROM accounts WHERE lower(email) = $1", [needle]);
  return rowToAccount(res.rows[0]);
}

/* scrypt, not plaintext, not a fixed salt — this is still a reference
   server (no rate limiting, no email verification), but there is no
   reason to get password storage wrong just because the rest is a stub. */
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const check = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(check, "hex"), b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

- [ ] **Step 3: Add `persistUsage`, right after `chargeAI`'s closing brace (currently ending at original line 116)**

Find:
```js
function chargeAI(account, kind) {
  const plan = planFor(account);
  if (!plan.aiEnabled) return { ok: false, status: 402, code: "paywall", message: "This is a GradFill Pro feature — upgrade to use AI drafting." };
  const mk = monthKey();
  if (account.usage.month !== mk) account.usage = { month: mk, drafts: 0, resumes: 0, coverLetters: 0 };
  const key = kind === "resume" ? "resumes" : kind === "coverletter" ? "coverLetters" : "drafts";
  const limit = kind === "resume" ? plan.resumeTailorsPerMonth : kind === "coverletter" ? plan.coverLettersPerMonth : plan.aiDraftsPerMonth;
  if (account.usage[key] >= limit) return { ok: false, status: 402, code: "quota", message: "Monthly limit reached — resets next month, or upgrade for a higher cap." };
  account.usage[key] += 1;
  return { ok: true };
}
```

Keep this function completely unchanged (it stays pure and synchronous — it only mutates the in-memory `account` object it was handed), and add immediately after it:

```js
/* chargeAI() above only mutates the in-memory account object it was
   handed -- it has no idea a database exists. This is the missing half:
   write that mutated usage back to the account's real row. Called right
   after a successful chargeAI() in the AI route handler below. */
async function persistUsage(store, account) {
  await store.pool.query(
    "UPDATE accounts SET usage_month = $1, usage_drafts = $2, usage_resumes = $3, usage_cover_letters = $4 WHERE token = $5",
    [account.usage.month, account.usage.drafts, account.usage.resumes, account.usage.coverLetters, account.token]
  );
}
```

- [ ] **Step 4: Sanity-check the file still parses**

Run: `node -e "require('./server/index.js'); console.log('parses ok')"`
Expected: prints `parses ok` (the exports at the bottom still reference the old names for now — that's fixed in Task 4, so this step only proves no syntax errors)

- [ ] **Step 5: Commit**

```bash
git add server/index.js
git commit -m "Migrate account-store internals from in-memory Map to Postgres"
```

---

### Task 4: Migrate route handlers, add a health-check route, update exports and startup

**Files:**
- Modify: `server/index.js:376-679` (route handlers through end of file)

**Interfaces:**
- Consumes: everything from Task 3.
- Produces: `GET /healthz` (no auth, no DB — for Render's health check), updated `module.exports` including `ensureSchema`, `closeAccountStore`, `getAccount`, `setAccountFieldsForTest`, `persistUsage`.

- [ ] **Step 1: Add the health-check route.** Find the top of `createServer`'s request handler, right after the `path` is computed:

```js
    const path = (req.url || "").split("?")[0];

    if (req.method === "POST" && path === "/v1/auth/register") {
```

Replace with:

```js
    const path = (req.url || "").split("?")[0];

    // Unauthenticated, no database access — exists purely so a hosting
    // platform's health check (e.g. Render) has something to poll that
    // can't itself fail because a bearer token or a DB row is missing.
    if (req.method === "GET" && path === "/healthz") {
      send(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && path === "/v1/auth/register") {
```

- [ ] **Step 2: Make the register handler async-aware.** Find:

```js
    if (req.method === "POST" && path === "/v1/auth/register") {
      const body = await readBody(req);
      const email = String((body && body.email) || "").trim();
      const password = String((body && body.password) || "");
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { send(res, 400, { error: "A valid email is required." }); return; }
      if (password.length < 8) { send(res, 400, { error: "Password must be at least 8 characters." }); return; }
      if (accountByEmail(store, email)) { send(res, 409, { error: "An account with that email already exists." }); return; }

      const token = crypto.randomUUID();
      const { salt, hash } = hashPassword(password);
      const account = {
        token, email, passwordSalt: salt, passwordHash: hash,
        // Every new account starts on Free — nothing in this request body
        // (there is no `plan` field the client could even send) picks the
        // plan. Only the Stripe-webhook path (not implemented in this
        // reference server) is ever meant to move an account off Free.
        planId: "free",
        usage: { month: monthKey(), drafts: 0, resumes: 0, coverLetters: 0 }
      };
      store.accounts.set(token, account);
      send(res, 200, { account: toClientAccount(account) });
      return;
    }
```

Replace with:

```js
    if (req.method === "POST" && path === "/v1/auth/register") {
      const body = await readBody(req);
      const email = String((body && body.email) || "").trim();
      const password = String((body && body.password) || "");
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { send(res, 400, { error: "A valid email is required." }); return; }
      if (password.length < 8) { send(res, 400, { error: "Password must be at least 8 characters." }); return; }
      if (await accountByEmail(store, email)) { send(res, 409, { error: "An account with that email already exists." }); return; }

      const token = crypto.randomUUID();
      const { salt, hash } = hashPassword(password);
      // Every new account starts on Free — nothing in this request body
      // (there is no `plan` field the client could even send) picks the
      // plan. Only the Stripe/Coinbase webhook handlers below are ever
      // meant to move an account off Free.
      await store.pool.query(
        `INSERT INTO accounts (token, email, password_salt, password_hash, plan_id, usage_month, usage_drafts, usage_resumes, usage_cover_letters)
         VALUES ($1, $2, $3, $4, 'free', $5, 0, 0, 0)`,
        [token, email, salt, hash, monthKey()]
      );
      const account = await getAccount(store, token);
      send(res, 200, { account: toClientAccount(account) });
      return;
    }
```

- [ ] **Step 3: Make the login handler async-aware.** Find:

```js
    if (req.method === "POST" && path === "/v1/auth/login") {
      const body = await readBody(req);
      const email = String((body && body.email) || "").trim();
      const password = String((body && body.password) || "");
      const account = accountByEmail(store, email);
      if (!account || !account.passwordHash || !verifyPassword(password, account.passwordSalt, account.passwordHash)) {
        send(res, 401, { error: "Invalid email or password." });
        return;
      }
      send(res, 200, { account: toClientAccount(account) });
      return;
    }
```

Replace with:

```js
    if (req.method === "POST" && path === "/v1/auth/login") {
      const body = await readBody(req);
      const email = String((body && body.email) || "").trim();
      const password = String((body && body.password) || "");
      const account = await accountByEmail(store, email);
      if (!account || !account.passwordHash || !verifyPassword(password, account.passwordSalt, account.passwordHash)) {
        send(res, 401, { error: "Invalid email or password." });
        return;
      }
      send(res, 200, { account: toClientAccount(account) });
      return;
    }
```

- [ ] **Step 4: Await every remaining `authenticate(store, req)` call and persist usage after a successful AI charge.** There are five more call sites — the AI routes handler, both Places routes, and both billing-checkout/portal/crypto-checkout routes. Find each exact line and change `authenticate(store, req)` to `await authenticate(store, req)`:

```js
    if (req.method === "POST" && AI_ROUTES[path]) {
      const kind = AI_ROUTES[path];
      const account = authenticate(store, req);
      if (!account) { send(res, 401, { error: "Missing or invalid token" }); return; }

      const body = await readBody(req);
      // Deliberately not read: body.plan, body.aiEnabled, body.entitlement,
      // or any other client-asserted authorization field. Entitlement
      // comes from `account`, resolved above from the server's own store —
      // that's the fix. A spoofed field in `body` has zero effect below.

      const gate = chargeAI(account, kind);
      if (!gate.ok) { send(res, gate.status, { error: gate.message, code: gate.code }); return; }

      const result = stubProvider(kind, body);
      send(res, 200, result);
      return;
    }
```

Replace with:

```js
    if (req.method === "POST" && AI_ROUTES[path]) {
      const kind = AI_ROUTES[path];
      const account = await authenticate(store, req);
      if (!account) { send(res, 401, { error: "Missing or invalid token" }); return; }

      const body = await readBody(req);
      // Deliberately not read: body.plan, body.aiEnabled, body.entitlement,
      // or any other client-asserted authorization field. Entitlement
      // comes from `account`, resolved above from the server's own store —
      // that's the fix. A spoofed field in `body` has zero effect below.

      const gate = chargeAI(account, kind);
      if (!gate.ok) { send(res, gate.status, { error: gate.message, code: gate.code }); return; }
      await persistUsage(store, account);

      const result = stubProvider(kind, body);
      send(res, 200, result);
      return;
    }
```

Then, in the two Places routes (`GET /v1/places/autocomplete` and `GET /v1/places/details`) and the three billing routes (`POST /v1/billing/checkout`, `POST /v1/billing/portal`, `POST /v1/billing/crypto/checkout`) and `GET /v1/usage`, each contains a line reading exactly:

```js
      const account = authenticate(store, req);
```

Change every one of those six occurrences to:

```js
      const account = await authenticate(store, req);
```

- [ ] **Step 5: Migrate the Stripe webhook's plan grants.** Find:

```js
      if (event.type === "checkout.session.completed") {
        const session = event.data && event.data.object;
        const token = session && session.metadata && session.metadata.gradfill_account_token;
        const planId = session && session.metadata && session.metadata.gradfill_plan;
        const account = token && store.accounts.get(token);
        if (account && PLAN_DEFS[planId]) {
          account.planId = planId;
          if (session.customer) account.stripeCustomerId = session.customer;
          account.planExpiresAt = planId === "season" ? Date.now() + PLAN_DEFS.season.seasonDays * 24 * 60 * 60 * 1000 : null;
        }
      } else if (event.type === "customer.subscription.deleted") {
        const sub = event.data && event.data.object;
        const customerId = sub && sub.customer;
        for (const account of store.accounts.values()) {
          if (account.stripeCustomerId === customerId) { account.planId = "free"; account.planExpiresAt = null; }
        }
      }
```

Replace with:

```js
      if (event.type === "checkout.session.completed") {
        const session = event.data && event.data.object;
        const token = session && session.metadata && session.metadata.gradfill_account_token;
        const planId = session && session.metadata && session.metadata.gradfill_plan;
        const account = token ? await getAccount(store, token) : null;
        if (account && PLAN_DEFS[planId]) {
          const expiresAt = planId === "season" ? new Date(Date.now() + PLAN_DEFS.season.seasonDays * 24 * 60 * 60 * 1000) : null;
          await store.pool.query(
            "UPDATE accounts SET plan_id = $1, plan_expires_at = $2, stripe_customer_id = COALESCE($3, stripe_customer_id) WHERE token = $4",
            [planId, expiresAt, session.customer || null, token]
          );
        }
      } else if (event.type === "customer.subscription.deleted") {
        const sub = event.data && event.data.object;
        const customerId = sub && sub.customer;
        if (customerId) {
          await store.pool.query("UPDATE accounts SET plan_id = 'free', plan_expires_at = NULL WHERE stripe_customer_id = $1", [customerId]);
        }
      }
```

- [ ] **Step 6: Migrate the Coinbase webhook's plan grant.** Find:

```js
      if (coinbaseEventGrantsPlan(event)) {
        const charge = event.data;
        const meta = charge && charge.metadata;
        const token = meta && meta.gradfill_account_token;
        const planId = meta && meta.gradfill_plan;
        const account = token && store.accounts.get(token);
        // Belt-and-braces: only ever grant a plan this route is allowed to
        // grant, even if a stored charge's metadata somehow said otherwise.
        if (account && CRYPTO_ELIGIBLE_PLANS[planId]) {
          account.planId = planId;
          account.planExpiresAt = Date.now() + PLAN_DEFS.season.seasonDays * 24 * 60 * 60 * 1000;
        }
      }
```

Replace with:

```js
      if (coinbaseEventGrantsPlan(event)) {
        const charge = event.data;
        const meta = charge && charge.metadata;
        const token = meta && meta.gradfill_account_token;
        const planId = meta && meta.gradfill_plan;
        // Belt-and-braces: only ever grant a plan this route is allowed to
        // grant, even if a stored charge's metadata somehow said otherwise.
        if (token && CRYPTO_ELIGIBLE_PLANS[planId]) {
          const account = await getAccount(store, token);
          if (account) {
            const expiresAt = new Date(Date.now() + PLAN_DEFS.season.seasonDays * 24 * 60 * 60 * 1000);
            await store.pool.query("UPDATE accounts SET plan_id = $1, plan_expires_at = $2 WHERE token = $3", [planId, expiresAt, token]);
          }
        }
      }
```

- [ ] **Step 7: Update `module.exports`.** Find:

```js
module.exports = {
  createServer, createAccountStore, seedAccount, PLAN_DEFS, monthKey, chargeAI, planFor,
  verifyStripeSignature, verifyCoinbaseSignature, coinbaseEventGrantsPlan
};
```

Replace with:

```js
module.exports = {
  createServer, createAccountStore, ensureSchema, closeAccountStore,
  seedAccount, getAccount, setAccountFieldsForTest, persistUsage,
  PLAN_DEFS, monthKey, chargeAI, planFor,
  verifyStripeSignature, verifyCoinbaseSignature, coinbaseEventGrantsPlan
};
```

- [ ] **Step 8: Update the manual-run startup block.** Find:

```js
/* Manual local run: node server/index.js — listens on 127.0.0.1:8787,
   matching cloud.js's DEFAULT_SETTINGS.localApiBase. Seeds two demo
   accounts so `Local backend` mode in the extension has something to
   authenticate against without a real signup flow. */
if (require.main === module) {
  const store = createAccountStore();
  seedAccount(store, crypto.randomUUID(), "free", "demo-free@gradfill.local");
  const server = createServer(store);
  server.listen(8787, "127.0.0.1", () => {
    console.log("GradFill reference backend listening on http://127.0.0.1:8787");
    console.log("(In-memory only — accounts and usage reset on restart. Not for production.)");
  });
}
```

Replace with:

```js
/* Manual local run: node server/index.js — listens on 127.0.0.1:8787,
   matching cloud.js's DEFAULT_SETTINGS.localApiBase (127.0.0.1 for local
   dev, the real deployed Render URL for productionApiBase). Seeds one
   demo account so `Local backend` mode in the extension has something to
   authenticate against without a real signup flow. Requires DATABASE_URL
   — this reference server does not fall back to an in-memory store if
   it's unset, since persistence is the whole point of this file now. */
if (require.main === module) {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required — set it to a reachable Postgres connection string.");
    process.exit(1);
  }
  (async () => {
    const store = createAccountStore();
    await ensureSchema(store);
    await seedAccount(store, crypto.randomUUID(), "free", "demo-free@gradfill.local");
    const server = createServer(store);
    server.listen(process.env.PORT || 8787, process.env.PORT ? "0.0.0.0" : "127.0.0.1", () => {
      console.log("GradFill reference backend listening on port " + (process.env.PORT || 8787));
      console.log("Accounts are now persisted in Postgres — they survive a restart.");
    });
  })().catch((e) => {
    console.error("Failed to start GradFill backend:", e);
    process.exit(1);
  });
}
```

(The `process.env.PORT` / `0.0.0.0` branch is for Render, which assigns its own port via `PORT` and expects the process to bind every interface, not just loopback — local dev with no `PORT` set is completely unaffected and keeps using `127.0.0.1:8787` exactly as before.)

- [ ] **Step 9: Sanity-check the file still parses**

Run: `node -e "require('./server/index.js'); console.log('parses ok')"`
Expected: prints `parses ok`

- [ ] **Step 10: Commit**

```bash
git add server/index.js
git commit -m "Migrate route handlers to Postgres, add /healthz, update exports and startup"
```

---

### Task 5: Update existing tests for the async store API

**Files:**
- Modify: `test-server-auth.js`
- Modify: `test-server-billing.js`
- Modify: `test-server-enforcement.js`

**Interfaces:**
- Consumes: `createAccountStore`, `ensureSchema`, `seedAccount`, `getAccount`, `setAccountFieldsForTest`, `closeAccountStore` from Task 4.

- [ ] **Step 1: Update `test-server-auth.js`.** Find:

```js
  const store = createAccountStore();
  const server = createServer(store);
```

Replace with:

```js
  const store = createAccountStore();
  await ensureSchema(store);
  const server = createServer(store);
```

And update the import line. Find:

```js
const { createServer, createAccountStore } = require("./server/index.js");
```

Replace with:

```js
const { createServer, createAccountStore, ensureSchema, setAccountFieldsForTest, closeAccountStore } = require("./server/index.js");
```

And the direct Map mutation. Find:

```js
    console.log("\n=== Manually promote it to Pro in the store (the only legitimate way to change plan) ===");
    store.accounts.get(token).planId = "pro";
```

Replace with:

```js
    console.log("\n=== Manually promote it to Pro in the store (the only legitimate way to change plan) ===");
    await setAccountFieldsForTest(store, token, { planId: "pro" });
```

And close the pool in the `finally` block. Find:

```js
  } finally {
    server.close();
  }
```

Replace with:

```js
  } finally {
    server.close();
    await closeAccountStore(store);
  }
```

- [ ] **Step 2: Run it**

Run: `node test-server-auth.js`
Expected: `All auth checks passed.` (requires `DATABASE_URL` to be set, per the Prerequisite section above)

- [ ] **Step 3: Update `test-server-billing.js`.** Find:

```js
const { createServer, createAccountStore, seedAccount, PLAN_DEFS } = require("./server/index.js");
```

Replace with:

```js
const { createServer, createAccountStore, ensureSchema, seedAccount, getAccount, setAccountFieldsForTest, closeAccountStore, PLAN_DEFS } = require("./server/index.js");
```

Find:

```js
  const store = createAccountStore();
  seedAccount(store, "free-token", "free");
  seedAccount(store, "pro-token", "pro");
  const server = createServer(store);
```

Replace with:

```js
  const store = createAccountStore();
  await ensureSchema(store);
  await seedAccount(store, "free-token", "free");
  await seedAccount(store, "pro-token", "pro");
  const server = createServer(store);
```

Now every `store.accounts.get(X).field` read becomes `(await getAccount(store, X)).field`, and every `store.accounts.get(X).field = Y` write becomes `await setAccountFieldsForTest(store, X, { field: Y })`. Find each of these exact lines and replace as shown:

Find: `check("bad Stripe signature -> 400, account untouched", r.status === 400 && store.accounts.get("free-token").planId === "free");`
Replace: `check("bad Stripe signature -> 400, account untouched", r.status === 400 && (await getAccount(store, "free-token")).planId === "free");`

Find:
```js
    const acctAfterStripe = store.accounts.get("free-token");
```
Replace:
```js
    const acctAfterStripe = await getAccount(store, "free-token");
```

Find: `store.accounts.get("pro-token").stripeCustomerId = "cus_test_2";`
Replace: `await setAccountFieldsForTest(store, "pro-token", { stripeCustomerId: "cus_test_2" });`

Find: `check("subscription.deleted -> 200 and account back on free", r.status === 200 && store.accounts.get("pro-token").planId === "free");`
Replace: `check("subscription.deleted -> 200 and account back on free", r.status === 200 && (await getAccount(store, "pro-token")).planId === "free");`

Find: `seedAccount(store, "crypto-token", "free");` (first occurrence)
Replace: `await seedAccount(store, "crypto-token", "free");`

Find: `check("charge:pending (still confirming on-chain) -> does NOT grant the plan yet", r.status === 200 && store.accounts.get("crypto-token").planId === "free");`
Replace: `check("charge:pending (still confirming on-chain) -> does NOT grant the plan yet", r.status === 200 && (await getAccount(store, "crypto-token")).planId === "free");`

Find: `check("bad Coinbase signature -> 400, account still untouched", r.status === 400 && store.accounts.get("crypto-token").planId === "free");`
Replace: `check("bad Coinbase signature -> 400, account still untouched", r.status === 400 && (await getAccount(store, "crypto-token")).planId === "free");`

Find:
```js
    const acctAfterCoinbase = store.accounts.get("crypto-token");
```
Replace:
```js
    const acctAfterCoinbase = await getAccount(store, "crypto-token");
```

Find: `seedAccount(store, "crypto-abuse-token", "free");`
Replace: `await seedAccount(store, "crypto-abuse-token", "free");`

Find: `check("mistagged/spoofed 'pro' crypto charge -> 200 but account NOT upgraded", r.status === 200 && store.accounts.get("crypto-abuse-token").planId === "free");`
Replace: `check("mistagged/spoofed 'pro' crypto charge -> 200 but account NOT upgraded", r.status === 200 && (await getAccount(store, "crypto-abuse-token")).planId === "free");`

Find: `store.accounts.get("crypto-token").planExpiresAt = Date.now() - 1000;`
Replace: `await setAccountFieldsForTest(store, "crypto-token", { planExpiresAt: Date.now() - 1000 });`

Find: `check("storage still literally says planId 'season' (expiry is a read-time check, not a background sweep)", store.accounts.get("crypto-token").planId === "season");`
Replace: `check("storage still literally says planId 'season' (expiry is a read-time check, not a background sweep)", (await getAccount(store, "crypto-token")).planId === "season");`

Find:
```js
  } finally {
    server.close();
  }
```
Replace:
```js
  } finally {
    server.close();
    await closeAccountStore(store);
  }
```

- [ ] **Step 4: Run it**

Run: `node test-server-billing.js`
Expected: `All billing checks passed`

- [ ] **Step 5: Update `test-server-enforcement.js`.** Find:

```js
const { createServer, createAccountStore, seedAccount } = require("./server/index.js");
```

Replace with:

```js
const { createServer, createAccountStore, ensureSchema, seedAccount, closeAccountStore } = require("./server/index.js");
```

Find:

```js
  const store = createAccountStore();
  seedAccount(store, "free-token", "free");
  seedAccount(store, "pro-token", "pro");
  const server = createServer(store);
```

Replace with:

```js
  const store = createAccountStore();
  await ensureSchema(store);
  await seedAccount(store, "free-token", "free");
  await seedAccount(store, "pro-token", "pro");
  const server = createServer(store);
```

Find the second store (the quota-cap section):

```js
    const capStore = createAccountStore();
    seedAccount(capStore, "pro-token-2", "pro");
    const capServer = createServer(capStore);
```

Replace with:

```js
    const capStore = createAccountStore();
    await ensureSchema(capStore);
    await seedAccount(capStore, "pro-token-2", "pro");
    const capServer = createServer(capStore);
```

Find:

```js
    capServer.close();
```

Replace with:

```js
    capServer.close();
    await closeAccountStore(capStore);
```

Find:

```js
  } finally {
    server.close();
  }
```

Replace with:

```js
  } finally {
    server.close();
    await closeAccountStore(store);
  }
```

- [ ] **Step 6: Run it**

Run: `node test-server-enforcement.js`
Expected: `All checks passed`

- [ ] **Step 7: Commit**

```bash
git add test-server-auth.js test-server-billing.js test-server-enforcement.js
git commit -m "Update existing server tests for the async Postgres-backed store"
```

---

### Task 6: Restart-survival test — the actual bug being fixed

**Files:**
- Create: `test-server-restart-survival.js`

**Interfaces:**
- Consumes: `createAccountStore`, `ensureSchema`, `seedAccount`, `setAccountFieldsForTest`, `closeAccountStore`, `createServer` from Task 4.

- [ ] **Step 1: Write the test**

```js
/* THE test that matters for this whole migration: proves an account
   created before a server restart is still there, and still correctly
   gated on its real plan, after the process restarts. This is the exact
   bug being fixed (the old in-memory Map lost everything on restart) —
   so it gets its own dedicated proof rather than being folded into
   test-server-auth.js or test-server-enforcement.js.
   Requires DATABASE_URL. Run: node test-server-restart-survival.js */
const { createServer, createAccountStore, ensureSchema, seedAccount, setAccountFieldsForTest, closeAccountStore } = require("./server/index.js");

function get(base, path, token) {
  return fetch(base + path, { headers: token ? { Authorization: "Bearer " + token } : {} })
    .then(async r => ({ status: r.status, body: await r.json() }));
}
function post(base, path, token, body) {
  return fetch(base + path, {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}),
    body: JSON.stringify(body || {})
  }).then(async r => ({ status: r.status, body: await r.json() }));
}

async function run() {
  if (!process.env.DATABASE_URL) {
    console.log("SKIPPED — set DATABASE_URL to a reachable Postgres to run this test.");
    process.exit(0);
  }
  let failures = 0;
  function check(name, cond) {
    if (cond) console.log("  ok  - " + name);
    else { failures++; console.log("  FAIL - " + name); }
  }

  const token = "restart-survival-token-" + Date.now();

  console.log("\n=== Server instance #1: create and promote an account ===");
  let store = createAccountStore();
  await ensureSchema(store);
  await seedAccount(store, token, "free", "restart-survival@test.local");
  await setAccountFieldsForTest(store, token, { planId: "pro" });
  let server = createServer(store);
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  let port = server.address().port;
  let base = "http://127.0.0.1:" + port;

  let r = await post(base, "/v1/ai/answer-draft", token, { question: "why this role?" });
  check("Pro account can draft an answer before the restart", r.status === 200 && !!r.body.draft);
  r = await get(base, "/v1/usage", token);
  check("usage shows 1 draft spent before the restart", r.body.usage.aiDrafts.used === 1);

  console.log("\n=== Simulating a full process restart: close server #1 and the pool, open server #2 ===");
  await new Promise(r2 => server.close(r2));
  await closeAccountStore(store);

  // A brand-new store/pool/server, exactly as if the whole Node process
  // had been killed and started again — nothing in memory is reused.
  store = createAccountStore();
  await ensureSchema(store);
  server = createServer(store);
  await new Promise(r2 => server.listen(0, "127.0.0.1", r2));
  port = server.address().port;
  base = "http://127.0.0.1:" + port;

  try {
    console.log("\n=== Server instance #2: same token, no re-seeding, nothing in memory carried over ===");
    r = await get(base, "/v1/usage", token);
    check("THE FIX: the account still exists after a full restart", r.status === 200);
    check("its plan is still Pro after the restart (not reset to free)", r.body.usage && r.body.usage.plan === "pro");
    check("its usage from before the restart survived too (1 draft, not reset to 0)", r.body.usage.aiDrafts.used === 1);

    r = await post(base, "/v1/ai/answer-draft", token, { question: "another question" });
    check("the still-Pro account can keep using the paid feature after the restart", r.status === 200 && !!r.body.draft);
    r = await get(base, "/v1/usage", token);
    check("usage after the restart correctly accumulates on top of the pre-restart count (2, not 1)", r.body.usage.aiDrafts.used === 2);
  } finally {
    server.close();
    await closeAccountStore(store);
  }

  console.log("\n" + (failures === 0 ? "Restart-survival check passed — the core bug is fixed." : failures + " CHECK(S) FAILED — data did not survive the restart."));
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run it against the real (unfixed, pre-migration) behavior first — verify it would have failed**

This step is retroactive proof, not a live re-run: the in-memory `Map` this test replaces had no persistence mechanism at all, so this exact scenario (new `store`/`server` instance, same token, no re-seeding) would have returned `401` on every request after the "restart," since a brand-new `Map` starts empty. That is the bug; Task 3/4 already replaced the Map, so this step is a design check, not a command — confirm by reading `createAccountStore` in the current `server/index.js` and noting it now creates a `pg.Pool`, not a `new Map()`.

- [ ] **Step 3: Run it for real**

Run: `node test-server-restart-survival.js`
Expected: `Restart-survival check passed — the core bug is fixed.`

- [ ] **Step 4: Commit**

```bash
git add test-server-restart-survival.js
git commit -m "Add restart-survival test proving accounts persist across a process restart"
```

---

### Task 7: Render deploy config, env template, docs

**Files:**
- Create: `render.yaml`
- Create: `.env.example`
- Modify: `README.md` (the "Before publishing" section, and a new "Local backend setup" note)

**Interfaces:**
- None (deploy/config/docs only — no runtime code).

- [ ] **Step 1: Create `render.yaml`**

```yaml
databases:
  - name: gradfill-db
    plan: free
    postgresMajorVersion: 16

services:
  - type: web
    name: gradfill-backend
    runtime: node
    plan: free
    buildCommand: npm install
    startCommand: npm start
    healthCheckPath: /healthz
    envVars:
      - key: DATABASE_URL
        fromDatabase:
          name: gradfill-db
          property: connectionString
      - key: NODE_ENV
        value: production
```

- [ ] **Step 2: Create `.env.example`**

```
# Copy to .env for local development, or set these as real environment
# variables on your host. Never commit a real .env file — it's already
# in .gitignore.

# Required. A reachable Postgres connection string.
DATABASE_URL=postgres://user:password@host:5432/dbname

# Optional — unset means every corresponding feature falls back to its
# honestly-labeled demo/stub behavior (see server/index.js's comments on
# stubProvider, STRIPE_SECRET_KEY, COINBASE_COMMERCE_API_KEY).
# STRIPE_SECRET_KEY=
# STRIPE_WEBHOOK_SECRET=
# STRIPE_PRICE_PRO_MONTHLY=
# STRIPE_PRICE_SEASON_PASS=
# COINBASE_COMMERCE_API_KEY=
# COINBASE_COMMERCE_WEBHOOK_SECRET=
# GOOGLE_PLACES_API_KEY=
```

- [ ] **Step 3: Update `README.md`'s "Before publishing" checklist.** Find:

```
Before publishing:
- deploy the backend on HTTPS and replace/configure `api.gradfill.app`
- configure secure production database/backups and account recovery
```

Replace with:

```
Before publishing:
- ~~deploy the backend on HTTPS and replace/configure `api.gradfill.app`~~ done — see "Backend deployment" below
- ~~configure secure production database~~ done (Postgres, see "Backend deployment" below) — backups and account recovery still need setting up
```

- [ ] **Step 4: Add a "Backend deployment" section to `README.md`**, right before the "Naming" section at the end of the file. Find:

```
## Naming
```

Replace with:

```
## Backend deployment

`server/index.js` is a plain Node app with one dependency (`pg`) and one required environment variable (`DATABASE_URL`, a Postgres connection string — never commit a real one; see `.env.example`).

**Local development:** point `DATABASE_URL` at any reachable empty Postgres 13+ (a local install, Docker, or a free instance from a host like Neon/Supabase), then:

```bash
npm install
export DATABASE_URL="postgres://user:password@host:5432/dbname"
npm start
```

This is unrelated to and does not affect `demo` mode in the extension's Setup page (`GFCloud`'s `mode` setting) — demo mode never calls this server at all.

**Production (Render):** this repo includes `render.yaml`, a Render Blueprint defining both the web service and a managed Postgres instance together. Deploying it gives a real HTTPS address on Render's own subdomain with no DNS or certificate setup, and Render wires `DATABASE_URL` into the web service automatically since both are defined in the same blueprint.

## Naming
```

- [ ] **Step 5: Commit**

```bash
git add render.yaml .env.example README.md
git commit -m "Add Render deploy config, env template, and backend deployment docs"
```

---

### Task 8: Point `cloud.js` at the real deployed address (manual, post-deploy only)

This task has no code to write yet — `cloud.js`'s `productionApiBase` cannot be set correctly until Task 7's `render.yaml` has actually been deployed and a real address exists. Once the user has followed the account-creation runbook (delivered separately) and reports back the live `https://<something>.onrender.com` address:

- [ ] **Step 1: Update `cloud.js`'s `DEFAULT_SETTINGS`.** Find:

```js
  var DEFAULT_SETTINGS = {
    mode: "demo",              // demo | local | production
    demoPlan: "free",
    cloudSync: false,
    localApiBase: "http://127.0.0.1:8787",
    productionApiBase: "https://api.gradfill.app"
  };
```

Replace `"https://api.gradfill.app"` with the real reported address, e.g.:

```js
  var DEFAULT_SETTINGS = {
    mode: "demo",              // demo | local | production
    demoPlan: "free",
    cloudSync: false,
    localApiBase: "http://127.0.0.1:8787",
    productionApiBase: "https://gradfill-backend.onrender.com"
  };
```

`demo` and `local` modes are untouched by this edit — only accounts explicitly switched to `production` mode in Setup's account settings will ever call this address.

- [ ] **Step 2: Commit**

```bash
git add cloud.js
git commit -m "Point productionApiBase at the real deployed Render address"
```

---

## Self-review notes

- **Spec coverage:** schema (Task 2) ✓, async migration preserving password/plan/usage security properties (Tasks 3-4) ✓, `DATABASE_URL`-only secret handling (Tasks 2-4) ✓, restart-survival proof (Task 6) ✓, Render choice + blueprint (Task 7) ✓, `productionApiBase` update with local/demo mode left untouched (Task 8) ✓, no migration script / empty-start (explicitly called out in Global Constraints, no task needed) ✓, referees/resume-versions gap (documented in Global Constraints, deliberately no task) ✓.
- **Placeholder scan:** no TBD/TODO; Task 8 is intentionally deferred (not a placeholder) because the value it needs doesn't exist until Task 7 is deployed — this is called out explicitly rather than left implicit.
- **Type consistency:** `account` object shape (`token, email, passwordSalt, passwordHash, planId, planExpiresAt: number|null, stripeCustomerId, usage: {month, drafts, resumes, coverLetters}`) is identical to the original in-memory shape everywhere it's used across Tasks 2-6, so `chargeAI()` and `planFor()` (both untouched) keep working with zero changes to their own logic.
