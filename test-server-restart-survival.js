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

  // Both token AND email need to be unique per run against a real,
  // persistent database -- a fixed email collides with the previous
  // run's leftover row (accounts.email has a UNIQUE constraint) even
  // though the token itself is already unique per run.
  const runId = Date.now();
  const token = "restart-survival-token-" + runId;

  console.log("\n=== Server instance #1: create and promote an account ===");
  let store = createAccountStore();
  await ensureSchema(store);
  await seedAccount(store, token, "free", "restart-survival-" + runId + "@test.local");
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
