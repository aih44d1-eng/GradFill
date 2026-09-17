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
