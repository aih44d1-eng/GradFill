/* GradFill AI — account, plan, quota, sync and AI client.
   No API secret lives in the extension. Production AI calls go through
   the GradFill backend; demo mode stays entirely local.

   Free/paid boundary (deliberate, keep this split legible):
   - The deterministic autofill engine, tracker and profile/setup are FREE,
     unlimited, and never touch this file's quota logic. content.js and
     rules.js do zero-marginal-cost pattern matching only — there is
     nothing in that path to meter.
   - Only genuinely generative AI calls — resume tailoring, cover letter
     generation, and drafted answers to open-ended questions — are paid
     and metered here. Every one of those three goes through canUseAI()
     below before anything is spent, in both demo and real-backend modes,
     so the gate lives in exactly one place. The "Copy prompt" hand-off
     (buildPrompt/buildPromptWithValues in content.js) is NOT an AI call —
     it only builds a text prompt for the user's own outside conversation —
     and stays free and ungated, same as it always has. */
(function () {
  "use strict";

  var PLAN_DEFS = {
    free: {
      id: "free", name: "Free", price: "A$0", billingPeriod: "forever",
      aiEnabled: false,
      aiDraftsPerMonth: 0, resumeTailorsPerMonth: 0, coverLettersPerMonth: 0,
      cloudSync: true
    },
    pro: {
      // Cross-checked against gradfill-competitive-research.pdf: the
      // recommendation is "$15-25/month", undercutting the $24-45/mo tier
      // (Careerflow, JobCopilot) and well clear of LazyApply's $99-999/yr.
      // A$20/month sits at the midpoint of that band.
      id: "pro", name: "Pro", price: "A$20/month", billingPeriod: "month",
      aiEnabled: true,
      aiDraftsPerMonth: 200, resumeTailorsPerMonth: 40, coverLettersPerMonth: 40,
      cloudSync: true
    },
    season: {
      // A one-off pass covering a graduate-application season rather than
      // a recurring subscription. A$45/90 days works out to A$15/month
      // equivalent — the floor of the PDF's $15-25/month band — which is
      // the intended "undercut" read of the recommendation for someone who
      // only needs this for one application season, not year-round.
      id: "season", name: "Grad Season Pass", price: "A$45 / 90 days", billingPeriod: "season", seasonDays: 90,
      aiEnabled: true,
      aiDraftsPerMonth: 200, resumeTailorsPerMonth: 40, coverLettersPerMonth: 40,
      cloudSync: true
    }
  };

  var DEFAULT_SETTINGS = {
    mode: "demo",              // demo | local | production
    demoPlan: "free",
    cloudSync: false,
    localApiBase: "http://127.0.0.1:8787",
    productionApiBase: "https://api.gradfill.app"
  };

  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function nowISO() { return new Date().toISOString(); }
  function monthKey() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  }
  function normaliseBase(s) { return String(s || "").replace(/\/+$/, ""); }

  async function getSettings() {
    var o = await chrome.storage.local.get("gfSettings");
    return Object.assign({}, DEFAULT_SETTINGS, o.gfSettings || {});
  }
  async function setSettings(patch) {
    var s = await getSettings();
    Object.assign(s, patch || {});
    await chrome.storage.local.set({ gfSettings: s });
    return s;
  }
  async function getAccount() {
    var o = await chrome.storage.local.get("gfAccount");
    return o.gfAccount || null;
  }
  async function setAccount(account) {
    await chrome.storage.local.set({ gfAccount: account || null });
    return account || null;
  }
  async function logout() { await setAccount(null); }

  async function apiBase() {
    var s = await getSettings();
    return s.mode === "local" ? normaliseBase(s.localApiBase) : normaliseBase(s.productionApiBase);
  }

  async function api(path, opts) {
    var s = await getSettings();
    if (s.mode === "demo") throw new Error("Cloud API is disabled in demo mode");
    var a = await getAccount();
    var headers = Object.assign({ "Content-Type": "application/json" }, (opts && opts.headers) || {});
    if (a && a.token) headers.Authorization = "Bearer " + a.token;
    var res = await fetch((await apiBase()) + path, Object.assign({}, opts || {}, { headers: headers }));
    var data = null;
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok) {
      var err = new Error((data && data.error) || ("Request failed (" + res.status + ")"));
      err.status = res.status; err.data = data;
      // The backend's own { code } is authoritative for the AI routes
      // (server/index.js returns "paywall" or "quota" on 402) — that's
      // what actually distinguishes "you're not entitled" from "you used
      // up this month's cap" for the UI. 429 still falls back to "quota"
      // for any endpoint that signals rate-limiting that way instead.
      err.code = (data && data.code) || (res.status === 429 ? "quota" : ((data && data.reason) || "request"));
      throw err;
    }
    return data;
  }

  async function register(email, password) {
    var data = await api("/v1/auth/register", { method: "POST", body: JSON.stringify({ email: email, password: password }) });
    await setAccount(data.account);
    return data.account;
  }
  async function login(email, password) {
    var data = await api("/v1/auth/login", { method: "POST", body: JSON.stringify({ email: email, password: password }) });
    await setAccount(data.account);
    return data.account;
  }
  async function refreshAccount() {
    var s = await getSettings();
    if (s.mode === "demo") return null;
    var data = await api("/v1/account", { method: "GET" });
    if (data.account) await setAccount(data.account);
    return data.account || null;
  }

  async function plan() {
    var s = await getSettings();
    if (s.mode === "demo") return clone(PLAN_DEFS[s.demoPlan] || PLAN_DEFS.free);
    var a = await getAccount();
    var id = a && a.plan && a.plan.id ? a.plan.id : "free";
    return Object.assign(clone(PLAN_DEFS[id] || PLAN_DEFS.free), (a && a.plan) || {});
  }

  async function usage() {
    var s = await getSettings();
    if (s.mode !== "demo") {
      try { return (await api("/v1/usage", { method: "GET" })).usage; }
      catch (e) { return null; }
    }
    var p = await plan();
    var o = await chrome.storage.local.get("gfUsage");
    var u = o.gfUsage || {};
    var mk = monthKey();
    var ai = (u.ai && u.ai.month === mk) ? u.ai : { drafts: 0, resumes: 0, coverLetters: 0 };
    return {
      plan: p.id,
      aiDrafts: { used: ai.drafts || 0, limit: p.aiDraftsPerMonth, period: "month" },
      resumeTailors: { used: ai.resumes || 0, limit: p.resumeTailorsPerMonth, period: "month" },
      coverLetters: { used: ai.coverLetters || 0, limit: p.coverLettersPerMonth, period: "month" }
    };
  }

  // Single gate for every genuinely-generative AI call (resume tailor, cover
  // letter, drafted answer). Checked client-side first for a fast, honest
  // "this is a Pro feature" message instead of a confusing quota error —
  // the real backend (production/local mode) re-checks server-side too,
  // since a client-side check alone is not real enforcement against a
  // modified extension. Nothing else in the codebase should call the AI
  // endpoints without going through this first.
  async function canUseAI() {
    var p = await plan();
    if (!p.aiEnabled) return { allowed: false, plan: p, reason: "not_entitled" };
    return { allowed: true, plan: p };
  }

  async function consumeDemoAI(kind) {
    var gate = await canUseAI();
    if (!gate.allowed) { var e0 = new Error("This is a GradFill Pro feature — upgrade to use AI drafting."); e0.code = "paywall"; throw e0; }
    var p = gate.plan;
    var o = await chrome.storage.local.get("gfUsage");
    var u = o.gfUsage || {};
    var mk = monthKey();
    if (!u.ai || u.ai.month !== mk) u.ai = { month: mk, drafts: 0, resumes: 0, coverLetters: 0 };
    var key = kind === "resume" ? "resumes" : kind === "coverletter" ? "coverLetters" : "drafts";
    var lim = kind === "resume" ? p.resumeTailorsPerMonth : kind === "coverletter" ? p.coverLettersPerMonth : p.aiDraftsPerMonth;
    if ((u.ai[key] || 0) >= lim) return { allowed: false, limit: lim };
    u.ai[key] = (u.ai[key] || 0) + 1;
    await chrome.storage.local.set({ gfUsage: u });
    return { allowed: true, remaining: Math.max(0, lim - u.ai[key]) };
  }

  function safeProfileForAI(profile) {
    profile = profile || {};
    return {
      personal: { firstName: profile.personal && profile.personal.firstName || "" },
      education: profile.education || [],
      experience: profile.experience || [],
      skills: profile.skills || [],
      languages: profile.languages || [],
      starBank: profile.starBank || [],
      preferences: profile.preferences || {}
    };
  }

  function topWords(text) {
    var stop = new Set("the and for with that this from your you are our will have has role job into their they about skills skill experience work working team graduate program candidate required preferred ability strong good excellent using use within across through who what when where how not but all any can".split(" "));
    var counts = {};
    String(text || "").toLowerCase().match(/[a-z][a-z0-9+.#-]{2,}/g)?.forEach(function (w) {
      if (!stop.has(w)) counts[w] = (counts[w] || 0) + 1;
    });
    return Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 18);
  }

  function demoResume(payload) {
    var p = safeProfileForAI(payload.profile);
    var role = payload.role || {};
    var jd = role.description || payload.jobDescription || "";
    var keywords = topWords(jd);
    var skills = Array.isArray(p.skills) ? p.skills : String(p.skills || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean);
    var matched = skills.filter(function (s) { return jd.toLowerCase().indexOf(String(s).toLowerCase()) > -1; });
    var remaining = skills.filter(function (s) { return matched.indexOf(s) < 0; });
    var out = [];
    out.push((p.personal.firstName || "Candidate") + " — tailored resume draft");
    out.push((role.title || "Target role") + (role.company ? " | " + role.company : ""));
    out.push("");
    out.push("PROFILE");
    out.push("Graduate candidate with experience and study aligned to " + (role.title || "this opportunity") + ". This demo draft only rearranges facts already saved in GradFill; review every line before use.");
    out.push("");
    if (skills.length) { out.push("CORE SKILLS"); out.push(matched.concat(remaining).join(" • ")); out.push(""); }
    if (p.experience.length) {
      out.push("EXPERIENCE");
      p.experience.forEach(function (e) {
        out.push((e.title || "Role") + (e.employer ? " — " + e.employer : ""));
        if (e.description) out.push(e.description);
      });
      out.push("");
    }
    if (p.education.length) {
      out.push("EDUCATION");
      p.education.forEach(function (e) { out.push([e.degree, e.major, e.institution].filter(Boolean).join(" — ")); });
      out.push("");
    }
    out.push("ROLE ALIGNMENT NOTES (remove before submitting)");
    out.push("Matched saved skills: " + (matched.join(", ") || "None detected verbatim"));
    out.push("High-frequency job-ad terms to review for truthful inclusion: " + (keywords.slice(0, 10).join(", ") || "None detected"));
    return { content: out.join("\n"), matchedSkills: matched, keywords: keywords, demo: true };
  }

  function demoDraft(payload) {
    var p = safeProfileForAI(payload.profile);
    var role = payload.role || {};
    var examples = (p.starBank || []).filter(function (x) { return x && (x.action || x.result); });
    var ex = examples[0] || {};
    var bits = [];
    bits.push("I am interested in " + (role.title || "this role") + (role.company ? " at " + role.company : "") + " because it aligns with my background and the skills I want to keep developing.");
    if (p.education[0]) bits.push("My " + [p.education[0].degree, p.education[0].major].filter(Boolean).join(" in ") + " has given me a foundation I can apply in a professional graduate environment.");
    if (ex.action) bits.push("One example I would draw on is: " + ex.action + (ex.result ? " The result was " + ex.result : ""));
    bits.push("I would review this draft against the exact question and job requirements before submitting it.");
    return { draft: bits.join(" "), demo: true };
  }

  // Cover letter generation — genuinely generative (a full document tying
  // saved background to a specific role), same paid tier as resume
  // tailoring and drafted answers. Deliberately NOT the same code path as
  // buildPrompt()/buildPromptWithValues() in content.js: that hand-off
  // pattern stays free (it only assembles a prompt for the user's own
  // outside conversation, no API call, zero marginal cost) — this is the
  // separate in-extension "generate it here" convenience for someone who's
  // already paying for AI drafting.
  function demoCoverLetter(payload) {
    var p = safeProfileForAI(payload.profile);
    var role = payload.role || {};
    var jd = role.description || payload.jobDescription || "";
    var name = [p.personal.firstName].filter(Boolean).join(" ") || "Candidate";
    var ex = (p.starBank || []).filter(function (x) { return x && (x.action || x.result); })[0] || {};
    var out = [];
    out.push("Dear Hiring Team" + (role.company ? " at " + role.company : "") + ",");
    out.push("");
    out.push("I am writing to apply for the " + (role.title || "advertised role") + (role.company ? " at " + role.company : "") + ". " +
      (p.education[0] ? "My " + [p.education[0].degree, p.education[0].major].filter(Boolean).join(" in ") + " has prepared me to contribute from day one." : "My background aligns closely with what this role needs."));
    if (ex.action) out.push("In a recent example, " + ex.action + (ex.result ? " — " + ex.result : "") + ".");
    if (p.skills && p.skills.length) out.push("I bring skills including " + p.skills.slice(0, 6).join(", ") + ".");
    out.push("I would welcome the opportunity to discuss how I can contribute to the team.");
    out.push("");
    out.push("Kind regards,");
    out.push(name);
    out.push("");
    out.push("[Offline demo draft — heuristic only, rearranges facts already saved in GradFill. Review every line, and personalise the job-ad-specific reasoning before sending: " + (jd ? "job description was provided and should inform the middle paragraph." : "no job description was provided.") + "]");
    return { content: out.join("\n"), demo: true };
  }

  async function aiResumeTailor(payload) {
    var gate = await canUseAI();
    if (!gate.allowed) { var eg = new Error("Resume tailoring is a GradFill Pro feature — upgrade to use it."); eg.code = "paywall"; throw eg; }
    var s = await getSettings();
    if (s.mode === "demo") {
      var q = await consumeDemoAI("resume");
      if (!q.allowed) { var e = new Error("Monthly resume-tailoring limit reached — resets next month, or upgrade for a higher cap."); e.code = "quota"; throw e; }
      return demoResume(payload || {});
    }
    return api("/v1/ai/resume-tailor", { method: "POST", body: JSON.stringify(payload || {}) });
  }
  async function aiAnswerDraft(payload) {
    var gate = await canUseAI();
    if (!gate.allowed) { var eg2 = new Error("AI-drafted answers are a GradFill Pro feature — upgrade to use them."); eg2.code = "paywall"; throw eg2; }
    var s = await getSettings();
    if (s.mode === "demo") {
      var q = await consumeDemoAI("draft");
      if (!q.allowed) { var e = new Error("Monthly AI-draft limit reached — resets next month, or upgrade for a higher cap."); e.code = "quota"; throw e; }
      return demoDraft(payload || {});
    }
    return api("/v1/ai/answer-draft", { method: "POST", body: JSON.stringify(payload || {}) });
  }
  async function aiCoverLetter(payload) {
    var gate = await canUseAI();
    if (!gate.allowed) { var eg3 = new Error("Cover letter generation is a GradFill Pro feature — upgrade to use it."); eg3.code = "paywall"; throw eg3; }
    var s = await getSettings();
    if (s.mode === "demo") {
      var q = await consumeDemoAI("coverletter");
      if (!q.allowed) { var e = new Error("Monthly cover-letter limit reached — resets next month, or upgrade for a higher cap."); e.code = "quota"; throw e; }
      return demoCoverLetter(payload || {});
    }
    // Backend contract (matches the existing resume-tailor/answer-draft
    // shape): POST { profile, role, jobDescription } -> { content, demo? }.
    // No production backend ships inside this repo — localApiBase /
    // productionApiBase point at a server that must implement this route,
    // same as the two AI endpoints above already assumed.
    return api("/v1/ai/cover-letter", { method: "POST", body: JSON.stringify(payload || {}) });
  }

  // Address autocomplete — always routed through the backend, never
  // client-side. No Google key is ever read, stored, or sent from this
  // file or anywhere else in the extension; the server holds it (see
  // server/index.js's GOOGLE_PLACES_KEY). Fails soft: no account/demo
  // mode/network hiccup all just mean "no suggestions right now", never
  // a thrown error the setup page has to handle — typing the address by
  // hand still works exactly as before this existed.
  async function placesAutocomplete(input, sessionToken) {
    var s = await getSettings();
    if (s.mode === "demo" || !input || !input.trim()) return { predictions: [] };
    try {
      var qs = "?input=" + encodeURIComponent(input) + "&sessiontoken=" + encodeURIComponent(sessionToken || "");
      return await api("/v1/places/autocomplete" + qs, { method: "GET" });
    } catch (e) { return { predictions: [] }; }
  }
  async function placesDetails(placeId, sessionToken) {
    var s = await getSettings();
    if (s.mode === "demo" || !placeId) return { address: null };
    try {
      var qs = "?place_id=" + encodeURIComponent(placeId) + "&sessiontoken=" + encodeURIComponent(sessionToken || "");
      return await api("/v1/places/details" + qs, { method: "GET" });
    } catch (e) { return { address: null }; }
  }

  function sanitiseProfileForCloud(profile) {
    var p = clone(profile || {});
    if (p.resume) p.resume = { name: p.resume.name || "", type: p.resume.type || "", data: null };
    if (p.academicRecord) p.academicRecord = { name: p.academicRecord.name || "", type: p.academicRecord.type || "", data: null };
    return p;
  }
  async function syncProfile(profile) {
    var s = await getSettings();
    if (s.mode === "demo" || !s.cloudSync) return { skipped: true };
    return api("/v1/profile/sync", { method: "POST", body: JSON.stringify({ profile: sanitiseProfileForCloud(profile) }) });
  }
  async function pullProfile() {
    var s = await getSettings();
    if (s.mode === "demo" || !s.cloudSync) return null;
    return (await api("/v1/profile", { method: "GET" })).profile || null;
  }
  async function syncTracker(applications) {
    var s = await getSettings();
    if (s.mode === "demo" || !s.cloudSync) return { skipped: true };
    return api("/v1/tracker/sync", { method: "POST", body: JSON.stringify({ applications: applications || [] }) });
  }
  async function pullTracker() {
    var s = await getSettings();
    if (s.mode === "demo" || !s.cloudSync) return null;
    return (await api("/v1/tracker", { method: "GET" })).applications || [];
  }
  async function checkout(planId) {
    // planId: "pro" (monthly) or "season" (one-off grad-season pass). Both
    // billing shapes are legitimate here — never "week".
    var data = await api("/v1/billing/checkout", { method: "POST", body: JSON.stringify({ plan: planId || "pro" }) });
    if (data.url) chrome.tabs.create({ url: data.url });
    return data;
  }
  async function billingPortal() {
    var data = await api("/v1/billing/portal", { method: "POST", body: "{}" });
    if (data.url) chrome.tabs.create({ url: data.url });
    return data;
  }
  // Crypto (Coinbase Commerce), additive to Stripe, never a replacement.
  // Season Pass only -- a one-off blockchain charge can't fund a
  // recurring "pro" subscription on its own, so this refuses "pro"
  // client-side too (the server refuses it independently either way).
  async function cryptoCheckout(planId) {
    if (planId && planId !== "season") throw new Error("Crypto checkout is available for the Grad Season Pass only.");
    var data = await api("/v1/billing/crypto/checkout", { method: "POST", body: JSON.stringify({ plan: "season" }) });
    if (data.url) chrome.tabs.create({ url: data.url });
    return data;
  }

  window.GFCloud = {
    PLAN_DEFS: PLAN_DEFS,
    getSettings: getSettings, setSettings: setSettings,
    getAccount: getAccount, setAccount: setAccount, logout: logout,
    register: register, login: login, refreshAccount: refreshAccount,
    plan: plan, usage: usage, canUseAI: canUseAI,
    aiResumeTailor: aiResumeTailor, aiAnswerDraft: aiAnswerDraft, aiCoverLetter: aiCoverLetter,
    placesAutocomplete: placesAutocomplete, placesDetails: placesDetails,
    syncProfile: syncProfile, pullProfile: pullProfile,
    syncTracker: syncTracker, pullTracker: pullTracker,
    checkout: checkout, billingPortal: billingPortal, cryptoCheckout: cryptoCheckout,
    safeProfileForAI: safeProfileForAI,
    monthKey: monthKey, nowISO: nowISO
  };
})();
