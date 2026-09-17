# Chrome Web Store draft listing — GradFill AI

## Recommended name
**GradFill AI — Graduate & Job Application Autofill**

Do not use `ChatGPT`, `GPT`, or a model name in the extension title. If the production backend uses OpenAI, the description can accurately state that selected AI features are powered through the OpenAI API.

## Short description
Autofill repetitive job application fields from one profile, tailor resume drafts, draft written answers for review, and track every role.

## Detailed description
GradFill AI helps graduate and job applicants spend less time re-entering the same information across application portals.

Create one profile with your education, experience, skills, contact details and preferences. On supported application pages, GradFill fills repetitive fields and visually flags anything you should check. Written questions can be drafted with AI when you explicitly request it, but drafts are shown to you for review and editing before you choose to insert them.

The Resume Studio creates role-specific, editable resume drafts using only facts saved in your profile. The Job Tracker keeps saved roles and applications together with stages, notes, matched skills, links and the resume version used.

GradFill does not press the final Submit button. You remain responsible for reviewing and submitting every application.

### Key features
- One reusable candidate profile
- Autofill across common application/ATS form patterns
- Human-review highlights for uncertain or personal fields
- AI-assisted written-answer drafts
- Job-specific Resume Studio with saved versions
- Saved → Applying → Applied → Assessment → Interview → Offer tracker
- Notes, links, job-description snapshots and matched skills
- Free and Pro plans
- Optional account/profile/tracker sync

## Permission justifications

### `storage`
Stores the candidate profile, tracker, plan/session state and preferences required for the extension's single job-application-assistance purpose.

### `unlimitedStorage`
A user may save a resume and transcript locally as base64 data as well as job-description snapshots and tailored resume drafts. This can exceed normal extension storage quotas.

### `activeTab`
Accesses only the tab on which the user deliberately invokes GradFill so it can identify and fill visible application fields and read relevant role information.

### `scripting`
Injects the bundled GradFill scanner/filler and CSS into the user-invoked application page and its frames. No remotely hosted executable code is injected.

### Host permissions
- `http://127.0.0.1:8787/*` and `http://localhost:8787/*` are development-only endpoints for local backend testing. **Remove these from the public store manifest if you do not intend to ship local-development mode.**
- `https://api.gradfill.app/*` is the production GradFill account/AI/billing API endpoint. Keep it only after that domain is live and the privacy policy accurately describes its data processing.

## Data-use disclosure draft
Depending on enabled features, GradFill handles:
- personally identifiable information entered into the user's candidate profile
- employment and education history
- website/application page content required to identify form fields and role details
- job tracker data, notes and saved application links
- authentication/session information for an optional GradFill account
- user-generated AI prompts/drafts and tailored resume text

GradFill should disclose that explicitly requested AI features transmit relevant career-profile facts, the application question and/or job description to the GradFill backend and configured AI provider. Demographic/accessibility fields are excluded from the default AI payload.

Do not claim the extension is endorsed, certified or created by OpenAI.

## Before publication
1. Deploy `api.gradfill.app` over HTTPS.
2. Remove development host permissions if not needed publicly.
3. Publish a full privacy policy and terms at public URLs.
4. Complete the Chrome Web Store Privacy practices disclosures so they exactly match production behaviour.
5. Configure a support email/site.
6. Add store screenshots showing the popup, Resume Studio and Job Tracker.
7. Test account deletion/export and subscription cancellation.
8. Test on representative ATS pages and document known compatibility limits.
