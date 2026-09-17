/* Node/vm test harness for cloud.js's free/paid gating and billing model.
   Run: node test-billing.js
   No browser needed — cloud.js only touches chrome.storage.local (stubbed
   here as an in-memory map) and window (stubbed as the vm sandbox global). */
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

function makeChrome() {
  const store = {};
  return {
    __store: store,
    storage: {
      local: {
        async get(keys) {
          if (typeof keys === "string") return { [keys]: store[keys] };
          const out = {};
          (Array.isArray(keys) ? keys : Object.keys(store)).forEach(k => { out[k] = store[k]; });
          return out;
        },
        async set(obj) { Object.assign(store, obj); }
      }
    },
    tabs: { create() {} },
    runtime: { getManifest: () => ({ version: "test" }) }
  };
}

function loadCloud(chromeStub) {
  const code = fs.readFileSync(__dirname + "/cloud.js", "utf8");
  const sandbox = { chrome: chromeStub, console, fetch: async () => { throw new Error("network disabled in test"); } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "cloud.js" });
  return sandbox.window.GFCloud;
}

async function run() {
  let failures = 0;
  function check(name, cond) {
    if (cond) { console.log("  ok  - " + name); }
    else { failures++; console.log("  FAIL - " + name); }
  }

  console.log("\n=== Billing model: no weekly billing anywhere ===");
  const chrome1 = makeChrome();
  const GF1 = loadCloud(chrome1);
  const proDef = GF1.PLAN_DEFS.pro, seasonDef = GF1.PLAN_DEFS.season, freeDef = GF1.PLAN_DEFS.free;
  check("pro price string contains no '/week'", !/\/week/i.test(proDef.price));
  check("pro billingPeriod is 'month'", proDef.billingPeriod === "month");
  check("season billingPeriod is 'season' (one-off pass, not recurring weekly)", seasonDef.billingPeriod === "season");
  check("free plan has zero AI entitlement (aiEnabled=false)", freeDef.aiEnabled === false);
  check("free plan AI caps are all 0", freeDef.aiDraftsPerMonth === 0 && freeDef.resumeTailorsPerMonth === 0 && freeDef.coverLettersPerMonth === 0);
  check("pro plan is within the PDF's $15-25/mo recommended band (A$20/month, the midpoint)", /A\$20\/month/.test(proDef.price));
  check("season pass equals A$15/month (the floor of the $15-25 band) over 90 days", /A\$45/.test(seasonDef.price) && seasonDef.seasonDays === 90);

  console.log("\n=== Free demo plan: autofill/tracker never touch this file; AI is fully blocked ===");
  const chrome2 = makeChrome();
  chrome2.storage.local.set({ gfSettings: { mode: "demo", demoPlan: "free" } });
  const GF2 = loadCloud(chrome2);
  const gate = await GF2.canUseAI();
  check("canUseAI() is false on free demo plan", gate.allowed === false);
  let threw = null;
  try { await GF2.aiResumeTailor({ profile: {}, role: {}, jobDescription: "x" }); } catch (e) { threw = e; }
  check("aiResumeTailor throws with code 'paywall' on free plan (never silently degrades)", threw && threw.code === "paywall");
  threw = null;
  try { await GF2.aiAnswerDraft({ question: "why?" }); } catch (e) { threw = e; }
  check("aiAnswerDraft throws with code 'paywall' on free plan", threw && threw.code === "paywall");
  threw = null;
  try { await GF2.aiCoverLetter({ profile: {}, role: {}, jobDescription: "x" }); } catch (e) { threw = e; }
  check("aiCoverLetter throws with code 'paywall' on free plan", threw && threw.code === "paywall");
  check("reserveApplication / application-quota concept is gone (Fill and Mark Applied are never metered)", GF2.reserveApplication === undefined);

  console.log("\n=== Pro demo plan: all three AI features work, metered monthly ===");
  const chrome3 = makeChrome();
  chrome3.storage.local.set({ gfSettings: { mode: "demo", demoPlan: "pro" } });
  const GF3 = loadCloud(chrome3);
  const resumeRes = await GF3.aiResumeTailor({ profile: { personal: { firstName: "Aiha" }, education: [{ degree: "Bachelor of Cybersecurity", major: "Cybersecurity", institution: "UTS" }], experience: [], skills: ["Python"] }, role: { title: "Cyber Grad", company: "TestCo" }, jobDescription: "python cybersecurity analyst role" });
  check("aiResumeTailor returns demo content on pro plan", !!resumeRes.content && resumeRes.demo === true);
  const draftRes = await GF3.aiAnswerDraft({ question: "Why this role?", profile: { personal: {}, education: [], experience: [], starBank: [] }, role: { title: "Cyber Grad" } });
  check("aiAnswerDraft returns demo draft on pro plan", !!draftRes.draft && draftRes.demo === true);
  const coverRes = await GF3.aiCoverLetter({ profile: { personal: { firstName: "Aiha" }, education: [], experience: [], skills: ["Python", "SIEM"], starBank: [{ action: "led a triage", result: "cut MTTR 30%" }] }, role: { title: "Cyber Grad", company: "TestCo" }, jobDescription: "python cybersecurity analyst role" });
  check("aiCoverLetter returns demo content on pro plan", !!coverRes.content && coverRes.demo === true);
  check("cover letter opens with a salutation (genuinely generative document, not a field value)", /^Dear/.test(coverRes.content));

  const usage = await GF3.usage();
  check("usage() has no 'applications' key at all (nothing to meter there anymore)", usage.applications === undefined);
  check("usage() reports monthly period for AI drafts", usage.aiDrafts.period === "month");
  check("usage tracked 1 resume tailor, 1 AI draft, 1 cover letter after the three calls above", usage.resumeTailors.used === 1 && usage.aiDrafts.used === 1 && usage.coverLetters.used === 1);

  console.log("\n=== Season pass demo plan: same entitlement shape as Pro, sold as a one-off pass ===");
  const chrome4 = makeChrome();
  chrome4.storage.local.set({ gfSettings: { mode: "demo", demoPlan: "season" } });
  const GF4 = loadCloud(chrome4);
  const seasonGate = await GF4.canUseAI();
  check("canUseAI() is true on season plan", seasonGate.allowed === true);
  const seasonResume = await GF4.aiResumeTailor({ profile: { personal: {}, education: [], experience: [], skills: [] }, role: {}, jobDescription: "x" });
  check("aiResumeTailor works on season plan", !!seasonResume.content);

  console.log("\n=== Monthly quota actually caps out (proves metering isn't decorative) ===");
  const chrome5 = makeChrome();
  chrome5.storage.local.set({ gfSettings: { mode: "demo", demoPlan: "pro" } });
  const GF5 = loadCloud(chrome5);
  const cap = GF5.PLAN_DEFS.pro.coverLettersPerMonth;
  for (let i = 0; i < cap; i++) await GF5.aiCoverLetter({ profile: { personal: {}, education: [], experience: [], skills: [] }, role: {}, jobDescription: "x" });
  let quotaErr = null;
  try { await GF5.aiCoverLetter({ profile: { personal: {}, education: [], experience: [], skills: [] }, role: {}, jobDescription: "x" }); } catch (e) { quotaErr = e; }
  check("cover letter #" + (cap + 1) + " in the same month is rejected with code 'quota'", quotaErr && quotaErr.code === "quota");
  check("quota message says 'Monthly' not 'Weekly'", quotaErr && /monthly/i.test(quotaErr.message));

  console.log("\n=== Checkout billing period passed through, never implicitly weekly ===");
  const chrome6 = makeChrome();
  chrome6.storage.local.set({ gfSettings: { mode: "production" }, gfAccount: { token: "t" } });
  chrome6.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    check("checkout('season') POSTs plan=season to /v1/billing/checkout", url.endsWith("/v1/billing/checkout") && body.plan === "season");
    return { ok: true, json: async () => ({ url: "https://billing.example/session" }) };
  };
  const code6 = fs.readFileSync(__dirname + "/cloud.js", "utf8");
  const sandbox6 = { chrome: chrome6, console, fetch: chrome6.fetch };
  sandbox6.window = sandbox6;
  vm.createContext(sandbox6);
  vm.runInContext(code6, sandbox6, { filename: "cloud.js" });
  await sandbox6.window.GFCloud.checkout("season");

  console.log("\n" + (failures ? failures + " FAILURE(S)" : "All checks passed") + "\n");
  process.exit(failures ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
