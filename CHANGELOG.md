# Changelog

## 2.14.0

Fixes three real bugs found by the full field-by-field audit of CSIRO's live SuccessFactors Candidate Profile in the previous pass — genuine algorithmic bugs, not CSIRO-specific tuning — plus one new detection gap the same audit surfaced. All four proven against `csiro-fill-fixes-test.html` (new), a fixture combining the real captured DOM shapes for every fix; the two structural fixes were additionally reverted and re-confirmed broken before being restored, to prove the fixture is a genuine regression test.

- **Fixed: a "check" (yellow) dropdown status no longer means "we didn't actually do anything."** `resolvePendingAccessibleCombos()` and `resolvePendingMatSelects()` both had a real gap: the report entry pushed *before* the async fill attempt ran (optimistically "check", *"GradFill will try to commit the matching option"*) was never revisited when that attempt genuinely failed to find a real option to click — confirmed live on CSIRO, where every `role="combobox"` field (Qualification Type, Educational Institute, Nationality, Gender, Legal right to work, Willing to relocate, and others) reported yellow with a value while the actual widget stayed completely blank. Both functions now have a real failure branch: on a genuine commit failure, the entry is downgraded to `"prompt"` (red/blank) with an honest "couldn't confirm it committed, choose it yourself" note, never left as a stale yellow claim.
- **Fixed: Home/Work phone no longer silently inherits Mobile with zero warning.** The `phone` rule matched any field containing the word "phone," and the profile only ever stores one number — filling a Home- or Work-specific field with the saved Mobile number is a guess, not a fact. It's still filled (per the accepted tradeoff of not leaving genuinely-answerable fields blank), but now carries a `"check"` flag naming the mismatch whenever the field asks for a specific type that doesn't match the saved `phoneType`. Caught and fixed a bug in the fix itself along the way: the flag function's own type-detection needed to key off `f.own`, not `f.haystack` — CSIRO's Mobile/Home/Work labels are `<label for="...">` siblings rather than wrapping labels, which `looksLikeOrdinaryFieldLabel()` doesn't recognise as a field label to skip, so the *neighbouring* field's own label text was leaking into `f.context` and contaminating the type check.
- **Fixed: `assignBlocks()` no longer lets a later, unrelated section silently inherit an earlier block's record.** `collectMarkers()` concatenates two separate `querySelectorAll` passes (semantic heading tags first, then plain div/span/p `GF.BLOCK_RE` matches second) with no positional relationship between them, and the block-resolution logic just took the *last* marker in that array preceding a field — not the *closest* one. Confirmed live: CSIRO's "Education"/"Previous Employment" headers are plain `<div>`s (caught only by the second pass, landing at the end of the array) while every later section ("Relocation," "Declaration," etc.) is a `<b>` tag (caught by the first pass, earlier in the array) — so "I would be relocating from:," many sections after Education, still matched the Education block's bare `from` rule and got confidently (green!) filled with a formatted date. `assignBlocks()` now sorts all markers into real document order (via `compareDocumentPosition`) before any block-resolution logic runs.
- **Added: file-upload buttons that aren't a real `<input type="file">` are no longer invisible to the report.** Confirmed live: CSIRO's "Upload a CV" and "Attach a Cover Letter" controls are `<div role="button">` elements — there is no `<input type="file">` anywhere in the DOM for `collect()`'s existing file-type branch to find, so these two *required* fields got zero acknowledgement anywhere in the report, not even the "attach this yourself" note a real file input already gets. New `collectAttachmentButtons()` matches on upload/attach vocabulary (further classified as resume/cover-letter/transcript/other, reusing the same wording as the existing file-input branch) and reports each as a `"check"` reminder.

## 2.13.0

- **Avature and Oracle Fusion Cloud Recruiting added to `manifest.json`'s `host_permissions`/`content_scripts.matches`** (`https://*.avature.net/*`, `https://*.oraclecloud.com/*`) — the gap flagged in 2.12.0. Re-verified live afterwards, not just assumed fixed:
  - **Oracle: genuinely fixed.** Both Westpac (`ebuu.fa.ap1.oraclecloud.com`) and South Lanarkshire Council (`fa-euuc-saasfaprod1.fa.ocs.oraclecloud.com`) are raw (non-proxied) tenant hosts — confirmed live, both match the new permission directly, both still show the `oj-`/`static.oracle.com` fingerprint too.
  - **Avature: the manifest change does NOT fix Macquarie or Siemens**, and it's important not to claim otherwise. Traced both companies' real, full apply flows live: `recruitment.macquarie.com` and `jobs.siemens.com` stay on their own vanity domain through login/registration — never redirect to `avature.net` at any point, unlike SuccessFactors' CSIRO case where the apply flow happened to land back on a raw host. Adding `avature.net` only helps the minority of Avature customers who never vanity-fronted their tenant; it does nothing for the two customers the existing code comments cite. A real fix needs either an explicit list of known vanity domains or a runtime "grant this site" permission flow — not built this pass, flagged instead of quietly building it without discussion.
- **SuccessFactors Title/School/Degree fixes re-checked against CSIRO's real, logged-in Candidate Profile** (not just the sign-in wall, past that as of this pass) — genuinely different company data from EY, not a re-run of the same fixture:
  - **Position Title** — matches correctly. CSIRO's field is labelled "Position Title" (not EY's bare "Title"), which the existing `title` rule already covers by design; this exercises the general rule, not the bare-label dead-anchor fix specifically.
  - **Qualification Type** (CSIRO's equivalent of EY's "Degree" picker) — matches correctly, filled with the qualification level ("Bachelor Degree"), not the full award name. Worth being precise about *why*: this goes through the dedicated `qualificationType` rule (already in `rules.js`, checked ahead of the generic "degree" rule), not through the `bareLabelIs`-gated fix built for EY's literal bare "Degree" label — a different rule reaching the same correct outcome, not confirmation of the same code path.
  - **Educational Institute — found a real, previously-unknown bug.** Neither `institution` rule recognised "Institute" as a synonym for "Institution" (different words, not a typo of each other) — confirmed by testing the actual regex against CSIRO's live field before touching anything. Without the fix, a fixture built from CSIRO's exact captured DOM shape (`csiro-institute-test.html`, new) didn't just leave the field blank — it filled it with `"Bachelor Degree"` (the qualification-level value bleeding over from a fallback match), which is worse than empty. Fixed by adding `institute`/`institute name`/`educational institute` alongside the existing `institution` wording in both the general and education-block-scoped rules. Verified fixed live in-browser (not just via regex), then deliberately re-broken and re-confirmed broken, then re-fixed and re-confirmed fixed, to prove the fixture is a genuine regression test and not one that would have passed regardless. Existing `successfactors-degree-test.html` and `anchor-audit-test.html` (EY's shapes) re-run afterwards with no regressions.

## 2.12.0

- **Billing is now genuinely wired — it wasn't before.** Verification this session found `checkout()`/`billingPortal()` in `cloud.js` were calling `/v1/billing/checkout` and `/v1/billing/portal`, routes that **did not exist** in `server/index.js` at all (confirmed live: both 404'd; clicking Upgrade just produced an error toast). This is a bigger gap than the AI routes ever had — those at least had a `stubProvider` fallback. Both routes now exist, backed by real Stripe REST calls (`https` built-in, no SDK). As before, no live Stripe account ships with this repo — set `STRIPE_SECRET_KEY`, `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_SEASON_PASS`, `STRIPE_WEBHOOK_SECRET` to make it real; unconfigured, checkout now returns an honest `{ url: null, demo: true }` instead of either crashing or fabricating a fake checkout link.
- **Plan grants now come from the Stripe webhook, never from the checkout-creation call itself** — `POST /v1/billing/webhook`, signature-verified against Stripe's real `t=...,v1=...` HMAC scheme (a forged/unsigned request is rejected at 400). `checkout.session.completed` grants the plan named in its own metadata to the account that started that checkout; `customer.subscription.deleted` downgrades back to free. Proven against real HTTP requests with real computed signatures in new `test-server-billing.js`, not by inspection.
- **Added Coinbase Commerce as an additional payment path — crypto, additive to Stripe, never a replacement.** `GFCloud.cryptoCheckout("season")`, `/v1/billing/crypto/checkout`, `/v1/billing/crypto/webhook` (signature-verified with Coinbase's own hex-HMAC scheme). Deliberately **Season Pass only, refused for Pro server-side with a 400** — a Coinbase Commerce charge is a one-off blockchain payment, and nothing about it can auto-renew the way a Stripe subscription does; offering "Pro via crypto" without a separate re-invoice flow would mean silent, unannounced lapse every 30 days.
  - The plan is granted only on Coinbase's `charge:confirmed` event, never on `charge:pending` (still confirming on-chain — can take longer than a card payment) or an `UNRESOLVED` charge (Coinbase's term for underpaid/overpaid/delayed — treated as simply not paid, never partially honoured).
  - A charge whose metadata somehow claims plan `"pro"` is still refused server-side even on `charge:confirmed` — the eligibility check runs again at grant time, not just at checkout-creation time.
  - Refunds are explicitly **not** symmetric between the two paths: Stripe reverses to the original card automatically; Coinbase Commerce has no automatic refund mechanism (manual, wallet-address-dependent), and the Setup page says so next to the crypto button rather than implying parity.
- **The Season Pass now actually expires.** Previously nothing enforced its 90-day boundary — once `planId` was set to `"season"` it stayed that way indefinitely, from either payment path. `planFor()` now checks a stored `planExpiresAt` and falls back to Free once it's passed, checked at read time (not a background sweep). Also fixed: the server's own copy of `PLAN_DEFS.season` was missing the `seasonDays: 90` field entirely (only `cloud.js`'s UI-facing copy had it) — the expiry math was silently computing `Date.now() + NaN` until this pass added it, caught by the new test suite rather than by inspection.
- **SuccessFactors fixes re-verified live against a second, unrelated company (CSIRO), not EY.** The vanity-domain Career Site Builder fingerprint (`coreCSB` class + SF-hosted asset check) was run directly against `jobs.csiro.au` and correctly identified it as SuccessFactors despite the non-`successfactors.com` hostname — genuine evidence the detection generalizes, not EY-specific tuning. Stopped at CSIRO's real sign-in wall (`career10.successfactors.com/careers?company=CSIRO`) per instruction not to create an account, so the bare-label ("Title"/"School") and Degree-picker field-matching fixes remain confirmed on EY's data only, not re-confirmed here — that distinction matters and shouldn't be flattened.
- **Found, not yet fixed: Avature and Oracle Fusion Cloud Recruiting support is currently unreachable in the packaged extension.** `manifest.json`'s `host_permissions` and `content_scripts.matches` list only `myworkdayjobs.com`/`myworkdaysite.com`/`workdayjobs.com`, `pageuppeople.com`, and `successfactors.com`/`.eu`/`sapsf.com` — `avature.net` and `oraclecloud.com` are absent from both, confirmed by grep, with no `optional_host_permissions` or runtime `chrome.permissions` request anywhere to compensate. That means the Avature and Oracle detection/field-matching code already in `rules.js` cannot currently be injected by Chrome on `recruitment.macquarie.com`, `jobs.siemens.com`, or any Oracle-fronted host — the changelog's earlier "confirmed live on Macquarie/Siemens/Westpac" claims for those two platforms reflect the JS logic tested directly, not the packaged extension actually running there. Left unfixed pending a decision on widening extension permissions, since that's a scope change, not a bug fix.

## 2.11.0

- **Address autocomplete on Setup, server-proxied — no Google key anywhere in the extension.** Typing a street address now shows live suggestions and fills street/suburb/state/postcode/country from the selection, but the Google Places key itself lives only in `server/index.js` (`GOOGLE_PLACES_KEY`, read once from `process.env.GOOGLE_PLACES_API_KEY`), never in extension code. Two new authenticated routes, `GET /v1/places/autocomplete` and `GET /v1/places/details`, gated the same way every other backend call is (`authenticate()` — any signed-in account, not paid-tier-only, so it isn't an open proxy) but *not* metered through `chargeAI()`, since this is deterministic address lookup, not generative AI. With no key configured (this repo's default), both routes fall back to a small fixed set of real Australian addresses — same shape as the existing `stubProvider` pattern for AI — so the routes are provably wired end-to-end without needing a live Google key in every environment. Client-side debounced 350ms in `attachCombobox()` (setup.js) before firing a request.
- **University autofill from a bundled, free dataset — no live API, no per-keystroke network cost.** Selecting or typing a real university fills country (and, where the dataset has it, state/territory into the location field) instead of asking for those separately. Uses `universities.json`, trimmed from Hipo's `university-domains-list` (MIT-licensed, actively maintained) to just name/country/state — 10,240 entries, 595KB, bundled with the extension, looked up locally with zero network calls. Confirmed 59 real Australian institutions present (every Group of Eight member, every major regional/ATN university, several TAFEs), 53 of them with state-province populated.
- **General polish pass on Setup**, aimed specifically at places free text could silently break GradFill's own matching engine later:
  - Country, State/Territory (About You) and Degree Level, Institution Country, Employer Country (Study/Experience) are now dropdowns instead of free text. State/Territory covers the 8 AU states/territories with an "Other (type it in)" escape hatch for overseas addresses, rather than forcing a wrong answer into a bounded list that doesn't fit.
  - Fixed a real bug this surfaced: an unset `<select>` silently displays its first option in the browser (e.g. a blank Degree Level would have shown "High School", a blank State would have shown "NSW") without that value ever actually being written to the profile — visually misleading even though the underlying data stayed correct. Every new bounded-list field now gets an explicit blank placeholder unless a field already has a genuine universal default (Country → Australia, matching the existing `EMPTY.personal.country` default).
  - "About You" split into Personal / Contact / Address / Online presence subheadings instead of one 17-field block.
  - Inline validation: required-field markers on First name/Last name/Email, live email-format checking, both flagged on blur rather than only discoverable at some later "save" moment that doesn't really exist here (everything already autosaves).
  - The "Saved" indicator now stays visible once shown (was a 1.4s flash easy to miss) and reads "Saving…" → "Saved" around the debounced write; a first-load "Loaded from last session" message appears when real prior data is found in storage, as concrete evidence persistence is actually working rather than an abstract claim.
  - Dates were already using native pickers (`type="date"` for DOB, `type="month"` for education/experience/application dates) — confirmed still correct, no change needed there.

## 2.10.0

- **Fixed a systemic dead-anchor bug found by auditing every `^...$` whole-string regex in `rules.js` after it hit twice in one pass.** `resolveInBlock()`/`matchOn()` always test a rule's `re` against `f.own` — but `describe()` always appends placeholder/title/autocomplete/id/name text after the label prose when building `f.own`, so a rule written as `^word$` (intended to mean "this field's label is literally just that one word") could never actually match once any of that trailing text was present. In practice that was every field on a real ATS with a generated id (`171:_txtFld`, `VFLD3`, and similar SAP Career Site Builder patterns) — the anchor was dead code, not a narrow miss. Confirmed live twice on EY's real SuccessFactors Candidate Profile before the pattern was treated as systemic: a bare **"Title"** field in Work Experience was getting filled with the employer name instead of the job title, and a bare **"School"** field in Education wasn't matching at all. A full audit of every anchored rule in the file found and fixed six more of the same shape: experience and education `from`/`to`, the languages `proficiency` fallback, and the address `street` field — all converted from a dead whole-string anchor to a plain unanchored word, scoped safely by the block system they already run inside.
- **Fixed the SuccessFactors "Degree" picker returning the wrong kind of value.** A `role="combobox"` custom dropdown (confirmed live on EY: `aria-label="Degree"` duplicating a wrapping `"* Degree"` `<label>`) wants a qualification **level** (e.g. "Bachelor Degree"), not the full award title — the code to tell the two apart already existed but its own internal anchor check (also tested against `f.own`) was equally dead, so it silently fell back to the full degree name every time. Added `GF.bareLabelIs(f, word)`, a small helper that checks the field's clean `f.label` instead (collapsing an immediate word repeat and stripping placeholder-ish filler), and used it for this specific level-vs-name disambiguation.
- **Fixed a real Workday education field that never matched at all.** Telstra's live "My Experience" step has a bare-YYYY graduation-year input labelled `"To (Actual or Expected)"` (id containing `lastYearAttended`) — the trailing `(Actual or Expected)` text broke the old bare "to" anchor, and a *second*, independent bug meant that even a correct label match would have produced a garbled date: `GF.formatDate()`'s bare-year branch checked `^yyyy$` against the full `dateFormatHint()` blob, which (like `f.own` above) always also carries the label text, so it could never equal exactly `"yyyy"`. Fixed to check the input's own `placeholder` directly instead. Both proven with a fixture reproducing the real id/label/placeholder shape: now fills a clean `2026`, not `06/2026`.
- **Fixed a missing plain word, not an anchor bug.** Regression-testing the fixes above against `test-form.html` surfaced a bare **"Company"** field (no "name" suffix) that the `employer` rule didn't match at all — confirmed the same wording is real on Workday's own live Work Experience panel (Telstra: label `"Company*"`). Added as a plain unanchored word alongside "company name"/"employer"/etc.
- Every fix above proven with a fixture reproducing the real field shape (id, name, label, and where relevant `role`/`placeholder`) rather than by inspection alone — `successfactors-title-test.html`, `successfactors-degree-test.html`, `workday-education-test.html`, and `anchor-audit-test.html` (new) join the existing `oracle-recruiting-test.html`, `avature-test.html`, `workday-test.html`, `successfactors-test.html`, `successfactors-vanity-test.html` and `test-form.html` as a full regression set; all ten were re-run against the final `content.js`/`rules.js` with no regressions.
- **Oracle Fusion Cloud Recruiting** field-level matching landed this cycle too: `employerCountry` (a dedicated field separate from Employer City), the real "Current Job"/"Current Employer" checkbox wording, splitting Responsibilities from Achievements so saved description text no longer duplicates into both, a GPA/WAM fallback for the combined "University GPA/WAM" field, and — the bigger piece — new support in `collect()`/`describe()`/`fillRadio()` for `aria-pressed` toggle-button controls (confirmed live on Westpac: Title, the investigation Yes/No declaration, and every Language proficiency selector are all real `<button>` elements, invisible to the fill engine until now).
- **Avature platform detection added** (`GF.ATS_PLATFORMS` + a `templates-static-assets.avacdn.net` asset-host fingerprint for the common vanity-domain case), confirmed live against two unrelated real customer instances (Macquarie, Siemens) serving the identical CDN asset host behind different vanity fronts. Detection only — field-level matching for the deep background form is still pending real account access.
- **Fixed a second real honeypot miss, this time on Workday.** Telstra's real "Create Account" step has a bot-trap input (`name="website"`, labelled *"This input is for robots only, do not enter if you're human"*) sized 1px by ~0.01px — not exactly 0×0, so `collect()`'s old exact-zero size filter missed it, and its label text happened to match the `portfolio` rule. Filter now treats any near-zero rendered area as hidden, not just an exact `0 × 0` rect.

## 2.9.0

- **The free/paid split is now enforced where it was previously entangled.** `reserveApplication()` — a daily quota that blocked the deterministic **Fill this page** action and **Mark applied** once a free-plan user hit their "1 assisted application/day" cap — is removed entirely. Autofill, the tracker, and profile/setup have never actually cost anything to run (`content.js`/`rules.js` do pure pattern matching, no AI call); gating them behind a plan limit was a real bug against the free/paid boundary this extension is supposed to keep, not a deliberate business decision. Filling and tracking now work identically on every plan, including no account at all.
- **Only genuinely generative AI is paid**, all metered through one new gate, `GFCloud.canUseAI()`: resume tailoring, the new cover letter generator, and drafted answers to open-ended questions. The existing "Copy prompt" hand-off (`buildPrompt`/`buildPromptWithValues` in `content.js`) — which only assembles a text prompt for the user's own outside AI conversation, no API call — stays free and unchanged; the new paid cover-letter feature is a sibling to it, not a replacement.
- **Added AI cover letter generation** (`GFCloud.aiCoverLetter`, wired into Resume Studio). Same shape as resume tailoring: an offline heuristic draft in demo mode, a server call in local/production mode, always reviewable before use, never auto-inserted or auto-sent anywhere.
- **Billing moved from weekly to monthly, plus a season pass.** Pro was previously A$15/week — the single most consistently-named billing complaint in the competitor research this pass was built against. Pro is now A$20/month; a new Grad Season Pass (A$45 / 90 days) covers someone who only needs GradFill for one application season rather than a standing subscription. `GFCloud.checkout(planId)` now takes an explicit plan (`"pro"` or `"season"`) rather than assuming one weekly product.
- Usage reporting (`GFCloud.usage()`) dropped the "applications" quota concept entirely and now reports only the three metered AI actions, per calendar month.
- **Pricing cross-checked against `gradfill-competitive-research.pdf` directly** (not just the summary of it): Pro moved from A$19/month → **A$20/month** (the midpoint of the PDF's recommended $15-25/month band) and the season pass from A$49 → **A$45/90 days** (A$15/month equivalent — the floor of that same band, deliberately the "undercut" option). Both were already directionally right; these are refinements against the actual document, not corrections.
- **Added `server/index.js` — server-side enforcement of the AI paywall.** `canUseAI()` in `cloud.js` was a client-side check only: nothing stopped a request that skipped the extension's JS and called `/v1/ai/*` directly with a valid-but-free-plan token, optionally claiming Pro entitlement in the request body. The reference server now re-derives the caller's plan and remaining monthly quota from its own account store on every AI call, before any provider call happens, and never reads any client-asserted `plan`/`aiEnabled`/`entitlement` field from the request body. `test-server-enforcement.js` proves this against a real local HTTP server: an unauthenticated request is 401, a free-plan account is 402 `paywall` even when the request body spoofs Pro entitlement, and a genuinely-Pro account still gets capped at 402 `quota` once its real monthly usage (tracked server-side, not client-reported) is spent.

## 2.6.0

- **SuccessFactors accordion handling is now much more aggressive and reliable.** `Fill this page` recognises plain clickable section headers such as **Work Experience**, **Education**, and **Language Skills**, opens collapsed sections, waits for the UI to render, clicks each section's **Add** control, and repeats the cycle so all saved background records can be created from one Fill action. This specifically addresses SuccessFactors headers whose arrow/header is a plain div rather than a semantic button.
- **SuccessFactors full-date handling fixed.** Background-element Start/End Date fields that require `MM/DD/YYYY` now receive a complete date. When GradFill only knows month/year, it uses the first day of that month (for example `2023-02` becomes `02/01/2023`) and marks the field yellow because the day was inferred. Field hints such as `expected MM/DD/YYYY`, placeholders and ARIA help text take priority over platform defaults.
- **Education pickers are now block-aware even when implemented as custom comboboxes.** Custom dropdowns are assigned to the same Education/Experience/Language record as ordinary inputs before matching, fixing partial SuccessFactors education fills.
- **Added education inference for common SuccessFactors fields.** `Type of School / Academic Institution` can derive **University** from a tertiary degree; `Main Area of Education` uses the saved major and can map Cybersecurity to a broader IT/Computing option; a bare Degree dropdown prefers the saved qualification level such as **Bachelor Degree** rather than the full award title. All inferred values are yellow for review.
- **Generic Grade fields now use the saved WAM/GPA.** A free-text Grade field receives the saved figure (for example `73.89`). If the form offers named bands instead, GradFill can map a WAM to High Distinction / Distinction / Credit / Pass / Fail as a reviewable fallback.
- **Improved dropdown matching synonyms** for University / Academic Institution and related institution categories.

## 2.5.0

- **One-click section opening for SuccessFactors-style applications.** `Fill this page` now opens collapsed Work Experience, Formal Education and Language Skills sections before looking for their Add controls, so the user should not have to manually open a section first.
- **Add controls are discovered after an accordion opens.** GradFill waits for the ATS to render the section, then clicks the appropriate Add control and scans the newly-created fields in the same Fill run. A guarded retry catches slow-rendered Add controls without double-clicking modal-style editors.
- **Derived education category.** Broad fields such as `Type of Education` can now be inferred from the saved qualification. A Bachelor/Master/Doctor/university qualification derives `Academic`; TAFE/VET/trade/certificate/diploma derives `Vocational`; school-level study derives `School`. Because this is inferred rather than explicitly stored, it fills **yellow/review**, not green.
- **Generic Grade fields now use saved academic results.** GradFill prefers WAM, then GPA, then honours/result text. Generic Grade remains yellow where the form does not explicitly say which grading system it expects.
- **Inferred dropdown values are now actually selected.** Previously, a rule carrying a review flag could display the right inferred answer in the report but deliberately skip custom dropdown selection. Derived values now fill the dropdown and remain yellow for review.
- **Broader Add-button wording.** Covers `Add another education`, `Add new language`, `Add qualification`, and similar safe background-row controls while still excluding submit/save/continue/delete actions.

## 2.4.0

- **Australian ATS compatibility pass:** prioritised the three candidate-facing third-party platforms that are most consistently visible in Australian ATS usage data and graduate/enterprise hiring: Workday, PageUp and SAP SuccessFactors Recruiting.
- **Workday:** added persistent host access/content-script coverage for `myworkdayjobs.com`, `myworkdaysite.com` and `workdayjobs.com`; strengthened use of `data-automation-id` and standards-based autocomplete hints; added repeating-row detection for Work Experience, Education and Languages where record identifiers expose an index.
- **PageUp:** added persistent coverage for `pageuppeople.com`, including `careers.pageuppeople.com` job pages and `secure.dcN.pageuppeople.com` application forms; expanded block vocabulary for Employment Details/Record, Academic Qualifications and Language Proficiency; improved generated-control identifier handling.
- **SuccessFactors:** retained the dedicated candidate-profile/background-element support added in 2.3.0 and folded it into the shared top-three compatibility layer.
- **Cross-platform semantic matching:** fields now also use HTML autocomplete tokens (`given-name`, `family-name`, `address-level2`, `postal-code`, etc.) and additional component metadata as reliable matching signals when visible labels are difficult to reach.
- **Platform visibility:** the side panel header now identifies Workday, PageUp or SAP SuccessFactors when GradFill recognises the current host, making it obvious whether the page is on a first-class supported ATS.

## 2.2.0

- **Inline correction learning:** when you change a yellow answer or complete a red field, GradFill surfaces **Remember this answer?** in the side panel. Approved corrections are stored in field memory (or the written-answer library) and reused on matching questions.
- **Application session memory:** role, company, job description, requirements, selected resume, tracker link and page progress persist across multi-page application flows in the same tab.
- **Job context now travels with autofill:** retained role context is passed back into later-page scans so company-sensitive rules and written-question drafting do not lose the job description when the ATS page no longer shows it.
- **Smart resume recommendation:** the side panel compares saved tailored resume versions with the current role and recommends the strongest keyword-fit version, with one-click selection or a shortcut to create a new tailored version. Resume Studio saves the keyword-fit score with new versions.
- **Automatic tracker lifecycle:** Save Job creates/keeps **Saved**; starting GradFill on the form advances it to **Applying**; Mark Applied advances it to **Applied**. Later stages remain user-controlled in Tracker. Page count and selected resume follow the same tracker entry.
- **Gap dashboard:** repeated red/unknown questions are counted. **Fix once** saves an approved answer into GradFill memory and resolves the gap, so recurring unknowns should reduce over time.
- **Review scan upgraded:** it can confirm yellow fields as well as learn completed red fields, while still excluding sensitive fields, declarations and file uploads.

## 2.1.0

- **Native side panel now keeps essential profile details visible at all times.** Name, email, phone, full address, suburb, postcode, state and country are one-click copy buttons; **All details** opens the full searchable Quick Copy profile.
- **Confidence is now explicitly Green / Yellow / Red.** Green = confident fill, Yellow = filled but worth checking, Red = deliberately left blank because GradFill does not know the answer yet.
- **Added Review scan + learn.** After you manually complete a red field, this scan stores the approved factual answer in local GradFill memory and uses it on matching fields in future applications. Exact learned fields can become green; similar wording is filled yellow for confirmation.
- **Written answers learn separately.** A manually completed red written response can be saved into the answer library; the same question can then be reused as a yellow review item rather than another red blank.
- Sensitive fields, file uploads and declarations remain manual and are never learned as autofill memory.
- Folder/package name standardised to **GRADFILL** for drop-in replacement of future versions.

## 2.0.2

- **GradFill now opens as Chrome's native right-side panel instead of a small extension popup.** The panel stays open beside Workday, PageUp and other application pages while you work.
- **Quick Copy now lives inside that full-height side panel.** Click Quick Copy to switch to a searchable list of your saved personal details, education, work history, skills, languages and referees. Every row copies its value to the clipboard.
- Removed the old behaviour where Quick Copy tried to inject a floating panel into the application page itself.
- Field-jump actions no longer close GradFill, which makes the panel practical as a persistent application companion.

## 2.0.1

- **Added Quick Copy side panel.** Click **Quick copy** in the GradFill popup to open a large panel on the right side of the current application page. It shows practical saved details including name, email, phone, address components, eligibility, education, experience, skills, preferences, languages and referees.
- **Every value is clickable.** Clicking a row copies that exact value to the clipboard so it can be pasted manually when an ATS field is unsupported, blocked, or not recognised correctly.
- The panel is isolated in a Shadow DOM so application-site styles cannot break it, and it never submits or changes the application form itself.

## 2.0.0

- Added **GradFill AI** account/plan architecture with Offline demo, Local backend and Production modes.
- Added Free and Pro entitlement model: Free 1 assisted application/day; Pro priced in the UI at A$15/week, with higher server-enforced AI/application quotas.
- Added a backend-safe AI client. No OpenAI or Stripe secret is stored in the extension.
- Added in-extension **AI written-answer drafting** with explicit review, Copy, Save answer and Insert into form actions. Final submission remains manual.
- Added **Resume Studio** for job-specific, editable resume drafts, matched-skill/keyword feedback and saved resume versions linked to tracker entries.
- Added a dedicated **Job Tracker** pipeline page with Saved, Applying, Applied, Assessment, Interview, Offer, Rejected and Withdrawn stages, search, notes, skills, resume-used tracking and CSV export.
- Added popup **Save job**, **Mark applied**, **Tracker** and **AI Resume** actions and fixed the incomplete 1.31 tracker wiring.
- Added optional account/profile/tracker sync through the GradFill backend. Resume/transcript binary contents are stripped from profile sync.
- Added `privacy.html` with local/cloud/AI/billing disclosures for development; a hosted production policy is still required for store release.
- Added Shadow-DOM-aware jump and explicit AI-draft field insertion.
- Replaced the old Claude-specific setup wording with provider-neutral GradFill AI wording.
- "Erase everything" now clears the profile, account token, settings and local usage data.

## 1.31.0

- **Job Tracker upgraded from an applied-only list into a lightweight pipeline.** Roles can now be saved before applying and moved through Saved, Applying, Applied, Assessment, Interview, Offer, Rejected or Withdrawn.
- **Added “Save job” and “Tracker” actions in the popup.** Saving captures company, role, location, employment type, closing date, link, referrer source where available, a job-description snapshot, and any of your saved skills that are explicitly mentioned in the posting.
- **“Log this application” is now “Mark applied” and de-duplicates against saved jobs.** If the role was bookmarked first, GradFill upgrades the same record instead of creating a second copy.
- **Tracked roles can record the resume version used and richer notes** for contacts, follow-ups, interviews and anything worth remembering.
- **Fixed previous-application logic for bookmarks.** A role that is merely Saved no longer makes “Have you previously applied with us?” answer Yes. Legacy tracker entries still count as applied.
- This remains **local-first**. Account-linked sync, cross-device access and an AI resume workspace require a real authenticated backend and are the next architecture layer rather than being simulated with browser storage.

## 1.30.0

- **Fixed: "Role Description" and similar long-text fields weren't filling at all.** These are frequently a rich-text editor (a `contenteditable` div) rather than a real `<textarea>` on modern platforms \u2014 structurally invisible to a scan that only ever looked for `input, select, textarea`. Every other field in the same block could fill perfectly while this one silently didn't, because it wasn't the same kind of element at all. Now recognised and filled the same as any other long-text field.
- **Fixed the actual reason a field's context-finding could grab the wrong text**, discovered while fixing the above: walking backward to find a section heading now correctly skips over ordinary field labels ("Job Title", "First Name") on the way, rather than either stopping dead at the first one (missing headings positioned behind several fields) or sweeping their text in as if it described the current field (a field with no visible label of its own could end up answering as if it were an unrelated nearby field). Verified both directions: a description field now correctly reaches its real heading, and a completely unlabelled field with nothing relevant nearby correctly falls back to its own identifier rather than borrowing a neighbour's label.
- **"Software Security" now recognised as equivalent to Cybersecurity**, and **"Bachelor's" now matches your saved "Bachelor Degree" level** \u2014 both found directly from real reported gaps.
- **Added a Skills field rule** \u2014 genuinely new, fills a skills question from your saved skills list where none existed before.
- **"Previous employee" now also matches "previous worker" phrasing.**

## 1.29.0

Researched how major ATS platforms (Workday/myWorkdayJobs specifically, plus Salesforce-style enterprise web-component tools) are actually built, since they're known in the automation community as some of the hardest to fill programmatically. Found and fixed the two structural reasons why, independent of any specific employer's wording:

- **Shadow DOM support, added everywhere GradFill looks for fields, headings, buttons, and dropdowns.** Many enterprise platforms render real interactive controls inside an open shadow root for style isolation \u2014 a plain page scan cannot see across that boundary at all; it's not a matching problem, the elements are structurally invisible to a normal query. GradFill now walks into every open shadow root it finds. (A *closed* shadow root is genuinely inaccessible to any script on the web platform, by design \u2014 no extension can work around that.)
- **Workday-style identifier-based labelling now works.** Workday commonly identifies fields via attributes like `data-automation-id="candidateIsPreviousWorker"` rather than visible label text. That was already being read, but lowercased directly it collapses into one unbroken word ("candidateispreviousworker"), which defeats any real word-boundary matching. camelCase and snake_case identifiers are now split into proper words first.
- **"Previous employee" now also recognises "previous worker" phrasing**, found via the research above and confirmed missing during testing.
- Verified with a test page built to mirror the documented pattern: fields inside an open shadow root, identified only by camelCase automation-ids, no visible labels at all \u2014 name fields, and a "previously worked here" question, all now resolve correctly.

**Honest limit:** this was built and verified against a faithful reconstruction of the documented pattern, not a live Workday or PushApply page \u2014 I can fetch and read pages, but can't drive a real browser to inspect one directly. If a specific employer's Workday or PushApply instance still doesn't fill correctly, the same "give me the actual markup" approach that cracked the mat-select and inline-block issues earlier is still the fastest way to fix it for certain.

## 1.28.0

- **Fixed: a bare "End Date" or "Start Date" field (no "graduation" wording at all) now correctly maps to your study dates** when it's clearly an education field, not just when the exact word "graduation" appears. Previously this only worked with specific wording like "graduation date" or "expected completion" \u2014 the much more common plain "End Date" label was invisible to it. Guarded against misfiring on an employment date field labelled the same generic way.

## 1.27.0

- **Fixed: some application pages filled nothing at all because the form genuinely wasn't there yet.** Several real ATS platforms (this was confirmed against a Greenhouse-embedded application on a WordPress careers page) render the actual form entirely via a JavaScript widget that's still fetching and mounting at the moment the page "looks" loaded. Clicking Fill before that finishes meant scanning an empty page \u2014 not a matching bug, nothing to match yet. GradFill now treats a near-empty first scan as a sign the real content hasn't rendered, and retries for a few seconds before giving up.
- **Added "are you able to work from the office [N] days/times a week?"** to the compliance-default questions \u2014 answers Yes, always flagged for confirmation before submitting, same treatment as the other willingness questions.

## 1.26.0

- **Researched real Australian graduate program applications** (Big 4 firms, the APS Graduate Program, major banks, PageUp-style portals) to check GradFill's coverage against what's actually asked, rather than waiting for gaps to surface one at a time. Most application-form fields \u2014 citizenship, security clearance, WAM/degree bands, checks consent, referee handling, disability/adjustment questions \u2014 were already covered. Two genuine, recurring gaps found and added:
- **"Willing to complete an online/psychometric assessment?"** \u2014 a near-universal gate question across every employer researched. Defaults to Yes, flagged for confirmation, same treatment as the other compliance questions.
- **"Which team/stream/business area are you most interested in?"** \u2014 added a Preferred team/stream field to Setup (03 Preferences). Always flagged rather than shown as a confident fill, since exact team names are different at every employer \u2014 it's a starting point to adapt, not a value to trust blindly.
- Everything else researched (video interviews, assessment centres, psychometric testing itself) turned out to be later-stage *processes*, not form fields \u2014 nothing to fill in for those.

## 1.25.0

- **Fixed a real cross-contamination bug in radio-group matching.** For a multi-option group, an individual option's own label (e.g. an option literally called "LinkedIn") was being folded into the question-matching text alongside the shared question. On a "How did you hear about us?" question with a LinkedIn option, that option's own label was coincidentally matching the unrelated "your saved LinkedIn profile URL" rule and hijacking the entire question, always answering "LinkedIn" regardless of what was actually being asked or what the real answer should be. Fixed: for genuine multi-option groups, matching now uses the shared question text alone, not blended with any one option's own label.
- **Added "How did you hear about us?" detection.** Reads which page you arrived from (LinkedIn, Seek, Indeed, Glassdoor, GradConnection, Prosple, a search engine, or the organisation's own site) and answers accordingly \u2014 always flagged for confirmation, never treated as certain, and never hardcoded to one fixed source.
- **Prompts for written questions now put anything sourced from the page itself as far down as possible** \u2014 the job description found on the page moves to just before the final writing instructions, rather than appearing mid-prompt, so what you've told Claude directly reads first.

## 1.24.0

- **Fixed the real cause of "select all that apply" checkbox groups reporting almost nothing.** Grouping required a shared `name` attribute across the checkboxes, but many real forms give each checkbox its own unique name \u2014 the grouping only exists visually. When that happens, every checkbox was being treated as an isolated single toggle, and since none were individually required, most produced no report entry at all. Fixed: checkboxes now also group by their nearest shared container when a name isn't actually shared, so these groups are recognised and answered from your saved Background tags as intended.
- **Fixed a false-positive risk found while testing the fix above.** A saved tag like "School Captain" was incorrectly matching an unrelated option like "Sporting Coach or Captain", purely because both happened to share the bare word "Captain" after the option was split on "or". Matching now requires every significant word of the saved tag to actually appear in the option, not just one shared word \u2014 verified both that the false match is gone and that genuine matches (a saved tag that really does correspond to the option) still tick correctly.

## 1.23.0

- **Fixed a real block-detection gap.** Some forms bake the block number straight into the first field's own label ("Employment #1 Organisation Name:") instead of using a separate heading like "Employment 1" \u2014 and every other field in that block (job title, dates, responsibilities) carries no number at all. GradFill's block detection only ever looked for standalone headings, so it never recognised these as separate blocks \u2014 every field fell back to generic "most recent job" matching, which is why both blocks were getting the same employer and the rest were left blank. Fixed: a field's own inline block marker is now also used to anchor everything positioned after it, the same way a real heading would.
- Verified against the exact structure from the screenshot: two employment blocks, only the organisation field in each carrying "#1"/"#2", nothing else numbered \u2014 both now fill correctly and distinctly, including dates and responsibilities.

## 1.22.0

- **Added "Log this application"** in the popup footer. One click reads the organisation and role off the current page (same detection used for the role-details prompt) and saves an entry to Applications \u2014 company, role, this month, and a link back to the page you're on \u2014 no retyping in Setup required.
- **Deliberately not automatic.** GradFill never submits a form and never acts on a guess without you confirming it \u2014 detecting "did a submission just succeed" from outside the page isn't reliable enough to log something on your behalf without a click. This is the safe middle ground: one click after you've actually submitted, not a silent background guess.
- If nothing about the role can be read from the page, nothing gets logged \u2014 you're told plainly rather than getting a blank or wrong entry saved.

## 1.21.0

- **Applications (Setup \u2014 07) is now a proper browsable record**, not just a matching tracker. Each entry shows a readable summary \u2014 role, company, date \u2014 with a clickable link back to the job ad or application if you saved one.
- **Added a link field and a notes field** to each application entry. The link opens in a new tab; notes are free text for anything worth remembering (how you found it, who referred you, what stood out).
- Still answers "have you previously applied for a role with us?" automatically, exactly as before \u2014 the new fields are additions, nothing about the matching changed.

## 1.20.0

- **Added Setup \u2014 08 Background**: a one-time checklist for programs you've participated in, leadership experience, extracurricular activities, and industries you've worked in \u2014 plus "Other" free text and an explicit "None of these apply to me" per category. Fill it in once and it answers these "select all that apply" questions on every future application, no guessing involved on GradFill's part.
- **"Select all that apply" checkbox groups now match your saved Background answers directly.** Previously the only signal available was a conservative (and necessarily narrow) match against your job titles, which correctly couldn't tell GradFill "Sporting Coach or Captain" applies to you from a STAR example about team captaincy \u2014 that's exactly the kind of thing Background now answers directly instead of trying to infer.
- Still falls back to the job-title match for anyone who hasn't filled in Background yet, so it's not blank before you get to it \u2014 but the report now tells you exactly that, and points you to where filling it in makes it exact.

## 1.19.0

- **Fixed: GPA dropdown genuinely wasn't answerable before.** The real options weren't a GPA scale at all \u2014 they were grade bands like "Credit / C / H3 / 65-74". GradFill now inspects what a GPA-labelled dropdown is actually offering (grade bands vs a plain GPA number) and answers in whichever scale it's using, computed from your saved WAM.
- **Fixed a misleading note.** When a select got filled via a partial/best-guess match rather than an exact one, the note said "No option matched" even though something genuinely had been selected. Now says what actually happened, and shows the real selected value.
- **Fixed: "how many subjects failed" was matching the wrong rule** (same "university" false-positive issue as before, now excluded properly). Defaults to 0, flagged for confirmation.
- **"Select all that apply" checkbox groups are now handled properly**, not routed through single-pick radio logic which could only ever tick one box. Deliberately conservative: only ticks an option when it matches your saved job title directly (e.g. "Cybersecurity Intern" \u2192 Internship). Broader categories \u2014 industries, leadership subtypes, university-specific program names like "Work Integrated Learning" \u2014 are left for you, since guessing at those from loose text risks a wrong tick on a real application, which is worse than an empty checkbox.

## 1.18.0

- **Added an academic record / transcript document**, alongside your resume (Setup \u2014 09). GradFill now tells you specifically which one a file-upload field wants \u2014 "Save resume" or "Save academic record" \u2014 instead of one generic "attach manually" note for every file field.
- **Fixed: "how many subjects have you failed?" was matching the wrong rule.** "University subjects" was being caught by the institution rule (which just looks for the word "university"). Now answers 0, flagged for confirmation \u2014 the common case, but worth a glance.
- **GPA/WAM dropdown matching is now far more robust.** Different forms bucket this differently \u2014 whole numbers, half-point steps, one-decimal precision. Rather than assuming one format, GradFill now tries several reasonable roundings of your saved figure and lets normal matching pick whichever real option actually fits. Tested against three different dropdown formats; all three now fill correctly.
- **"Undergraduate discipline" now falls back to a related option when your exact major isn't offered.** Cybersecurity isn't always in the list \u2014 Information Technology, Computer Science, Information Systems, and similar are now recognised as reasonable substitutes, tried in that order. Never invents a match with no real relationship to your major.

## 1.17.0

- **Fixed: double-degree second major was being duplicated from the first.** A field asking for "second major" or "additional discipline" now correctly uses your second degree's major (Criminology) instead of getting the same answer as the primary discipline field (Cybersecurity).
- **Fixed: "year you commenced" and "...anticipate to complete" weren't recognised at all.** Neither "commenced" nor "anticipate" matched any date rule, so these fell through to the generic "degree" rule and got a degree *name* typed where a year was wanted. Both now recognised, and return a bare year (matching how these are usually offered as single-year dropdowns) rather than a full formatted date.
- **Fixed: "have you completed any postgraduate study?" was answering with a qualification name.** It matched a broader "have you completed" rule meant for a different question shape. Now answers Yes/No based on whether any saved qualification is postgraduate-level.
- **"Qualification type" now uses the saved education level** (Bachelor Degree, etc.) directly rather than relying on a partial-credit match against the full degree name.
- **GPA is now rounded to one decimal place** before matching against a dropdown, since these almost never offer two-decimal precision \u2014 5.42 now matches an option like "5.4" instead of finding nothing close enough.

## 1.16.0

- **Written-question prompts now ask Claude to research first, not just leave gaps.** Previously, any field you skipped in the role-details panel was simply left out of the prompt. Now the prompt explicitly tells Claude: for anything factual and missing (organisation name, role, location, employment type, what they do, key requirements), search the web for it first \u2014 these are public facts \u2014 and only ask you directly if it genuinely can't be found. One field is never guessed or researched: why the role appeals to you personally. That one is always asked, since it's not something to look up.
- The role-details panel is now genuinely optional rather than something to fill in carefully. Leave it entirely blank and click Generate \u2014 the copied prompt will still work, just by having Claude do more of the legwork itself once you paste it in.
- Fields the page already detected (organisation, description, etc.) still skip the "MISSING" treatment and go straight into the prompt as before.

## 1.15.0

- **Fixed: "current or previous employee of [Company]?" and "previously applied with [Company]?" weren't filling on later pages of a multi-step application.** They relied on job-ad metadata that usually only exists on a job's original landing page \u2014 a later step in the application flow has no such metadata to read. Both now pull the company name directly out of the question's own text first ("...employee of Bega?" \u2192 Bega), which works on any page.
- **Added an Applications tracker** (Setup \u2014 07 Applications): a simple list of company, role, and date. "Have you previously applied for a role with us?" is checked against this list and answered Yes/No accordingly, defaulting to No when nothing's on record. Add an entry after you submit an application and it's ready next time you're asked.
- **Fixed a real bug in how question text gets captured for radio groups.** When a question was split across more than one preceding paragraph \u2014 a lead-in sentence, the actual question, and a separate "please note" caveat \u2014 only the single *nearest* block was being read as the question. On the graduation-year bucket question, that meant the caveat paragraph (not the real question) was being used, and the year buckets never filled. All qualifying preceding blocks are now gathered together, not just the closest one.
- Fixed a rule-ordering conflict where several broad "degree...X" patterns could claim the graduation-year question first, before it got a chance to match.

## 1.14.0

- **"Current or previous employee of [Company]?" now answers from your saved work history.** Checks the job's detected organisation against your saved employers (fuzzy-matched, so "Bega" and "Bega Group" count as the same) and answers Yes/No accordingly. Always flagged for a quick confirm.
- **"In which year will you complete your degree?" (offered as year buckets) now fills from your saved graduation date.** Built for the common bucket wording seen on grad programs (year, or January/Post-January splits) \u2014 flagged, since exact bucket boundaries vary by form.
- **Procedural/compliance gate questions now default to Yes**, always flagged for confirmation since willingness is a real decision, not a fact: willing to undergo checks, available to attend all selection stages, free to commence on the required date.
- **"Do you hold a driver's licence?" now answers Yes/No** from your saved licence details, rather than only handling fields asking for the licence details themselves.
- **Added a Preferences section to Setup** (availability, salary expectation, notice period, willingness to relocate) \u2014 these existed in the data but had nowhere to actually enter them. Relocation is Yes / No / Subject to role.
- **A banner now appears at the top of the popup** when a form asks about relocation and you haven't set a preference, with a link straight to Setup. Once set, relocation questions fill (still flagged, since it's genuinely role-dependent) and the banner doesn't appear.

## 1.13.0

- **Fixed: "Please list any languages you speak" was being answered "Yes".** This phrasing shares wording with the plain yes/no "are you proficient in other languages" question, and GradFill was matching it to the wrong rule \u2014 answering the question rather than actually listing anything. It now recognises an enumeration request (cued by "list", "state", "specify", "which languages") and answers with the real list: "Urdu (Conversational)" rather than "Yes". The original yes/no phrasing still answers Yes/No as before.

## 1.12.0

- **Identity questions now recognise many phrasings of the same question, not just one.** "Are you part of the LGBTQIA+ community?", "Do you identify as sexually and/or gender diverse?", and "What is your sexual orientation?" (offered as Heterosexual/Gay/Lesbian/Bisexual rather than Yes/No) all now resolve to the same saved answer. Same treatment for culturally/linguistically diverse background (CALD, NESB, "non-English speaking background" all recognised), first-in-family ("first-generation university student" now recognised too), minority group ("underrepresented group", "marginalised group"), and Aboriginal/Torres Strait Islander status ("First Nations" now recognised).
- When a form asks sexual orientation as a specific list rather than yes/no, a saved "No" correctly resolves to "Heterosexual"/"Straight". A saved "Yes" is deliberately NOT auto-mapped to a specific orientation label \u2014 guessing which one would risk misrepresenting you, so that one still gets flagged for you to answer directly.

## 1.11.0

- **Fixed a significant gap in how radio-button questions find their question text.** Many forms style a question as bold or plain paragraph text ("Which of the following best describes your gender identity?") rather than a real heading or fieldset legend. Radio groups on forms like this had no question context at all \u2014 each option only knew its own text ("Female"), which can't match anything. Worse, a page-level title (like a "DIVERSITY & INCLUSION" section heading) was being mistaken for the context of every field below it on the page, since it technically "came before" all of them. Both fixed: the nearest actual text immediately above a field is now checked first, and a distant page title no longer overrides it.
- **Diversity and inclusion questions now fill from your saved details** where you've provided them: gender, Aboriginal/Torres Strait Islander status, and accessibility/adjustment needs. "Languages other than English" is now answered automatically from your saved language list rather than needing its own separate field.
- **Added setup fields for pronouns, LGBTQIA+ identification, culturally/linguistically diverse background, first-in-family-to-graduate, and minority group identification** \u2014 these are marked optional in Setup, matching how most forms present them, and are only used once you've actually filled them in. Left blank, they're flagged for you exactly as before, never guessed at.
- "None" as a saved adjustments/disability answer now correctly matches option wording like "No adjustments required."

## 1.10.0

- **Angular Material dropdowns now fill automatically.** A `mat-select` (a very widely-used, standard component \u2014 not one-off site code) is opened, the matching option is found among the real options Angular renders, and that option is clicked \u2014 genuine equivalent-to-a-real-click interaction, not a faked value. Verified against a full mock of the component's actual behaviour (panel opens elsewhere in the document, options are real elements, closing after selection).
- **If nothing matches confidently, the panel closes again** rather than being left open or a guess being made. Falls back to the same "pick it yourself" flag as before.
- **A dropdown that's already been filled is left alone**, not reopened and reselected.
- All other custom dropdowns (not Angular Material) keep the previous, unchanged safe behaviour \u2014 flagged for you to pick, never guessed at.
- The popup allows more time for Fill this page to finish when a page has dropdowns like this to work through, rather than mistaking legitimate work for a freeze.

## 1.9.0

- **"Home Address" now always gets the full address**, written out as street, suburb, state, postcode, and country together \u2014 even on a form that also has its own separate City/Suburb, State, and Country fields. Those separate fields still get filled correctly too; Home Address just also carries the complete picture on its own.
- A more specific field \u2014 "Street" or "Address Line 1" \u2014 still gets just the street, since that wording is asking for one component, not the whole address.

## 1.8.0

- **Fixed: dropdowns filled visually but the site never actually registered it.** Frameworks like React track a form field's value through their own internal state rather than trusting the DOM directly, and specifically shadow the value property on each field they control to detect real changes. Setting `.value` directly \u2014 which is what GradFill was doing for every dropdown \u2014 goes through that shadow and can silently update the framework's own record without ever notifying it, so the browser shows a selected value but the site's own code never finds out. Text fields already used the correct technique (going through the field's original, non-shadowed setter); dropdowns now use the same one. Verified against a simulated React-style controlled select, confirmed broken beforehand and fixed after.
- **Address fields now match the shape of the form.** A form with its own separate suburb and postcode boxes still gets just the street in an address field, as before. A form with a single address box and nothing else \u2014 no separate suburb or postcode field anywhere on the page \u2014 now gets the full address in that one field: street, suburb, and postcode together.

## 1.7.0

- **Fixed: a correctly-filled dropdown could get silently wiped a moment later.** When a field needed a retry (a country list that loads in after the page renders, say), the retry pass re-touched fields that were already correct and unconditionally re-fired change/input events on them \u2014 even though nothing had changed. On a form where State depends on Country, that spurious re-fire on Country retriggered the site's own script to rebuild State's option list, destroying the value GradFill had just set correctly moments earlier in that same pass. Fixed: values are only touched, and events only fired, when something is actually changing.
- **Fixed: "Home Address" wasn't recognised.** The address rule only matched "residential address", "street", or "address line 1" \u2014 not the plain wording several real forms use. Added "home address", "mailing address", and "current address".
- **Selects that haven't loaded yet now get retried**, not just declared unmatched. A state or country list that populates in after the page renders (common with API-backed pickers) is retried up to twice with a short delay, rather than being flagged as no-match on the spot.
- Added an address block with an async, cascading country \u2192 state dropdown to the practice form, so this exact scenario is covered going forward.

## 1.6.3

- **Fixed the actual cause of the frozen role-details panel.** It was built as a `position: fixed` overlay. Chrome sizes an extension popup window from its normal in-flow content, and fixed-position elements are excluded from that measurement \u2014 so the panel could be painted larger than the popup's real interactive bounds. It looked correct and keyboard input (Escape) worked, but clicks landed nowhere because the buttons were rendered outside the window's actual clickable area. Confirmed by Escape closing the panel while clicking Cancel did nothing \u2014 the tell that this was a hit-testing problem, not a broken script.
- The panel is now a normal in-flow section, the same pattern already used for the rest of the popup, which has never had this problem.

## 1.6.2

- **Fixed a real cause of the popup appearing to freeze.** Injecting into every frame and messaging every frame (added in 1.6.0 for iframe support) had no time limit. Real recruitment sites often carry a dozen-plus tracking, ad or chat iframes alongside the actual form; if even one of them never responded, the entire popup \u2014 including the Fill button and the very first load \u2014 could sit waiting indefinitely with no error. Every frame call is now capped at 5 seconds, and results from frames that did respond are still used.
- Only the role-details form's own request had a timeout before; the main Fill button and popup startup did not. Both are covered now.

## 1.6.1

- **Fixed: the role-details modal could appear frozen.** If the page's content script hadn't been refreshed since before an extension reload, Generate would wait on a response that never arrived, with no feedback. It now times out after a few seconds and tells you directly to reload the tab (not just the extension) rather than sitting there silently.
- Added a fallback: if the browser blocks clipboard access, the generated prompt is shown in a text box to copy manually instead of being lost.
- Generate now visibly shows "Generating..." and disables itself while working, so a slow response looks like it's working rather than doing nothing.

## 1.6.0

- **Fixed: forms inside an iframe were invisible.** GradFill only ever injected into the top-level page. Any application widget embedded in an iframe from a different domain (PageUp, JobAdder and similar recruitment platforms all do this \u2014 Standards Australia's form is one) was never scanned, giving "No form fields found" even with a full form visible on screen. GradFill now injects into every frame on the tab and routes each field's fill, jump, and prompt actions to the frame it actually lives in.
- **Job details now resolve correctly when the form is in an iframe.** The job title, organisation and description usually sit on the outer marketing page, not inside the embedded form. When you open the role-details form for a written question, GradFill checks the top frame for that data first and pre-fills what it finds, even though the question itself lives in a different frame.
- **Fixed: the role-details form from 1.5.0 was never actually wired up.** It shipped with the modal's HTML present but disconnected \u2014 Copy prompt still returned the old template full of TODO lines. It now opens properly, pre-fills what could be detected, and only builds the prompt once you click Generate.
- The popup script tag was loading before the modal's HTML existed in the page, which would have thrown errors once the button was wired \u2014 fixed as part of the same pass.

## 1.5.0

- **Prompts now ask upfront.** When you click "Copy prompt" on a written question, a form appears with fields for organisation name, role title, location, employment type, what the organisation does, key requirements, and why it appeals to you. Fill those in, click Generate, and the prompt is built with your answers — no TODO lines.
- The form has text inputs for the quick fields and textareas for requirements and motivation.
- Press Escape to cancel, or click Cancel.

## 1.4.0

- **Prompts now read the job ad.** Organisation, role title, location, employment type, closing date and the job description are pulled off the page and written into the prompt. Most job boards publish this as structured data; where they don't, page metadata and headings are used instead.
- **Prompts ask you the rest.** What the organisation does, the key requirements, and why the role appeals to you appear as TODO lines for you to complete. The prompt tells Claude to ask rather than guess if any TODO is still there when you send it.
- The popup says what it managed to read off the page, so you know what's left to fill.
- Field `name` and `id` attributes no longer leak into the question text sent to Claude.
- Only STAR examples you've actually written are included — empty stubs are left out.

## 1.3.0

- **Block-aware filling.** Fields under "Work Experience 2" now all draw from your second role — title, company, dates and the currently-work-here tick from one record, not each guessing separately. Same for Education and Language blocks.
- **Extra rows open automatically.** When you have more records saved than the form shows blocks, GradFill clicks Add / Add Another to open them. Strictly matched button text, capped at four clicks per section, and anything reading submit, save, delete or continue is never touched.
- **Date formats read off the field.** A box hinting MM/YYYY gets 03/2024; dd/mm/yyyy gets the full date; a month input gets 2024-03.
- **GPA and WAM are separate.** A GPA field gets 5.42, a WAM field gets 73.89.
- **One degree box gets the merged title**, "Bachelor of Cybersecurity and Criminology". Two boxes get them separately.
- **Languages** are a saved section.
- **Referees are never filled**, always flagged for you.
- **Salary is always left blank.**
- "Company" on its own now matches; previously it needed the word "name" alongside.
- Your HSC is stored but held back from education blocks — it only answers questions about completed qualifications.

## 1.2.0

- **Dropdown options now match across abbreviations.** A saved "NSW" finds an option reading *New South Wales*, and the reverse. Same for states, territories, country, and phone types. Previously anything that wasn't a near-literal string match was left blank and flagged.
- **"None" is no longer treated as a placeholder.** On a security clearance dropdown it's a real answer, and it was being skipped.
- **Custom dropdowns are surfaced.** Dropdowns built from divs and buttons rather than `<select>` can't be set by a script. They now appear in the list as amber instead of silently doing nothing.
- **Combobox inputs never show green.** Typing into one doesn't always commit a selection, so they're always flagged for you to confirm.
- **Phone type** is a saved field, so "Device type" and similar resolve to Mobile.
- Radio groups use the same matching, so "Yes"/"Y" and "New South Wales"/"NSW" work there too.

## 1.1.0

- **Extension ID is now pinned.** Your saved details survive every update, folder move, and reinstall. Before this, reinstalling from a different path gave you a fresh empty profile.
- **Backup added.** Export your details to a file and restore them on another machine (setup, section 09).
- **Version shown** in the popup and at the bottom of the setup page, so you can tell whether an update actually landed.
- `update.ps1` for one-command updates once the folder is a git repo.

## 1.0.1

- **A field's own label now beats its section heading.** Under a "Legal Name" heading, *Given Name*, *Middle Name* and *Family Name* were all being filled with your full name. Each now resolves on its own label.
- **Salutation** is a saved field, so required Mr/Ms dropdowns fill instead of sitting amber.
- **Preferred name** disclosure boxes tick when you have one saved, and the page is swept a second time to catch the field that appears. Previously "preferred name" fell back to your first name, which would have ticked the box for everyone.
- **Declaration checkboxes are never ticked.** Anything reading "I agree", "I certify", "I consent", "true and correct" is always flagged for you.
- Referee fields no longer capture your own email or phone.
- "Position title" is no longer read as a Mr/Ms salutation.
- "Course start date" no longer returns your degree name.

## 1.0.0

- First version.
