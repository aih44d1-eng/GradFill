/* Proves the register -> login -> AI-gate path works end to end against
   the real server/index.js over a real HTTP socket (no mocked fetch), the
   same way test-server-enforcement.js exercises the AI routes directly.
   Run: node test-server-auth.js */
const assert = require("assert");
const { createServer, createAccountStore } = require("./server/index.js");

function post(base, path, token, body) {
  return fetch(base + path, {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}),
    body: JSON.stringify(body || {})
  }).then(async r => ({ status: r.status, body: await r.json() }));
}

async function run() {
  let failures = 0;
  function check(name, cond) {
    if (cond) console.log("  ok  - " + name);
    else { failures++; console.log("  FAIL - " + name); }
  }

  const store = createAccountStore();
  const server = createServer(store);
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const base = "http://127.0.0.1:" + port;
  const email = "grad-" + Date.now() + "@test.local";
  const password = "correct horse battery staple";

  try {
    console.log("\n=== Register a brand-new account ===");
    let r = await post(base, "/v1/auth/register", null, { email, password });
    check("register -> 200", r.status === 200);
    check("register returns a bearer token", typeof r.body.account?.token === "string" && r.body.account.token.length > 0);
    check("register returns the email back", r.body.account?.email === email);
    check("new account lands on the free plan", r.body.account?.plan?.id === "free");
    const token = r.body.account.token;

    r = await post(base, "/v1/auth/register", null, { email, password });
    check("registering the same email twice -> 409 conflict", r.status === 409);

    console.log("\n=== Log in with the credentials just registered ===");
    r = await post(base, "/v1/auth/login", null, { email, password });
    check("login -> 200", r.status === 200);
    check("login returns the SAME token as registration", r.body.account?.token === token);

    r = await post(base, "/v1/auth/login", null, { email, password: "wrong password entirely" });
    check("login with wrong password -> 401", r.status === 401);
    r = await post(base, "/v1/auth/login", null, { email: "nobody@test.local", password });
    check("login for an unknown email -> 401", r.status === 401);

    console.log("\n=== Fresh free-plan account is paywalled on AI, same as any other free account ===");
    r = await post(base, "/v1/ai/answer-draft", token, { question: "why this role?" });
    check("answer-draft for the freshly-registered account -> 402 paywall", r.status === 402 && r.body.code === "paywall");

    console.log("\n=== Manually promote it to Pro in the store (the only legitimate way to change plan) ===");
    store.accounts.get(token).planId = "pro";
    r = await post(base, "/v1/ai/answer-draft", token, { question: "why this role?" });
    check("same token, same call, now succeeds once the store says Pro -> 200 with content", r.status === 200 && !!r.body.draft);
  } finally {
    server.close();
  }

  console.log("\n" + (failures === 0 ? "All auth checks passed." : failures + " auth check(s) FAILED."));
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(e => { console.error(e); process.exit(1); });
