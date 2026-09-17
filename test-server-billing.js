/* Proves the new billing routes (Stripe + Coinbase Commerce, added on top
   of the previously-missing /v1/billing/* endpoints) are genuinely wired
   end-to-end SERVER-SIDE, the same rigor standard as
   test-server-enforcement.js for the AI paywall: real HTTP requests
   against a real server/index.js instance, real webhook signatures
   computed the way Stripe/Coinbase actually compute them, no mocking.

   STRIPE_SECRET_KEY and COINBASE_COMMERCE_API_KEY are deliberately left
   unset for this run -- that's the honest default state of this
   reference server (no live payment processor account exists here), and
   is itself one of the things this file proves: checkout requests
   degrade to a clearly-marked demo response instead of either crashing
   or fabricating a fake-but-convincing checkout URL.

   Webhook secrets ARE set below, because signature verification is real
   logic this file can and should prove without needing a live account on
   either side -- Stripe/Coinbase send that signature, we only need to
   verify it the same way they compute it.

   Run: node test-server-billing.js */
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_only";
process.env.COINBASE_COMMERCE_WEBHOOK_SECRET = "coinbase_test_only";

const assert = require("assert");
const crypto = require("crypto");
const { createServer, createAccountStore, ensureSchema, seedAccount, getAccount, setAccountFieldsForTest, closeAccountStore, PLAN_DEFS } = require("./server/index.js");

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
function postRaw(base, path, rawBody, headers) {
  return fetch(base + path, { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, headers || {}), body: rawBody })
    .then(async r => ({ status: r.status, body: await r.json() }));
}
// Stripe's own scheme: "t=<unix ts>,v1=<hex hmac256 of '<ts>.<raw body>'>".
function stripeSign(rawBody, secret, ts) {
  ts = ts || Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", secret).update(ts + "." + rawBody).digest("hex");
  return "t=" + ts + ",v1=" + sig;
}
// Coinbase's own scheme: plain hex hmac256 of the raw body, no timestamp.
function coinbaseSign(rawBody, secret) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
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
    console.log("\n=== Checkout / portal / crypto-checkout require auth ===");
    let r = await post(base, "/v1/billing/checkout", null, { plan: "pro" });
    check("checkout with no token -> 401", r.status === 401);
    r = await post(base, "/v1/billing/portal", null, {});
    check("portal with no token -> 401", r.status === 401);
    r = await post(base, "/v1/billing/crypto/checkout", null, { plan: "season" });
    check("crypto checkout with no token -> 401", r.status === 401);

    console.log("\n=== No live processor configured (this repo's honest default) ===");
    r = await post(base, "/v1/billing/checkout", "free-token", { plan: "pro" });
    check("Stripe checkout -> 200 demo:true, no fabricated url", r.status === 200 && r.body.demo === true && r.body.url === null);
    r = await post(base, "/v1/billing/portal", "free-token", {});
    check("Stripe portal -> 200 demo:true, no fabricated url", r.status === 200 && r.body.demo === true && r.body.url === null);
    r = await post(base, "/v1/billing/crypto/checkout", "free-token", { plan: "season" });
    check("Coinbase checkout -> 200 demo:true, no fabricated url", r.status === 200 && r.body.demo === true && r.body.url === null);

    console.log("\n=== Crypto is Season-Pass-only, enforced server-side ===");
    r = await post(base, "/v1/billing/crypto/checkout", "free-token", { plan: "pro" });
    check("crypto checkout for 'pro' -> 400, not silently downgraded to season", r.status === 400 && /Season Pass only/.test(r.body.error));

    console.log("\n=== Stripe webhook: signature verification is real, not decorative ===");
    const stripeBody = JSON.stringify({
      type: "checkout.session.completed",
      data: { object: { customer: "cus_test_1", metadata: { gradfill_account_token: "free-token", gradfill_plan: "season" } } }
    });
    r = await postRaw(base, "/v1/billing/webhook", stripeBody, { "stripe-signature": "t=1,v1=deadbeef" });
    check("bad Stripe signature -> 400, account untouched", r.status === 400 && (await getAccount(store, "free-token")).planId === "free");
    r = await postRaw(base, "/v1/billing/webhook", stripeBody, { "stripe-signature": stripeSign(stripeBody, "whsec_test_only") });
    check("valid Stripe signature -> 200", r.status === 200);
    const acctAfterStripe = await getAccount(store, "free-token");
    check("checkout.session.completed grants the plan from webhook metadata", acctAfterStripe.planId === "season");
    check("checkout.session.completed records the Stripe customer id", acctAfterStripe.stripeCustomerId === "cus_test_1");
    check("season pass gets a real ~90-day expiry, not indefinite", acctAfterStripe.planExpiresAt > Date.now() + 89 * 24 * 60 * 60 * 1000 && acctAfterStripe.planExpiresAt <= Date.now() + 90 * 24 * 60 * 60 * 1000);

    console.log("\n=== Stripe subscription cancellation downgrades, not just non-renewal ===");
    await setAccountFieldsForTest(store, "pro-token", { stripeCustomerId: "cus_test_2" });
    const cancelBody = JSON.stringify({ type: "customer.subscription.deleted", data: { object: { customer: "cus_test_2" } } });
    r = await postRaw(base, "/v1/billing/webhook", cancelBody, { "stripe-signature": stripeSign(cancelBody, "whsec_test_only") });
    check("subscription.deleted -> 200 and account back on free", r.status === 200 && (await getAccount(store, "pro-token")).planId === "free");

    console.log("\n=== Coinbase webhook: signature verification, and payment status gating ===");
    await seedAccount(store, "crypto-token", "free");
    const pendingBody = JSON.stringify({ event: { type: "charge:pending", data: { metadata: { gradfill_account_token: "crypto-token", gradfill_plan: "season" } } } });
    r = await postRaw(base, "/v1/billing/crypto/webhook", pendingBody, { "x-cc-webhook-signature": coinbaseSign(pendingBody, "coinbase_test_only") });
    check("charge:pending (still confirming on-chain) -> does NOT grant the plan yet", r.status === 200 && (await getAccount(store, "crypto-token")).planId === "free");

    const confirmedBody = JSON.stringify({ event: { type: "charge:confirmed", data: { metadata: { gradfill_account_token: "crypto-token", gradfill_plan: "season" } } } });
    r = await postRaw(base, "/v1/billing/crypto/webhook", confirmedBody, { "x-cc-webhook-signature": "0000" });
    check("bad Coinbase signature -> 400, account still untouched", r.status === 400 && (await getAccount(store, "crypto-token")).planId === "free");
    r = await postRaw(base, "/v1/billing/crypto/webhook", confirmedBody, { "x-cc-webhook-signature": coinbaseSign(confirmedBody, "coinbase_test_only") });
    const acctAfterCoinbase = await getAccount(store, "crypto-token");
    check("charge:confirmed with valid signature -> plan granted", r.status === 200 && acctAfterCoinbase.planId === "season");
    check("crypto-funded season pass also gets a real expiry", acctAfterCoinbase.planExpiresAt > Date.now());

    console.log("\n=== A charge somehow metadata-tagged 'pro' still can't buy Pro via crypto ===");
    await seedAccount(store, "crypto-abuse-token", "free");
    const abuseBody = JSON.stringify({ event: { type: "charge:confirmed", data: { metadata: { gradfill_account_token: "crypto-abuse-token", gradfill_plan: "pro" } } } });
    r = await postRaw(base, "/v1/billing/crypto/webhook", abuseBody, { "x-cc-webhook-signature": coinbaseSign(abuseBody, "coinbase_test_only") });
    check("mistagged/spoofed 'pro' crypto charge -> 200 but account NOT upgraded", r.status === 200 && (await getAccount(store, "crypto-abuse-token")).planId === "free");

    console.log("\n=== Expired Season Pass falls back to free, whichever path funded it ===");
    await setAccountFieldsForTest(store, "crypto-token", { planExpiresAt: Date.now() - 1000 });
    r = await get(base, "/v1/usage", "crypto-token");
    check("usage reflects free once the season pass has expired", r.status === 200 && r.body.usage.plan === "free");
    check("storage still literally says planId 'season' (expiry is a read-time check, not a background sweep)", (await getAccount(store, "crypto-token")).planId === "season");

  } finally {
    server.close();
    await closeAccountStore(store);
  }

  console.log("\n" + (failures === 0 ? "All billing checks passed" : failures + " CHECK(S) FAILED"));
  process.exit(failures === 0 ? 0 : 1);
}

run();
