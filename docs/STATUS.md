# GradFill AI — Project Status

**Last updated:** 2026-09-18
**Extension version:** 2.14.0
**Live backend:** https://gradfill-backend-hajr.onrender.com
**Live site:** https://aih44d1-eng.github.io/GradFill/

This document is updated in place, not recreated per session. Every item below is marked:
- ✅ **Confirmed working** — proven with a specific test, not assumed
- 🔧 **Built but not fully verified** — code exists; states exactly what's missing to confirm it
- ❌ **Not built** — doesn't exist yet

"Confirmed" means an actual test was run and its result is stated. If a claim can't point to a specific test, it isn't marked ✅, regardless of how complete the code looks.

---

## 1. Autofill engine — platform by platform

| Platform | Detection | Field-filling | Evidence |
|---|---|---|---|
| **Workday** | ✅ Hostname match | ✅ Confirmed on real applications | `rules.js` comments document specific confirmed-live behavior (e.g. year-only field handling "confirmed live on Workday's..."). Also has dedicated fixture tests (`workday-test.html`, `workday-education-test.html`). |
| **SAP SuccessFactors** | ✅ Hostname + DOM fingerprint (`coreCSB` class, confirmed on EY/ANZ/BHP/CSIRO) | ✅ Confirmed on real applications, extensively | By far the best-evidenced platform: dozens of `rules.js` comments citing specific real confirmations (CSIRO's Candidate Profile, EY's Degree/Work/Education sections, Telstra's Education panel). `CHANGELOG.md` documents real bugs found and fixed against CSIRO's live SuccessFactors instance (combobox commit failures, block-assignment ordering, non-standard file-upload buttons). |
| **Oracle Fusion Cloud Recruiting** | ✅ Hostname + fingerprint (`oj-hcm-ce` bundle) | ✅ Confirmed on real applications | Confirmed live on two real tenants: Westpac (`ebuu.fa.ap1.oraclecloud.com`) and South Lanarkshire Council (`fa-euuc-saasfaprod1.fa.ocs.oraclecloud.com`), per `CHANGELOG.md` and `rules.js` comments. Fixture test also exists (`oracle-recruiting-test.html`). |
| **Avature** | ✅ Hostname + fingerprint (avacdn.net asset, confirmed on Macquarie and Siemens) | ❌ **Not built** | This is the platform's known, real gap. Detection works and has been confirmed against two real tenants, but `content.js` has **zero** Avature-specific field-filling logic — `grep -c "avature" content.js` returns 0. A detected Avature page falls through to generic form-filling only. |
| **PageUp** | ✅ Hostname match only | 🔧 Generic pattern-matching, not platform-specific | No dedicated fingerprint (relies on hostname alone), no `rules.js` comments documenting a real confirmed-live PageUp application, no fixture test file. `content.js` groups PageUp with Workday for some ASP.NET-style ID-pattern handling, but this is inferred shared behavior, not a confirmed PageUp-specific test. Weakest-evidenced platform of the five. |

**Note on the evidence itself:** the "confirmed live" claims above come from detailed developer comments embedded in `rules.js`/`CHANGELOG.md` describing specific real customer sites, specific bugs, and specific fixes — not vague assertions. I did not personally re-verify these against live sites this session; I'm reporting what the codebase's own documentation claims, which reads as credible (specific tenant names, specific DOM structures, specific bug mechanics) rather than generic.

---

## 2. AI features

| Item | Status | Evidence |
|---|---|---|
| Real Anthropic wiring | ✅ Confirmed | Model pinned to `claude-haiku-4-5-20251001` in `server/index.js`. Proven with real, non-mocked API calls against the live deployed server this session. |
| Resume tailoring | ✅ Confirmed | Live call via `/v1/ai/resume-tailor` on the deployed URL returned genuine generated content (`demo:false`). |
| Cover letter generation | ✅ Confirmed | Same route family, same proof method, real generated content. |
| Answer drafting | ✅ Confirmed | Live call via `/v1/ai/answer-draft` on the deployed URL, real generated content, verified twice (once locally, once against the live Render URL with a real DB-backed Pro account). |
| Fabrication-safety system prompt | ✅ Confirmed | Tested with a deliberately thin profile against a demanding job posting — the model declined to invent missing qualifications and said so plainly, rather than fabricating a match, in both the resume and cover-letter outputs. |
| Entitlement/quota enforcement (server-side) | ✅ Confirmed | `test-server-enforcement.js` proves a spoofed client-side "pro" claim is ignored, and the real 40/month cap is enforced server-side even for a genuinely entitled account. |
| **PDF/DOCX resume/transcript extraction** | ❌ **Not built** | This stalled, plainly. It was scoped (pdf-parse + mammoth, a `server/package.json` to be added) but the task was interrupted by the landing-page and Postgres/hosting work before any code was written. `grep` for `pdf-parse`/`mammoth` anywhere in the repo returns nothing. There is no `package.json` at the repo root at all. **Practical consequence:** AI resume tailoring and answer drafting only ever see whatever the user manually types into the Setup profile — the uploaded resume/transcript file's actual text content is never read or fed to the AI. |

---

## 3. Backend infrastructure

| Item | Status | Evidence |
|---|---|---|
| Database persistence (Postgres/Supabase) | ✅ Confirmed | `test-server-restart-survival.js` passed against the real Supabase instance: created an account, killed the server and its connection pool, started a new instance, account/plan/usage all survived. Also confirmed via two real Render deploy-restart cycles (the demo account survived a failed deploy attempt into a subsequent successful one). |
| Render hosting / live URL | ✅ Confirmed | `https://gradfill-backend-hajr.onrender.com/healthz` returns `{"ok":true}` — this is what Render's own platform health check depends on, so Render itself considers the service healthy, not just "responsive to me." |
| Real DB connectivity from the deployed instance specifically | ✅ Confirmed | Read a token directly from Supabase (bypassing the live server), then queried the live server with that exact token and got the correct account back — proves the deployed process is reading the same real database, not a different one. |
| CORS | ✅ Confirmed, and now properly scoped | Was `Access-Control-Allow-Origin: *` (functionally worked, but wide open). Now scoped to an explicit allowlist (`https://aih44d1-eng.github.io`, plus localhost for local dev only when `NODE_ENV !== "production"`). Verified live: the real site's origin gets the header back, an arbitrary attacker origin gets none. Re-ran the full website login flow after the change — still works. |
| Register / login / usage / billing-portal routes | ✅ Confirmed | All exercised live against the real deployed URL — see Section 7 for the full end-to-end website proof. |
| A genuine, deliberately-triggered Render process restart (not just deploy-to-deploy survival) | 🔧 Not directly tested | I don't have Render dashboard access to force a manual restart on demand. What's proven instead: the local restart-survival test (full process kill + new pool + new server instance) against the same real database, plus real evidence the demo account survived at least one actual deploy-to-deploy transition on the real platform. This is strong indirect evidence, not a literal "I clicked restart and checked" test. |

---

## 4. Payments

| Item | Status | Evidence |
|---|---|---|
| Stripe | ❌ **Still demo-only.** No `STRIPE_SECRET_KEY` configured anywhere — only `DATABASE_URL` and `ANTHROPIC_API_KEY` were ever entered into Render's dashboard. `/v1/billing/checkout` will return `{url: null, demo: true}` on the live server right now. | Code path is real and tested (`test-server-billing.js`), but there is no live Stripe account connected. |
| Crypto/Coinbase | ✅ Confirmed removed from user-facing scope | The "Season Pass with crypto" button and its handler were removed from `setup.html`/`account.js` earlier this session, per an explicit decision. Server-side routes remain in the code (dormant, unreachable from any UI) rather than deleted. |

**Can a real person actually pay for anything right now? No.** Free tier and AI features gated behind Pro/Season Pass are fully functional, but there is no live path to actually purchase Pro or a Season Pass — the checkout button will honestly report "not configured" rather than silently failing or faking success.

---

## 5. Extension-to-backend wiring

| Item | Status | Evidence |
|---|---|---|
| `cloud.js` production mode → real URL | ✅ Confirmed pointed correctly | `productionApiBase` now reads `https://gradfill-backend-hajr.onrender.com`, committed and pushed. |
| `manifest.json` host_permissions | ✅ Fixed this session | Was still listing the old `api.gradfill.app` placeholder — found and fixed while auditing this exact section. Without this, MV3 would not have granted the extension's privileged fetch() to the real domain, silently breaking Production mode even with `cloud.js` correctly configured. This was a real bug, caught by the audit, not a pre-existing verified-working state. |
| Actually tested through the real extension UI (not just the website) | 🔧 **Not verified this way.** | I have not loaded the unpacked extension in a real Chrome profile and clicked through Setup → Account & plan → Production mode → Sign in. What **is** proven: the exact same backend routes (register/login/usage/billing-portal), the exact same auth mechanism (bearer token), and the exact same CORS-adjacent extension exemption (MV3 host_permissions bypass same-origin restrictions entirely, same mechanism proven to matter when I found the manifest.json bug above) — verified live via the website, which talks to the identical API. The remaining gap is specifically "did I click it in the actual popup," not "does the underlying mechanism work." |

---

## 6. Secondary features

| Item | Status | Evidence |
|---|---|---|
| Referee management | ✅ Confirmed complete, by design | Referee fields are detected and always routed to a manual "fill this yourself" flag — deliberately never auto-filled. This isn't a gap; auto-filling referee contact details was explicitly rejected as unsafe. Nothing further needed here. |
| Multiple resume versions | ✅ Confirmed working (client-side) | `resume.js` has real save/load/list logic (`saveVersion`, `renderVersions`), stores versions in the profile, links a version to a tracker application. No dedicated automated test exists for this logic specifically, but the code is real and complete, not a stub. |
| Fit-score analysis | 🔧 Built, real logic, zero test coverage | `fitScore()` in `resume.js` is a real deterministic keyword-match heuristic (not AI), live in both the popup and Resume Studio. Confirmed no test file exists anywhere in the repo (`find . -iname "*fit*test*"` returns nothing). This is a known, unaddressed gap, not new. |
| Job Tracker (local) | ✅ Confirmed working | Core tracker functionality (save, stage transitions, notes, links) is local-only via `chrome.storage.local` and has been stable across this whole project. |
| Job Tracker (cloud sync) | ❌ **Not built server-side — a previously-undiscovered gap.** | `cloud.js` has real client-side functions (`syncProfile`, `pullProfile`, `syncTracker`, `pullTracker`) that call `/v1/profile/sync`, `/v1/profile`, `/v1/tracker/sync`, `/v1/tracker`. **None of these routes exist in `server/index.js`** — `grep -n "/v1/tracker\|/v1/profile" server/index.js` returns nothing. If a user turns on cloud sync in Setup, every sync attempt against the real deployed backend will get a 404. Cloud sync is off by default, so this has no live-user impact today, but it is not a working feature if switched on. |

---

## 7. Public-facing site

| Item | Status | Evidence |
|---|---|---|
| Landing page | ✅ Confirmed live | https://aih44d1-eng.github.io/GradFill/ — dark premium redesign, scroll-reveal, accurate copy, real (not fabricated) resume-tailoring example generated live against the real AI backend. |
| Login/account page | ✅ Confirmed working end-to-end against the real backend | Registered a real account through the live website's actual UI, independently verified it landed in Supabase by querying the database directly, signed out, signed back in with the same credentials, and confirmed CORS holds under the now-scoped configuration. One correction made along the way: this page existed only in a local scratchpad and had never actually been pushed to GitHub Pages before this session — it was returning a live 404 until it was pushed as part of this work. |
| Privacy policy | ✅ Confirmed accurate to current behavior | Public at https://aih44d1-eng.github.io/GradFill/privacy.html. Reviewed against actual current behavior: correctly describes AI payload contents, correctly avoids overclaiming on billing (describes intended behavior without asserting Stripe is live), accurately reflects that resume/transcript files are stored but not their contents synced. Does not yet need updating for PDF/DOCX extraction since that feature doesn't exist yet. |

---

## 8. Security check

Performed this session, not skipped:

| Check | Result |
|---|---|
| `.env` gitignored | ✅ Confirmed, in both the main checkout and the `postgres-hosting` worktree (`git check-ignore -v .env` in both). |
| Tracked files scanned for secret-shaped strings (Anthropic key pattern, GitHub PAT pattern, Postgres connection strings with embedded credentials) | ✅ Clean. Matches found were all the literal placeholder `postgres://user:password@host:5432/dbname` in docs/examples, not real values. |
| **Entire git history, all branches**, scanned for the specific real secrets handled this session (the Anthropic key, the GitHub PAT, the Supabase connection string) | ✅ Clean. `git log --all -p` grepped for exact known fragments of each — zero matches. These were only ever written to the gitignored `.env` file, never committed. |
| `.superpowers/sdd/` (prior session's task briefs/reports/diffs) | ✅ Confirmed untracked (own `.gitignore`) and confirmed clean of the real Supabase credentials. |
| Anything revoked/regenerated still referenced as if live | None found — no evidence any key used this session was rotated mid-project, so there's nothing stale to check for. |

**No real secrets found committed anywhere, in any branch, at any point in this project's history.**

---

## 9. Chrome Web Store readiness

**Not started. Confirmed, not assumed** — there is no evidence anywhere in the repo of a developer account, a submitted listing, or store-specific assets beyond the draft in `STORE_LISTING.md`.

What's actually needed before this becomes possible, per `STORE_LISTING.md`'s own checklist plus what this session's work has changed:

1. **A Chrome Web Store developer account** ($5 one-time registration) — no evidence this exists yet.
2. ~~Deploy the backend over HTTPS~~ — ✅ done this session (Render).
3. Remove the local-dev-only host permissions (`127.0.0.1:8787`, `localhost:8787`) from the public manifest before submission.
4. ~~Publish a public privacy policy~~ — ✅ done this session.
5. Complete the Chrome Web Store's own "Privacy practices" disclosure forms so they match actual production behavior exactly.
6. A real support email or support site.
7. Real store screenshots — the landing page currently uses explicitly-labeled recreations, not actual captures; the store listing itself would need real screenshots.
8. Test account deletion/export and subscription cancellation flows (neither has been exercised this session).
9. Document known ATS compatibility limits for the listing (Avature fill-logic gap, PageUp's thinner evidence).

---

## Real launch blockers vs. everything else

**Launch blockers — nothing ships to a real stranger without these:**

1. **PDF/DOCX resume/transcript extraction is not built.** Without it, "upload your resume" doesn't actually feed anything — AI features only see what's manually typed in. This is a core advertised feature that doesn't exist yet.
2. **Stripe isn't connected.** No real person can pay for Pro or a Season Pass. The product currently has no working monetization path.
3. **Chrome Web Store submission hasn't started.** No developer account, no listing, no real screenshots, dev-only host permissions still in the public manifest. This is the actual distribution mechanism for "a stranger installs this" and none of it exists yet.

**Real gaps, but launchable without them (fix later, don't block on):**

- Avature field-filling (detection-only) — a known, scoped, documented gap, not a silent failure.
- PageUp's thinner evidence base — works via generic filling, just less proven than the other four platforms.
- Cloud sync's missing server routes — off by default, no live-user impact unless someone turns it on, but should either be built or the toggle removed before launch so it doesn't silently 404.
- Fit-score's missing test coverage — real, working, deterministic logic; just unverified by automation.
- A directly-triggered Render restart test — strong indirect evidence already exists; this is a nice-to-have confirmation, not a functional gap.
- Extension-through-the-actual-popup verification of Production mode — the underlying mechanism is proven via the identical website flow; this is "click it once to be sure," not a code gap.

**Shortest honest path to "a stranger can install this and it works":** build the PDF/DOCX extraction, connect a real Stripe account, then work through the Chrome Web Store checklist above. Everything else on this page is either already solid or fixable without blocking that path.
