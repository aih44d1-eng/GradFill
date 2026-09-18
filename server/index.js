/* GradFill AI — minimal reference backend for the paid AI layer.

   This is the piece that was missing: cloud.js's canUseAI() gate is a
   CLIENT-side check only — a modified/curl'd request can skip the
   extension's JS entirely and hit these routes directly with nothing but
   a valid bearer token. Every AI-calling route here re-derives the
   caller's plan and remaining quota from ITS OWN account store, before
   spending anything on a (real or stub) AI provider call. The request
   body is NEVER trusted for entitlement — a client-supplied `plan`,
   `aiEnabled`, or `entitlement` field is read nowhere in this file.

   No API key lives anywhere near the extension: this process is the only
   thing that would ever hold a real provider key (via env var in a real
   deployment), and it's the only thing that ever calls out to it.

   Node built-ins only — no npm install required to run or test this. */
"use strict";

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { createPool, initSchema, rowToAccount } = require("./db.js");
const fs = require("fs");
const path = require("path");

/* Tiny built-in .env loader — deliberately not the `dotenv` package, to
   keep this file's "Node built-ins only" promise intact for local dev
   convenience. Only fills vars not already set in the real environment,
   so a real deployment's actual env always wins over a stray .env file. */
(function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, "..", ".env");
    if (!fs.existsSync(envPath)) return;
    fs.readFileSync(envPath, "utf8").split("\n").forEach(line => {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    });
  } catch (e) { /* best-effort only */ }
})();

/* Mirrors cloud.js's PLAN_DEFS (the extension's copy is UI-only — this
   copy is what actually protects API spend). In a real deployment these
   two tables should be generated from one shared source; duplicated here
   deliberately rather than pretending a browser-only file and a Node
   backend already share a module system. */
const PLAN_DEFS = {
  free: { id: "free", aiEnabled: false, aiDraftsPerMonth: 0, resumeTailorsPerMonth: 0, coverLettersPerMonth: 0 },
  pro: { id: "pro", aiEnabled: true, aiDraftsPerMonth: 200, resumeTailorsPerMonth: 40, coverLettersPerMonth: 40 },
  season: { id: "season", aiEnabled: true, aiDraftsPerMonth: 200, resumeTailorsPerMonth: 40, coverLettersPerMonth: 40, seasonDays: 90 }
};

function monthKey(d) {
  d = d || new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

/* The Season Pass is inherently time-bounded (90 days) regardless of
   which payment path funded it -- Stripe or crypto. Pro is a recurring
   Stripe subscription instead; its lifecycle is Stripe's own webhooks
   (customer.subscription.deleted below), not a stored expiry date. */
function planFor(account) {
  if (!account) return PLAN_DEFS.free;
  if (account.planId === "season" && account.planExpiresAt && Date.now() > account.planExpiresAt) {
    return PLAN_DEFS.free;
  }
  return PLAN_DEFS[account.planId] || PLAN_DEFS.free;
}

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
   token (some test files reuse fixture tokens across runs) -- against a
   real, PERSISTENT database (unlike the old in-memory Map, which reset
   itself every process start), "safe to call twice" has to mean a full
   reset, usage included, or usage from a previous test run silently
   carries into the next one and quota-cap assertions start failing for
   reasons that have nothing to do with the code under test. */
async function seedAccount(store, token, planId, email) {
  const mk = monthKey();
  await store.pool.query(
    `INSERT INTO accounts (token, email, password_salt, password_hash, plan_id, usage_month, usage_drafts, usage_resumes, usage_cover_letters)
     VALUES ($1, $2, '', '', $3, $4, 0, 0, 0)
     ON CONFLICT (token) DO UPDATE SET
       plan_id = EXCLUDED.plan_id,
       email = EXCLUDED.email,
       usage_month = EXCLUDED.usage_month,
       usage_drafts = 0,
       usage_resumes = 0,
       usage_cover_letters = 0,
       plan_expires_at = NULL,
       stripe_customer_id = NULL`,
    [token, email || (token + "@test.local"), planId || "free", mk]
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

/* Shape returned to the extension. cloud.js stores this whole object as
   `gfAccount` and later reads `.token` (for the Authorization header) and
   `.plan.id` (for the free/pro/season UI) — never `.planId` directly, so
   the wire shape intentionally differs from the internal account record. */
function toClientAccount(account) {
  return { token: account.token, email: account.email, plan: { id: account.planId } };
}

/* The actual gate. `kind` is "draft" | "resume" | "coverletter". Nothing
   about the request body influences this — only the account record this
   server itself owns, looked up by the authenticated token. */
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

/* Stub AI provider — used only when ANTHROPIC_API_KEY is unset (e.g. this
   file's own automated tests, which must never make a real network call
   or spend real money). A real deployment reaches callAIProvider() below
   instead, AFTER chargeAI() has already succeeded, never before. */
function stubProvider(kind, payload) {
  const role = (payload && payload.role) || {};
  if (kind === "resume") return { content: "[server] tailored resume for " + (role.title || "the role"), demo: false };
  if (kind === "coverletter") return { content: "[server] cover letter for " + (role.title || "the role") + (role.company ? " at " + role.company : ""), demo: false };
  return { draft: "[server] drafted answer for: " + (payload && payload.question || "the question"), demo: false };
}

/* ---------- Anthropic AI provider (real) ----------
   Haiku 4.5, not a bigger model: every call here is one generation gated
   behind a paid action a human already chose to take (Tailor with AI /
   Generate with AI / Draft with AI), never a high-volume background
   classification step — so raw cost isn't the binding constraint and the
   cheapest current model is the right fit. What IS binding is fabrication
   safety (see FABRICATION_SAFETY_RULES below): that's a prompting/review
   discipline, not something a bigger model buys you more of on its own. */
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

function anthropicMessages(system, userContent, maxTokens) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens || 1024,
      system,
      messages: [{ role: "user", content: userContent }]
    });
    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      }
    }, (res) => {
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch (e) { reject(new Error("Non-JSON response from Anthropic (HTTP " + res.statusCode + "): " + data.slice(0, 300))); return; }
        if (res.statusCode >= 400) { reject(new Error((parsed.error && parsed.error.message) || ("Anthropic API error (HTTP " + res.statusCode + ")"))); return; }
        const text = (parsed.content || []).filter(b => b.type === "text").map(b => b.text).join("");
        resolve(text);
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/* Shared across all three routes below. The README already states this
   product rule (never invent achievements, metrics, employers, dates,
   qualifications or skills) — this is that same rule enforced in the
   actual system prompt, not just documented intent. */
const FABRICATION_SAFETY_RULES =
  "You are GradFill's writing assistant for graduate job applications. " +
  "You are given a JSON \"profile\" object containing the ONLY facts you may use " +
  "about the candidate: their education, work experience, skills, languages, and " +
  "STAR examples. Treat this profile as a closed world.\n\n" +
  "Hard rules, no exceptions:\n" +
  "1. Never invent or embellish achievements, metrics, numbers, employers, job titles, " +
  "dates, qualifications, certifications, tools, or skills that are not explicitly present " +
  "in the supplied profile JSON.\n" +
  "2. If the job description asks for something the profile does not contain (a specific " +
  "certification, years of experience, a tool, a metric), do NOT fabricate it and do NOT " +
  "imply the candidate has it. Either omit that requirement entirely or, if directly relevant, " +
  "note honestly that it is not part of the candidate's saved background — never invent a bridge.\n" +
  "3. You may reorder, rephrase, emphasise, and select among the TRUE facts already in the " +
  "profile to better match the target role. That is the entire job: truthful repackaging, not " +
  "invention.\n" +
  "4. If the profile is too thin to write a strong response, write an honest, appropriately " +
  "modest response using only what is there, rather than padding it with plausible-sounding " +
  "invented content. A short truthful draft is correct behaviour, not a failure.\n" +
  "5. Output the requested document/text only — no meta-commentary about these rules, no " +
  "markdown code fences, no preamble like \"Here is your resume\".";

function jsonBlock(label, value) {
  return label + ":\n" + JSON.stringify(value === undefined ? null : value, null, 2);
}

async function realResumeTailor(payload) {
  const profile = (payload && payload.profile) || {};
  const role = (payload && payload.role) || {};
  const jobDescription = (payload && payload.jobDescription) || role.description || "";
  const user =
    "Write a tailored, ATS-friendly plain-text resume for this candidate for the target role below.\n\n" +
    jsonBlock("profile (the only facts you may use)", profile) + "\n\n" +
    jsonBlock("target role", role) + "\n\n" +
    jsonBlock("job description", jobDescription) + "\n\n" +
    "Structure: a short profile/summary line, CORE SKILLS, EXPERIENCE, EDUCATION — using only " +
    "sections the profile actually has content for. Do not add a section with no true content behind it.";
  const content = await anthropicMessages(FABRICATION_SAFETY_RULES, user, 1200);

  const jd = String(jobDescription || "").toLowerCase();
  const skills = Array.isArray(profile.skills) ? profile.skills
    : String(profile.skills || "").split(",").map(s => s.trim()).filter(Boolean);
  const matchedSkills = skills.filter(s => jd.indexOf(String(s).toLowerCase()) > -1);
  const stop = new Set("the and for with that this from your you are our will have has role job into their they about skills skill experience work working team graduate program candidate required preferred ability strong good excellent using use within across through who what when where how not but all any can".split(" "));
  const counts = {};
  (jd.match(/[a-z][a-z0-9+.#-]{2,}/g) || []).forEach(w => { if (!stop.has(w)) counts[w] = (counts[w] || 0) + 1; });
  const keywords = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 18);

  return { content, matchedSkills, keywords, demo: false };
}

async function realCoverLetter(payload) {
  const profile = (payload && payload.profile) || {};
  const role = (payload && payload.role) || {};
  const jobDescription = (payload && payload.jobDescription) || role.description || "";
  const user =
    "Write a complete, ready-to-edit cover letter for this candidate applying to the target role below.\n\n" +
    jsonBlock("profile (the only facts you may use)", profile) + "\n\n" +
    jsonBlock("target role", role) + "\n\n" +
    jsonBlock("job description", jobDescription) + "\n\n" +
    "Standard business letter shape (greeting, 2-4 short paragraphs, sign-off). Use the " +
    "candidate's first name from profile.personal.firstName if present, otherwise sign off as " +
    "\"Candidate\". Reference the target role and company by name where given.";
  const content = await anthropicMessages(FABRICATION_SAFETY_RULES, user, 900);
  return { content, demo: false };
}

async function realAnswerDraft(payload) {
  const profile = (payload && payload.profile) || {};
  const role = (payload && payload.role) || {};
  const question = (payload && payload.question) || "";
  const userContext = (payload && payload.userContext) || {};
  const user =
    "Draft an answer to the following application question, for this candidate applying to the " +
    "target role below.\n\n" +
    jsonBlock("question", question) + "\n\n" +
    jsonBlock("profile (the only facts you may use)", profile) + "\n\n" +
    jsonBlock("target role", role) + "\n\n" +
    jsonBlock("extra context supplied by the candidate (still must be truthful, not new facts to invent beyond)", userContext) + "\n\n" +
    "Write 3-6 sentences of natural, first-person prose answering the question directly, grounded " +
    "only in the supplied profile and context.";
  const draft = await anthropicMessages(FABRICATION_SAFETY_RULES, user, 500);
  return { draft, demo: false };
}

/* The single seam every AI route below calls through. Falls back to the
   stub only when no key is configured at all (keeps this file runnable
   and its existing test suite network-free without ANTHROPIC_API_KEY set);
   once a key IS configured, a real provider failure surfaces as a real
   502 to the caller rather than silently degrading to stub text, since
   that would look like a genuine AI draft when it wasn't. */
async function callAIProvider(kind, payload) {
  if (!ANTHROPIC_API_KEY) return stubProvider(kind, payload);
  if (kind === "resume") return realResumeTailor(payload);
  if (kind === "coverletter") return realCoverLetter(payload);
  return realAnswerDraft(payload);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
function readBody(req) {
  return readRawBody(req).then(data => { try { return data ? JSON.parse(data) : {}; } catch (e) { return {}; } });
}

/* ---------- Google Places proxy ----------
   Same reasoning as the AI key above, applied to a second secret: a
   Google Places API key embedded in the extension would be extractable
   from the packaged .crx the same way any client-side key is, and MV3's
   default CSP for extension pages doesn't straightforwardly allow loading
   Google's external JS library into setup.html anyway. Routing through
   this server sidesteps both problems at once — the extension only ever
   sends partial address text and a session token here; the real key
   (GOOGLE_PLACES_API_KEY env var) lives only in this process, exactly
   like the AI provider key would in a real deployment. Gated by
   authenticate() like every other route below, but NOT by chargeAI() —
   this is address-lookup convenience, not a metered AI feature, so any
   signed-in account (free plan included) can use it; the auth check
   alone is what stops it being an open proxy anyone could hit. */
const GOOGLE_PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY || "";

function httpsGetJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error("Bad response from Google Places")); }
      });
    }).on("error", reject);
  });
}

/* No real key configured in this reference server (same shape as
   stubProvider above) — a small fixed set of real Australian addresses,
   clearly not live data, so the route is provably wired end-to-end
   without needing a real Google key in every environment that runs this
   file. A real deployment sets GOOGLE_PLACES_API_KEY and this branch is
   never reached. */
const STUB_PLACES = [
  { placeId: "stub-1", description: "1 Martin Place, Sydney NSW 2000, Australia",
    address: { addressLine1: "1 Martin Place", suburb: "Sydney", state: "NSW", postcode: "2000", country: "Australia" } },
  { placeId: "stub-2", description: "1 Collins Street, Melbourne VIC 3000, Australia",
    address: { addressLine1: "1 Collins Street", suburb: "Melbourne", state: "VIC", postcode: "3000", country: "Australia" } },
  { placeId: "stub-3", description: "1 Eagle Street, Brisbane City QLD 4000, Australia",
    address: { addressLine1: "1 Eagle Street", suburb: "Brisbane City", state: "QLD", postcode: "4000", country: "Australia" } },
  { placeId: "stub-4", description: "1 William Street, Perth WA 6000, Australia",
    address: { addressLine1: "1 William Street", suburb: "Perth", state: "WA", postcode: "6000", country: "Australia" } }
];

function stubAutocomplete(input) {
  const needle = String(input || "").trim().toLowerCase();
  if (!needle) return [];
  return STUB_PLACES.filter(p => p.description.toLowerCase().indexOf(needle) > -1 || needle.length < 3).slice(0, 5);
}

/* Google's address_components array (a list of {long_name, short_name,
   types[]}) into the flat shape setup.js's form actually has fields for.
   AU-biased field choice (locality first) but falls back through the
   component types real Google responses use when locality is absent
   (common for regional addresses). */
function parseAddressComponents(components) {
  components = components || [];
  function find(type) { return components.find(c => (c.types || []).indexOf(type) > -1); }
  const streetNumber = find("street_number");
  const route = find("route");
  const locality = find("locality") || find("postal_town") || find("sublocality") || find("administrative_area_level_2");
  const state = find("administrative_area_level_1");
  const postcode = find("postal_code");
  const country = find("country");
  return {
    addressLine1: [streetNumber && streetNumber.long_name, route && route.long_name].filter(Boolean).join(" "),
    suburb: locality ? locality.long_name : "",
    state: state ? (state.short_name || state.long_name) : "",
    postcode: postcode ? postcode.long_name : "",
    country: country ? country.long_name : ""
  };
}

/* ---------- Stripe billing (reference) ----------
   Same shape as the AI provider and Places integrations above: a real
   REST call (Node's https module only, no Stripe SDK, matching this
   file's existing "built-ins only" rule) when a key is configured, a
   clearly-marked demo fallback when it isn't. Nothing here was reachable
   before this change -- checkout()/billingPortal() in cloud.js called
   /v1/billing/checkout and /v1/billing/portal, and this file had no such
   routes at all (confirmed live: both 404'd). Adding the routes AND
   wiring them to a real payment processor are the same change, not two --
   there is no reference/demo billing layer that predates this.

   planId -> Stripe price env var. "pro" is a recurring monthly
   subscription (mode=subscription); "season" is a one-off purchase
   (mode=payment) -- these are genuinely different Stripe Checkout modes,
   not a detail to paper over. */
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const STRIPE_PRICE_BY_PLAN = {
  pro: process.env.STRIPE_PRICE_PRO_MONTHLY || "",
  season: process.env.STRIPE_PRICE_SEASON_PASS || ""
};
const STRIPE_CHECKOUT_MODE_BY_PLAN = { pro: "subscription", season: "payment" };

function httpsFormPost(hostname, path, formParams, extraHeaders) {
  return new Promise((resolve, reject) => {
    const body = Object.keys(formParams || {}).map(k => encodeURIComponent(k) + "=" + encodeURIComponent(formParams[k])).join("&");
    const req = https.request({
      hostname, path, method: "POST",
      headers: Object.assign({ "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) }, extraHeaders || {})
    }, (res) => {
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch (e) { reject(new Error("Non-JSON response from Stripe (HTTP " + res.statusCode + "): " + data.slice(0, 200))); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function stripeCreateCheckoutSession(planId, account, successUrl, cancelUrl) {
  const priceId = STRIPE_PRICE_BY_PLAN[planId];
  const mode = STRIPE_CHECKOUT_MODE_BY_PLAN[planId];
  if (!priceId || !mode) throw new Error("No Stripe price configured for plan '" + planId + "'");
  const params = {
    mode,
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: account.token,
    // Read back on the webhook so the plan is applied to the right account
    // without trusting anything else the client could have sent us.
    "metadata[gradfill_account_token]": account.token,
    "metadata[gradfill_plan]": planId
  };
  if (account.email) params.customer_email = account.email;
  const res = await httpsFormPost("api.stripe.com", "/v1/checkout/sessions", params, { Authorization: "Bearer " + STRIPE_SECRET_KEY });
  if (res.status >= 400) throw new Error((res.body && res.body.error && res.body.error.message) || "Stripe checkout session creation failed");
  return res.body;
}

async function stripeCreatePortalSession(account, returnUrl) {
  if (!account.stripeCustomerId) throw new Error("No Stripe customer on file yet -- complete a checkout first.");
  const res = await httpsFormPost("api.stripe.com", "/v1/billing_portal/sessions", { customer: account.stripeCustomerId, return_url: returnUrl }, { Authorization: "Bearer " + STRIPE_SECRET_KEY });
  if (res.status >= 400) throw new Error((res.body && res.body.error && res.body.error.message) || "Stripe billing portal session creation failed");
  return res.body;
}

/* Stripe's documented scheme: header is "t=<timestamp>,v1=<hex hmac>",
   signed payload is "<timestamp>.<raw body>", HMAC-SHA256 with the
   webhook signing secret. Timing-safe compare, not string equality. */
function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!secret || !sigHeader) return false;
  const parts = {};
  String(sigHeader).split(",").forEach(kv => { const i = kv.indexOf("="); if (i > -1) parts[kv.slice(0, i)] = kv.slice(i + 1); });
  if (!parts.t || !parts.v1) return false;
  const expected = crypto.createHmac("sha256", secret).update(parts.t + "." + rawBody).digest("hex");
  try {
    const a = Buffer.from(expected, "hex"), b = Buffer.from(parts.v1, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

/* ---------- Coinbase Commerce billing (reference) ----------
   The crypto path. Deliberately offered for the Season Pass only, never
   "pro" -- a Coinbase Commerce charge is a one-off blockchain payment,
   not a subscription. Recurring billing needs a payment method that can
   itself be charged again automatically; nothing here can do that for
   crypto without a separate re-invoice/reminder flow this change does
   not add. Pretending "Pro via crypto" existed would mean it silently
   lapses every 30 days with no renewal -- worse than not offering it. */
const COINBASE_COMMERCE_API_KEY = process.env.COINBASE_COMMERCE_API_KEY || "";
const COINBASE_COMMERCE_WEBHOOK_SECRET = process.env.COINBASE_COMMERCE_WEBHOOK_SECRET || "";
const CRYPTO_ELIGIBLE_PLANS = { season: true };

function httpsJsonPost(hostname, path, jsonBody, extraHeaders) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(jsonBody || {});
    const req = https.request({
      hostname, path, method: "POST",
      headers: Object.assign({ "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, extraHeaders || {})
    }, (res) => {
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch (e) { reject(new Error("Non-JSON response from Coinbase Commerce (HTTP " + res.statusCode + "): " + data.slice(0, 200))); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function coinbaseCreateCharge(planId, account, priceAud, redirectUrl, cancelUrl) {
  const plan = PLAN_DEFS[planId];
  const body = {
    name: (plan && plan.name) || planId,
    description: "GradFill " + ((plan && plan.name) || planId) + " -- paid via cryptocurrency (Coinbase Commerce)",
    pricing_type: "fixed_price",
    local_price: { amount: String(priceAud), currency: "AUD" },
    redirect_url: redirectUrl,
    cancel_url: cancelUrl,
    metadata: { gradfill_account_token: account.token, gradfill_plan: planId }
  };
  const res = await httpsJsonPost("api.commerce.coinbase.com", "/charges", body, { "X-CC-Api-Key": COINBASE_COMMERCE_API_KEY, "X-CC-Version": "2018-03-22" });
  if (res.status >= 400) throw new Error((res.body && res.body.error && res.body.error.message) || "Coinbase Commerce charge creation failed");
  return res.body;
}

/* Coinbase's documented scheme: header "X-CC-Webhook-Signature" is the
   hex HMAC-SHA256 of the raw request body using the shared webhook
   secret -- no timestamp component, unlike Stripe's. */
function verifyCoinbaseSignature(rawBody, sigHeader, secret) {
  if (!secret || !sigHeader) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    const a = Buffer.from(expected, "hex"), b = Buffer.from(String(sigHeader), "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

/* Only "charge:confirmed" (Coinbase's own term for a charge that reached
   the required on-chain confirmations for the FULL amount) ever grants
   the plan. Never on "charge:pending" (payment seen on the network but
   still waiting on confirmations -- the "late due to network confirmation
   time" case) and never on an UNRESOLVED charge (Coinbase's status for
   underpaid/overpaid/delayed -- confirmed-but-wrong-amount is not the
   same as confirmed). Both of those just mean "not paid yet" here. */
function coinbaseEventGrantsPlan(event) {
  return !!(event && event.type === "charge:confirmed");
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

const AI_ROUTES = {
  "/v1/ai/resume-tailor": "resume",
  "/v1/ai/answer-draft": "draft",
  "/v1/ai/cover-letter": "coverletter"
};

// The real extension never hits CORS at all: MV3's host_permissions
// (already declared for these exact origins in manifest.json) grants
// fetch() from an extension page/service worker past the same-origin
// restriction entirely. CORS only matters for the public marketing
// site's account.html, which runs in a plain browser tab and gets no
// such exemption. Scoped to that site's real origin(s) specifically —
// not a wildcard — because a wildcard would let any other website's
// script make authenticated requests here using a token it phished or
// guessed, same-origin-policy being the only thing normally stopping
// that. Add a custom domain here if/when GradFill AI gets one.
const ALLOWED_ORIGINS = ["https://aih44d1-eng.github.io"];
function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.indexOf(origin) > -1) return true;
  // Local dev/testing convenience only -- never true in the actual
  // deployed environment, where render.yaml sets NODE_ENV=production.
  if (process.env.NODE_ENV !== "production" && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
}

function createServer(store) {
  store = store || createAccountStore();
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (isAllowedOrigin(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      // Response varies by request Origin now, not a fixed wildcard --
      // tell any cache (browser, CDN, proxy) not to reuse one origin's
      // CORS response for a different origin's request.
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const path = (req.url || "").split("?")[0];

    // Unauthenticated, no database access — exists purely so a hosting
    // platform's health check (e.g. Render) has something to poll that
    // can't itself fail because a bearer token or a DB row is missing.
    if (req.method === "GET" && path === "/healthz") {
      send(res, 200, { ok: true });
      return;
    }

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

      try {
        const result = await callAIProvider(kind, body);
        send(res, 200, result);
      } catch (e) {
        // The charge above already happened. A real deployment should
        // consider refunding the metered use on provider failure; this
        // reference server surfaces the failure honestly instead of
        // pretending success or silently falling back to stub content.
        send(res, 502, { error: e.message || "AI provider request failed." });
      }
      return;
    }

    if (req.method === "GET" && path === "/v1/places/autocomplete") {
      const account = await authenticate(store, req);
      if (!account) { send(res, 401, { error: "Missing or invalid token" }); return; }
      const q = new URL(req.url, "http://localhost");
      const input = q.searchParams.get("input") || "";
      const sessiontoken = q.searchParams.get("sessiontoken") || "";
      if (!input.trim()) { send(res, 200, { predictions: [] }); return; }

      if (!GOOGLE_PLACES_KEY) { send(res, 200, { predictions: stubAutocomplete(input), demo: true }); return; }
      try {
        const url = "https://maps.googleapis.com/maps/api/place/autocomplete/json"
          + "?input=" + encodeURIComponent(input)
          + "&region=au&language=en"
          + (sessiontoken ? "&sessiontoken=" + encodeURIComponent(sessiontoken) : "")
          + "&key=" + GOOGLE_PLACES_KEY;
        const data = await httpsGetJSON(url);
        const predictions = (data.predictions || []).map(p => ({ placeId: p.place_id, description: p.description }));
        send(res, 200, { predictions });
      } catch (e) {
        send(res, 502, { error: "Address lookup is temporarily unavailable." });
      }
      return;
    }

    if (req.method === "GET" && path === "/v1/places/details") {
      const account = await authenticate(store, req);
      if (!account) { send(res, 401, { error: "Missing or invalid token" }); return; }
      const q = new URL(req.url, "http://localhost");
      const placeId = q.searchParams.get("place_id") || "";
      const sessiontoken = q.searchParams.get("sessiontoken") || "";
      if (!placeId) { send(res, 400, { error: "place_id is required" }); return; }

      if (!GOOGLE_PLACES_KEY) {
        const stub = STUB_PLACES.find(p => p.placeId === placeId);
        send(res, 200, { address: (stub && stub.address) || null, demo: true });
        return;
      }
      try {
        const url = "https://maps.googleapis.com/maps/api/place/details/json"
          + "?place_id=" + encodeURIComponent(placeId)
          + "&fields=address_component"
          + (sessiontoken ? "&sessiontoken=" + encodeURIComponent(sessiontoken) : "")
          + "&key=" + GOOGLE_PLACES_KEY;
        const data = await httpsGetJSON(url);
        const address = parseAddressComponents(data.result && data.result.address_components);
        send(res, 200, { address });
      } catch (e) {
        send(res, 502, { error: "Address lookup is temporarily unavailable." });
      }
      return;
    }

    if (req.method === "POST" && path === "/v1/billing/checkout") {
      const account = await authenticate(store, req);
      if (!account) { send(res, 401, { error: "Missing or invalid token" }); return; }
      const body = await readBody(req);
      const planId = (body && body.plan) === "season" ? "season" : "pro";

      if (!STRIPE_SECRET_KEY) {
        // No live Stripe account configured -- this is the honest state of
        // this reference server today. Returning a null url (rather than a
        // fabricated checkout link) means the extension correctly does
        // nothing further, same as any other unconfigured demo path here.
        send(res, 200, { url: null, demo: true, message: "Stripe is not configured on this server (STRIPE_SECRET_KEY unset) -- no real checkout exists yet. See README for setup." });
        return;
      }
      try {
        const base = "https://gradfill.app"; // replace with a real hosted success/cancel page in production
        const session = await stripeCreateCheckoutSession(planId, account, base + "/billing/success", base + "/billing/cancel");
        send(res, 200, { url: session.url });
      } catch (e) {
        send(res, 502, { error: e.message || "Could not start Stripe checkout." });
      }
      return;
    }

    if (req.method === "POST" && path === "/v1/billing/portal") {
      const account = await authenticate(store, req);
      if (!account) { send(res, 401, { error: "Missing or invalid token" }); return; }

      if (!STRIPE_SECRET_KEY) {
        send(res, 200, { url: null, demo: true, message: "Stripe is not configured on this server (STRIPE_SECRET_KEY unset)." });
        return;
      }
      try {
        const session = await stripeCreatePortalSession(account, "https://gradfill.app/billing");
        send(res, 200, { url: session.url });
      } catch (e) {
        send(res, 502, { error: e.message || "Could not open the billing portal." });
      }
      return;
    }

    // Stripe calls this directly -- never through the extension, never
    // carrying a bearer token. Authenticity comes entirely from the
    // signature check below, not from authenticate().
    if (req.method === "POST" && path === "/v1/billing/webhook") {
      const raw = await readRawBody(req);
      if (!verifyStripeSignature(raw, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET)) {
        send(res, 400, { error: "Invalid signature" });
        return;
      }
      let event; try { event = JSON.parse(raw); } catch (e) { send(res, 400, { error: "Bad payload" }); return; }

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
      send(res, 200, { received: true });
      return;
    }

    if (req.method === "POST" && path === "/v1/billing/crypto/checkout") {
      const account = await authenticate(store, req);
      if (!account) { send(res, 401, { error: "Missing or invalid token" }); return; }
      const body = await readBody(req);
      const planId = (body && body.plan) || "season";

      if (!CRYPTO_ELIGIBLE_PLANS[planId]) {
        send(res, 400, { error: "Crypto checkout is available for the Grad Season Pass only -- Pro is a recurring subscription, which a one-off blockchain payment can't fund on its own." });
        return;
      }
      if (!COINBASE_COMMERCE_API_KEY) {
        send(res, 200, { url: null, demo: true, message: "Coinbase Commerce is not configured on this server (COINBASE_COMMERCE_API_KEY unset) -- no real crypto checkout exists yet. See README for setup." });
        return;
      }
      try {
        const base = "https://gradfill.app"; // replace with a real hosted success/cancel page in production
        // PLAN_DEFS prices are formatted strings ("A$45 / 90 days") for
        // display -- Coinbase needs a bare numeric AUD amount.
        const priceAud = planId === "season" ? "45.00" : "20.00";
        const charge = await coinbaseCreateCharge(planId, account, priceAud, base + "/billing/success", base + "/billing/cancel");
        send(res, 200, { url: charge.data && charge.data.hosted_url });
      } catch (e) {
        send(res, 502, { error: e.message || "Could not start crypto checkout." });
      }
      return;
    }

    // Coinbase calls this directly, same trust model as the Stripe webhook
    // above -- signature verification is the only authenticity check.
    if (req.method === "POST" && path === "/v1/billing/crypto/webhook") {
      const raw = await readRawBody(req);
      if (!verifyCoinbaseSignature(raw, req.headers["x-cc-webhook-signature"], COINBASE_COMMERCE_WEBHOOK_SECRET)) {
        send(res, 400, { error: "Invalid signature" });
        return;
      }
      let body; try { body = JSON.parse(raw); } catch (e) { send(res, 400, { error: "Bad payload" }); return; }
      const event = body && body.event;

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
      // Every other event (charge:pending, charge:created, charge:delayed,
      // an UNRESOLVED charge's charge:failed) intentionally falls through
      // to here without touching any account -- "not confirmed yet" and
      // "never going to confirm" both just mean no plan change.
      send(res, 200, { received: true });
      return;
    }

    if (req.method === "GET" && path === "/v1/usage") {
      const account = await authenticate(store, req);
      if (!account) { send(res, 401, { error: "Missing or invalid token" }); return; }
      const plan = planFor(account);
      const mk = monthKey();
      const u = account.usage.month === mk ? account.usage : { drafts: 0, resumes: 0, coverLetters: 0 };
      send(res, 200, {
        usage: {
          plan: plan.id,
          aiDrafts: { used: u.drafts || 0, limit: plan.aiDraftsPerMonth, period: "month" },
          resumeTailors: { used: u.resumes || 0, limit: plan.resumeTailorsPerMonth, period: "month" },
          coverLetters: { used: u.coverLetters || 0, limit: plan.coverLettersPerMonth, period: "month" }
        }
      });
      return;
    }

    send(res, 404, { error: "Not found" });
  });
}

module.exports = {
  createServer, createAccountStore, ensureSchema, closeAccountStore,
  seedAccount, getAccount, setAccountFieldsForTest, persistUsage,
  PLAN_DEFS, monthKey, chargeAI, planFor,
  verifyStripeSignature, verifyCoinbaseSignature, coinbaseEventGrantsPlan,
  callAIProvider, stubProvider, FABRICATION_SAFETY_RULES
};

/* Manual local run: node server/index.js — listens on 127.0.0.1:8787,
   matching cloud.js's DEFAULT_SETTINGS.localApiBase (127.0.0.1 for local
   dev, the real deployed Render URL for productionApiBase). Seeds one
   demo account (first boot only -- see below) so `Local backend` mode in
   the extension has something to authenticate against without a real
   signup flow. Requires DATABASE_URL — this reference server does not
   fall back to an in-memory store if it's unset, since persistence is
   the whole point of this file now. */
if (require.main === module) {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required — set it to a reachable Postgres connection string.");
    process.exit(1);
  }
  (async () => {
    const store = createAccountStore();
    await ensureSchema(store);
    // seedAccount() generates a fresh random token every call, and its
    // own ON CONFLICT target is `token` -- so calling it unconditionally
    // on every boot against a database that now actually persists (unlike
    // the old in-memory Map, which made this a no-op on every restart)
    // means every restart after the first tries to INSERT a second row
    // with the same fixed email, and accounts.email is separately UNIQUE.
    // Postgres correctly rejects that (23505) instead of silently
    // duplicating an account. Look the demo account up by email first and
    // only seed it if this is genuinely the first boot ever.
    const demoEmail = "demo-free@gradfill.local";
    if (!(await accountByEmail(store, demoEmail))) {
      await seedAccount(store, crypto.randomUUID(), "free", demoEmail);
    }
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
