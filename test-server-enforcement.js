/* Proves the AI paywall is enforced SERVER-SIDE, not just by cloud.js's
   client-side canUseAI() check. Every request here talks to the real
   server/index.js over a real HTTP socket on 127.0.0.1 (no jsdom, no
   mocked fetch) and deliberately bypasses cloud.js entirely — this
   simulates an attacker who reads the extension's source, copies the
   bearer token out of chrome.storage, and curls the API directly,
   skipping the UI check altogether.
   Run: node test-server-enforcement.js */
const assert = require("assert");
const { createServer, createAccountStore, ensureSchema, seedAccount, closeAccountStore } = require("./server/index.js");

function post(base, path, token, body) {
  return fetch(base + path, {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}),
    body: JSON.stringify(body || {})
  }).then(async r => ({ status: r.status, body: await r.json() }));
}
function get(base, path, token) {
  return fetch(base + path, { headers: token ? { Authorization: "Bearer " + token } : {} })
    .then(async r => ({ status: r.status, body: await r.json() }));
}

async function run() {
  let failures = 0;
  function check(name, cond) {
    if (cond) console.log("  ok  - " + name);
    else { failures++; console.log("  FAIL - " + name); }
  }

  const store = createAccountStore();
  await ensureSchema(store);
  await seedAccount(store, "free-token", "free");
  await seedAccount(store, "pro-token", "pro");
  const server = createServer(store);
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const base = "http://127.0.0.1:" + port;

  try {
    console.log("\n=== No token at all ===");
    let r = await post(base, "/v1/ai/resume-tailor", null, { profile: {}, role: {}, jobDescription: "x" });
    check("resume-tailor with no Authorization header -> 401", r.status === 401);

    console.log("\n=== Free-plan account, honest request (no spoofing attempted) ===");
    r = await post(base, "/v1/ai/resume-tailor", "free-token", { profile: {}, role: { title: "Grad" }, jobDescription: "x" });
    check("resume-tailor for a free account -> 402 paywall", r.status === 402 && r.body.code === "paywall");
    r = await post(base, "/v1/ai/answer-draft", "free-token", { question: "why this role?" });
    check("answer-draft for a free account -> 402 paywall", r.status === 402 && r.body.code === "paywall");
    r = await post(base, "/v1/ai/cover-letter", "free-token", { profile: {}, role: {}, jobDescription: "x" });
    check("cover-letter for a free account -> 402 paywall", r.status === 402 && r.body.code === "paywall");

    console.log("\n=== THE ACTUAL BYPASS ATTEMPT: free-plan token, but the request body claims Pro entitlement ===");
    console.log("    (this is what a request looks like if the extension's own canUseAI() check is skipped or patched out client-side)");
    r = await post(base, "/v1/ai/resume-tailor", "free-token", {
      profile: {}, role: { title: "Grad" }, jobDescription: "x",
      plan: "pro", planId: "pro", aiEnabled: true, entitlement: { aiEnabled: true, resumeTailorsPerMonth: 9999 }
    });
    check("spoofed plan/aiEnabled/entitlement fields in the body are IGNORED — still 402 paywall", r.status === 402 && r.body.code === "paywall");
    r = await post(base, "/v1/ai/cover-letter", "free-token", { profile: {}, role: {}, jobDescription: "x", plan: "pro", aiEnabled: true });
    check("same spoof attempt against cover-letter -> still 402 paywall", r.status === 402 && r.body.code === "paywall");
    r = await post(base, "/v1/ai/answer-draft", "free-token", { question: "why this role?", plan: "season", aiEnabled: true });
    check("same spoof attempt against answer-draft -> still 402 paywall", r.status === 402 && r.body.code === "paywall");

    console.log("\n=== Pro-plan account: genuinely entitled, requests succeed and are metered server-side ===");
    r = await post(base, "/v1/ai/resume-tailor", "pro-token", { profile: {}, role: { title: "Grad" }, jobDescription: "x" });
    check("resume-tailor for a real Pro account -> 200 with content", r.status === 200 && !!r.body.content);
    r = await get(base, "/v1/usage", "pro-token");
    check("server-side usage reflects the spend immediately (not client-reported)", r.body.usage.resumeTailors.used === 1);

    console.log("\n=== Pro-plan account, but body ALSO tries to inflate its own quota — server ignores that too ===");
    r = await post(base, "/v1/ai/cover-letter", "pro-token", { profile: {}, role: {}, jobDescription: "x", entitlement: { coverLettersPerMonth: 999999 } });
    check("cover-letter succeeds on real entitlement, not the inflated claim in the body", r.status === 200);
    r = await get(base, "/v1/usage", "pro-token");
    check("usage.coverLetters.limit is still the server's real 40, not the spoofed 999999", r.body.usage.coverLetters.limit === 40);

    console.log("\n=== Server-side quota still caps a genuinely entitled account (not just a paywall check) ===");
    const capStore = createAccountStore();
    await ensureSchema(capStore);
    await seedAccount(capStore, "pro-token-2", "pro");
    const capServer = createServer(capStore);
    await new Promise(r2 => capServer.listen(0, "127.0.0.1", r2));
    const capPort = capServer.address().port, capBase = "http://127.0.0.1:" + capPort;
    let last;
    for (let i = 0; i < 40; i++) last = await post(capBase, "/v1/ai/cover-letter", "pro-token-2", { profile: {}, role: {}, jobDescription: "x" });
    check("call #40 (the cap) still succeeds", last.status === 200);
    const over = await post(capBase, "/v1/ai/cover-letter", "pro-token-2", { profile: {}, role: {}, jobDescription: "x" });
    check("call #41 in the same month -> 402 quota (server enforces the cap, not just entitlement)", over.status === 402 && over.body.code === "quota");
    capServer.close();
    await closeAccountStore(capStore);

    console.log("\n=== Invalid/unknown token is rejected, not silently treated as free or trusted ===");
    r = await post(base, "/v1/ai/resume-tailor", "totally-made-up-token", { profile: {}, role: {}, jobDescription: "x" });
    check("unknown bearer token -> 401, never falls through to any plan", r.status === 401);

  } finally {
    server.close();
    await closeAccountStore(store);
  }

  console.log("\n" + (failures ? failures + " FAILURE(S)" : "All checks passed") + "\n");
  process.exit(failures ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
