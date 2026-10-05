# Optional acquisition and course interest

Collection is disabled by default. This release creates no campaigns, sends no messages, installs no tracking provider and changes no production course or account. Owner/admin aggregate reporting works while collection is off.

## Owner configuration and access

Open **Course curriculum → Manage course acquisition** (`/instructor/courses/:id/acquisition`). The server checks current course ownership; admins can also manage the course. Other instructors and students cannot read reports, campaign inventories or contact lists. Public catalog DTOs never include contacts, student identities, source choices or payment credentials.

Before enabling either collection option, the owner must author an actual privacy notice, add its HTTPS URL in course details, and explicitly review the purposes, authorized access, retention and optional marketing consent. A URL and checkbox cannot establish legal adequacy: notice content, operator identity, applicable obligations and handling of contact/withdrawal requests remain owner decisions. No policy text or legal assurance is generated. Changing the URL disables collection until reviewed again. Unpublished/archived courses cannot collect public requests.

Each course can retain at most 20 campaign links. Channels are a fixed allowlist; labels are 1–40 lowercase letters/numbers/hyphens beginning with a letter. Owners must use generic campaign names without personal identifiers. URLs contain only an opaque course-scoped code, for example `/catalog/course-slug?source=<code>`; no personalized referrer identifier, rewards or discounts. Deactivation blocks new attribution while preserving earlier labels. Creation retries use the same UUID and do not consume another slot.

## Elective public choices

No visit is sent before the visitor checks the optional measurement box. A course-scoped sessionStorage choice lasts at most 24 hours in that tab and survives authentication. Only consent, a validated opaque source code and expiry are stored locally; arbitrary query strings, IPs, referrers and fingerprints are not stored. Disabled tab storage leaves measurement off. Global Privacy Control disables this measurement choice. Samples and enrollment remain independent of all choices.

One page instance uses a stable UUID for retrying its optional view; a reload can count a new view. Views are client reports, not unique people, and may include bots or test browsing. The API accepts only consent, an optional bounded source code and UUID. Unrecognized registered-format codes map to unknown; arbitrary fields are rejected. Raw IP, user agent, account identity and request URL are absent from view records. Anonymous budgets use process-salted hashed IP keys in memory, never in acquisition records. Existing infrastructure may log requests independently; this feature does not configure provider logging.

An optional form collects only email, course-information/demo-information request type, explicit permission to respond, and a separate optional **unchecked** ongoing marketing choice. Both collection settings and all visitor choices start off. Permission to respond does not imply marketing consent. Submitting creates no enrollment, reservation or promise of a response. No email, webhook or outreach is sent. Responses do not echo contacts. Same-payload retries reuse a UUID; private lists have 20 entries per page, with guarded pending/contacted/closed status updates and explicit erasure. Changing status does not send a message.

Source attribution is elective and best effort after canonical free or live paid public enrollment, or successfully starting live checkout. Test checkout and test paid-enrollment retries skip attribution. It cannot create or authorize an enrollment, settle a payment, modify a price or award lesson completion. The first valid retained consented campaign for an account/course wins; a later source does not replace it. Deleting the signed-in student's source choice changes attribution only. Turning measurement off removes the tab choice and attempts this account-source deletion, with an explicit retry if interrupted. Earlier anonymous views are not linked to an account for later identification; they expire automatically.

## Metric definitions

| Metric | Source and limitations |
| --- | --- |
| Consented page views | Only retained optional view records. Counts page views, not people or canonical enrollment events. |
| Recorded public free enrollments | Canonical `Enrollment.publicFreeEnrollment`; account/course uniqueness prevents repeated enroll calls increasing the count. Retained historical enrollment consent, not present-course entitlement. |
| Recorded public enrollments with paid live orders | Canonical public live-enrollment flags plus a matching live order currently `paid`. Free-enrollment records are counted in the free category. Test-only purchases, pending attempts and partial/full refunds, disputes and reversals do not count in this paid category. This is a ledger state; other current course/account access restrictions still apply. |
| Live recorded receipts before fees/taxes | Live collection only: paid and partially refunded order amounts minus bounded recorded refunds. Full refunds, disputes and reversals contribute zero. Distinct current-state counts are shown. This is neither net accounting revenue nor tax/invoice reporting; fees, taxes and unrecorded provider adjustments are unknown. |
| Unknown / unattributed | No opt-in, unknown code, missing/expired source choice or unavailable source. No guessed source. Client labels are not verified causality. |
| Interest statuses | Only currently retained requests. These are requests, not sales or enrollments. |

Canonical financial/enrollment metrics use all retained canonical records; views and source choices use their expiry window. Expired choices make older canonical records unattributed without deleting financial records. No conversion rate is calculated, including when visits are zero. Empty courses show real zero counts, unknown attribution and empty lists; no synthetic production data is seeded.

## Retention, bounds and operation

`ACQUISITION_RETENTION_DAYS` is an integer from 1–180, default 90; invalid values fall back to 90. Each new view, account-source choice and contact request receives an absolute expiry. Changing the environment value affects new records, not existing expiry dates. Reads exclude expired records immediately. MongoDB TTL cleanup is asynchronous; expired documents can occupy bounded slots until removed. Backup retention and contact-access procedures require the operator's own policy. Registered source definitions and course settings remain until the course is purged; they must contain no personal information. Course purge removes all acquisition collections for that course and retains the existing financial-ledger behavior.

Per course: at most 5,000 retained views and 500 retained contacts, enforced through unique slots even for concurrent writes. Public request budgets are 30 visit attempts/hour and 5 interest attempts/hour per process-salted client key; owner/student acquisition writes are 60/hour per account. Attempts, including retries/invalid requests, consume the budget. Limits are process-local and reset on restart; the current socket-IP/proxy topology can group clients. This release does not claim distributed abuse protection or accurate unique visitor counts. Requests beyond limits fail without changing canonical access or financial records.

Startup awaits all acquisition unique/TTL indexes before listening. Deploy the matching backend before or with the frontend through the existing pipeline. No new provider or migration command is required. Owner activation is separate from deployment and was not performed on production.

## Verification

`node --test tests/acquisition.test.js` uses disposable local MongoDB and real HTTP. It checks default-off/privacy review, ownership/admin scopes, validation, retry races, source limits, consent, private contacts, pagination/CAS/erasure, request budgets, canonical free enrollment, attribution withdrawal, test exclusion, refund/dispute/reversal aggregates, expiry and unavailable courses. The full backend suite passed 132 tests.

Frontend `tests/acquisition_browser.py` uses real Chrome with synthetic intercepted APIs, blocks unexpected external calls, and checks public samples before choices, optional consent/withdrawal/retry, separate marketing permission, interrupted contact/source responses, owner policy setup, lists/status/erasure, navigation interruption, disabled storage, Global Privacy Control, light/dark mobile/desktop and 200% zoom. Existing stage regressions, lint, frontend unit tests, production build and Cloudflare dry run are release gates. Local checks do not establish hosted authenticated acceptance or payment-provider readiness.
