# GradFill AI — v2.0.0

GradFill AI is a human-in-the-loop browser extension for graduate and job applications. One reusable profile powers application autofill, AI-assisted written answers, job-specific resume tailoring, and a job tracker.

**GradFill never presses the final Submit button.** The user reviews the application and submits it.

## What changed in v2

### One profile
Save contact details, education, work history, skills, languages, eligibility, preferences, STAR examples, custom answers, resume/transcript files and application history once. GradFill reuses that information across ATS platforms.

### Autofill is free, always, with no plan limit
The rules-based autofill (`rules.js` + `content.js`) is zero-marginal-cost pattern matching — no AI call, nothing to meter. It is never plan-gated, never counted against a quota, and never will be, along with the applications tracker and profile/setup. Filling a page, saving a job, and marking an application applied all work identically on Free and Pro.

MVP plans (AI features only — see below):
- **Free** — the full deterministic engine, tracker and profile, with zero AI
- **Pro** — A$20/month, unlocks AI resume tailoring, cover letters and drafted written answers
- **Grad Season Pass** — A$45 for 90 days, same AI entitlement as Pro as a one-off pass instead of a subscription

Billing is monthly or as a fixed-length season pass — never weekly. (An earlier build of this extension billed Pro at A$15/week; that was reverted deliberately — weekly billing was the single most consistently-named complaint across competitor research, and gating the free autofill engine itself behind a daily quota entangled a zero-cost feature with the paid tier for no reason.)

### AI written-answer drafting
Written questions stay human-controlled. From an indigo/write item you can:
1. copy a structured prompt for use elsewhere, or
2. click **Draft with AI**.

The AI draft is shown inside GradFill first. You can edit it, save it to your answer library, copy it, or explicitly click **Insert into form**. It is never silently submitted.

The production AI payload is deliberately restricted to career-relevant profile facts: education, experience, skills, languages, preferences and STAR examples. Demographic/accessibility fields are not included in the default AI payload.

### Resume Studio
Open **AI Resume** from the popup or **Tailor resume** from a tracker entry. GradFill reads the role/job description when possible and produces an editable ATS-friendly draft.

The model is instructed to:
- use only facts in the saved profile
- never invent achievements, metrics, employers, dates, qualifications or skills
- reorder/emphasise truthful material for the target role
- surface matched skills and job-description terms for review

Save multiple versions. A version can be linked back to the tracker entry that used it.

### Job Tracker
The tracker is now a dedicated page rather than a spreadsheet-like list buried in setup.

Stages:
- Saved
- Applying
- Applied
- Assessment
- Interview
- Offer
- Rejected
- Withdrawn

Each role can keep the company, title, location, employment type, closing date, source, link, matched/key skills, job-description snapshot, notes, date applied and resume version used.

The popup can **Save job** before applying and **Mark applied** afterwards. Existing saved jobs are updated instead of intentionally creating a second record when company/role or link match.

### Account, cloud sync and monetisation architecture
The extension supports three connection modes under **Details → Account & plan**:
- **Offline demo** — no network traffic; local-only quotas and a deterministic resume/draft demo
- **Local backend** — connects to `http://127.0.0.1:8787` for real OpenAI/Stripe integration testing
- **Production** — connects to `https://api.gradfill.app`

Cloud sync is opt-in. The profile sync strips the base64 contents of the saved resume and transcript before sending the profile to the server.

## Important: API secrets are not in the extension

Do **not** put an OpenAI API key or Stripe secret into `popup.js`, `cloud.js`, the manifest, or any other extension file. Any user can inspect a Chrome extension package.

The production flow is:

```text
Chrome extension
      |
      | HTTPS + user session token
      v
GradFill backend
      |\
      | \---- Stripe hosted checkout / subscription webhook
      |
      \------ OpenAI Responses API
```

The companion backend package included with this delivery implements the local version of that architecture.

## Priority ATS compatibility (Australia)

GradFill now has first-class host access and compatibility handling for three high-priority third-party application platforms commonly encountered by Australian candidates:

- **Workday** — `*.myworkdayjobs.com`, `*.myworkdaysite.com`, and `*.workdayjobs.com`
- **PageUp** — `*.pageuppeople.com` (including `careers.pageuppeople.com` and `secure.dcN.pageuppeople.com`)
- **SAP SuccessFactors Recruiting** — `*.successfactors.eu`, `*.successfactors.com`, and `*.sapsf.com`

The compatibility layer uses visible labels first, then standards-based `autocomplete` semantics and platform identifiers such as Workday `data-automation-id`, SAP field IDs, and PageUp-generated control IDs. Repeating work experience, education and language sections are kept record-consistent. GradFill still never presses Submit.

## Testing the extension

Chrome's **Load unpacked** button expects a folder, not a zip file.

1. Unzip `GradFill_AI_v2.0.0.zip`.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the unzipped `GradFill_AI_v2.0.0` folder.
6. Complete **Details**.
7. Open `test-form.html` or a real application page and click **Fill this page**.

The zip itself is the format you can upload to the Chrome Web Store developer dashboard after you have completed the production/privacy requirements below.

## Testing real AI locally

Use the companion backend package:

1. Unzip `GradFill_AI_Backend_v2.0.0.zip`.
2. Copy `.env.example` to `.env`.
3. Add your server-side `OPENAI_API_KEY`.
4. Run `npm install` and `npm start`.
5. In GradFill open **Details → Account & plan**.
6. Choose **Local backend**.
7. Create an account/sign in.
8. Use **Draft with AI** or **AI Resume**.

The local server defaults to `127.0.0.1:8787`.

## Testing Pro / Season Pass (monthly and 90-day, never weekly)

Offline demo mode has a **Developer test plan** dropdown (Free / Pro / Grad Season Pass) so you can switch between plan UI and AI entitlement without a payment provider. This is deliberately not a production entitlement mechanism — `cloud.js`'s `canUseAI()` gate is a client-side convenience check for UX only; it can be skipped or patched out client-side, so it is never the real enforcement.

Real enforcement lives in `server/index.js` — a minimal reference backend (Node built-ins only, `node server/index.js` to run it on `127.0.0.1:8787`). Every `/v1/ai/*` route re-derives the caller's plan and remaining monthly quota from its own in-memory account store (keyed by bearer token) before calling any AI provider, and never trusts a client-asserted `plan`/`aiEnabled`/`entitlement` field in the request body. Run `node test-server-enforcement.js` to see this proven against a real HTTP server: an unauthenticated request gets 401, a free-plan token gets 402 `paywall` even while the request body claims Pro entitlement, and a genuinely-Pro token still gets capped at 402 `quota` once its real monthly usage runs out.

## Billing: what's real versus stubbed, today

Until this pass, `/v1/billing/checkout` and `/v1/billing/portal` **did not exist as server routes at all** — `cloud.js`'s `checkout()`/`billingPortal()` called them anyway and got a plain 404. Clicking Upgrade did nothing but show an error toast. That's fixed: both routes exist now and are wired to real Stripe REST calls (plain `https`, no Stripe SDK, consistent with this file's "Node built-ins only" rule) — but **this repo still ships with no live Stripe account configured**, same as it ships with no live Google Places key. Nothing charges real money until you set the environment variables below on the server that's actually running.

**Stripe (primary path):**
1. Create two Stripe products: `GradFill Pro` (recurring **monthly** AUD $20.00) and `GradFill Grad Season Pass` (one-off AUD $45.00).
2. Put their `price_...` IDs into `STRIPE_PRICE_PRO_MONTHLY` / `STRIPE_PRICE_SEASON_PASS`.
3. Set `STRIPE_SECRET_KEY` and configure a webhook endpoint at `/v1/billing/webhook` pointed at Stripe's `checkout.session.completed` and `customer.subscription.deleted` events; put its signing secret into `STRIPE_WEBHOOK_SECRET`.
4. `GFCloud.checkout("pro"|"season")` opens Stripe-hosted checkout; the webhook (signature-verified, `test-server-billing.js` proves this against forged/valid signatures) is what actually grants the plan server-side — never the checkout-creation call itself, since that only proves intent to pay, not payment.

**Crypto, via Coinbase Commerce (disabled for launch — Stripe is the only payment path in the product right now; the Setup page has no crypto button and the code below is dormant, kept for a later re-add once Stripe is fully confirmed live):**
1. Set `COINBASE_COMMERCE_API_KEY` from your Coinbase Commerce account.
2. Configure a webhook endpoint at `/v1/billing/crypto/webhook`; put its shared secret into `COINBASE_COMMERCE_WEBHOOK_SECRET`.
3. `GFCloud.cryptoCheckout("season")` opens a Coinbase-hosted charge page. The plan is granted only on the `charge:confirmed` event — never on `charge:pending` (payment seen on-chain but still confirming — can take longer than a card payment) and never on an `UNRESOLVED` charge (Coinbase's own status for underpaid/overpaid/delayed — wrong amount is treated the same as unpaid, not partially honoured).

**Why crypto is Season-Pass-only, not a drop-in replacement for Pro's checkout:** a Coinbase Commerce charge is a one-off blockchain payment; nothing about it can be "charged again" automatically the way a Stripe subscription renews itself. Offering "Pro via crypto" without also building a recurring re-invoice/reminder flow would mean it silently lapses every 30 days — worse than not offering it. Server-side, `/v1/billing/crypto/checkout` refuses `plan: "pro"` with a 400, and the crypto webhook handler refuses to grant any plan outside `{ season }` even if a charge's metadata somehow said otherwise.

**Refunds differ by path, deliberately:** a Stripe refund reverses to the original card automatically. Coinbase Commerce has no automatic refund mechanism — reversing a crypto payment means manually sending crypto back, and only if the customer supplied a refund address at payment time. (This distinction will need to be surfaced in the UI again once crypto checkout is re-enabled post-launch.)

Both webhook routes verify a real cryptographic signature (Stripe's `t=...,v1=...` HMAC scheme; Coinbase's plain hex HMAC) before touching any account — an unsigned or forged request is rejected at 400, proven in `test-server-billing.js` with a deliberately-wrong signature.

Production quotas — and now production plan grants — are enforced by the backend from its own webhook-verified state, not by browser storage or by trusting the checkout-creation response.

## Current plan limits

| Capability | Free | Pro / Season Pass |
|---|---:|---:|
| Autofill (Fill this page) | Unlimited | Unlimited |
| Applications tracker | Unlimited | Unlimited |
| AI drafted answers | 0/month | 200/month |
| AI resume tailors | 0/month | 40/month |
| AI cover letters | 0/month | 40/month |
| Account/profile sync | Yes when enabled | Yes when enabled |

Autofill and the tracker are never plan-gated — there is no limits row for them because there is no limit. Only the three AI actions are metered, per calendar month, on both Pro and the Season Pass. These are MVP values, defined once in `cloud.js`'s `PLAN_DEFS` and enforced again independently by the backend (`server/`) — change both together before launch if you want different economics; the server's copy is the one that actually protects your API spend.

## How the existing autofill works

GradFill scans application controls and resolves a field from:
- its real label
- ARIA labels
- placeholder/name/id/data automation identifiers
- nearby question text and section context
- block context for repeated work/education records

It supports normal inputs/selects/textareas, contenteditable rich-text fields, iframes, open Shadow DOM and several custom dropdown patterns already added in earlier versions.

Highlights:
- **Green** — confident fill from saved profile
- **Amber** — user should check/complete
- **Indigo** — written question; user or AI draft required

Sensitive fields, declarations and final submission stay under the user's control.

## Resume upload limitation

GradFill keeps a saved resume/transcript one click away and can create reviewed tailored text versions, but the extension does not silently set browser file-upload controls. Attach the final file yourself on the application form.

## Privacy and Chrome Web Store publication

`privacy.html` is an in-extension summary for testing. A public Chrome Web Store release still needs a hosted privacy-policy URL describing the data you actually collect, transmit, store, retain and delete.

Before publishing:
- deploy the backend on HTTPS and replace/configure `api.gradfill.app`
- configure secure production database/backups and account recovery
- configure Stripe production checkout/webhooks
- publish privacy policy and terms
- complete Chrome Web Store data-use disclosures
- disclose AI/profile/job-page data transmission clearly before collection
- keep permissions to the minimum actually used
- do not add remotely hosted executable JavaScript; API JSON requests are separate from remote code execution
- add account deletion/data export processes
- add abuse/rate monitoring and support contact information

## Naming

This build is named **GradFill AI**. It can accurately state in its description/site that AI features use the OpenAI API once that backend is configured. Do not put an OpenAI secret key into the client.

## Files added in v2

```text
account.js       account/plan controls
cloud.js         plans, quotas, API client, sync and offline demo logic
tracker.html/js/css
resume.html/js/css
privacy.html
```

The original autofill engine remains in `rules.js` and `content.js`.


## One-click background sections

On supported ATS pages, **Fill this page** now tries to open collapsed Work Experience, Education and Language sections, click their safe **Add** controls and populate the new fields in the same run. Derived values such as a broad education category are allowed to fill automatically, but are shown yellow because they were inferred rather than explicitly saved. For example, a saved Bachelor degree can derive **Academic** for a `Type of Education` dropdown.

### SuccessFactors one-click background sections

On SAP SuccessFactors, **Fill this page** now treats Work Experience, Education and Language Skills as background sections rather than ordinary fields. GradFill opens collapsed accordions, clicks **Add** where a saved record exists, waits for the row to appear, and fills the row in the same action. If a platform requires a full date but your profile only stores a month/year, GradFill uses the first day of that month and marks the result for review instead of silently pretending the day was known.

Education fields may also be broader than your saved wording. For example, a university Bachelor degree can imply **Academic** / **University**, and Cybersecurity can map to a broader IT/Computing study area. Derived values are always reviewable rather than treated as facts.
