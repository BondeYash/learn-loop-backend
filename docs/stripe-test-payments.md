# Stripe test and live payments

This release uses one platform-owned Stripe account, INR, hosted Checkout and an explicit **test or live** mode. Live Checkout can charge real money when enabled by the user. No Connect transfers, split payouts, subscriptions or voluntary refund endpoint is included. The filename is retained for existing documentation links. Course prices remain INR rupees in the existing `Course.price` field; immutable orders store integer paise. Existing zero/unpriced courses are not migrated to paid courses.

An instructor/admin sets INR 0 for a free course or INR 0.50–999999.99 with at most two decimals. Assignment nominates a student; it **does not waive payment for a paid course**. A paid student needs a current assignment, an active account, a published/unarchived course and a verified `paid` order to read lessons/progress or receive fresh private video/PDF links. Owner/admin previews retain their existing role checks. Payment never creates an assignment, reopens an archived course, or clears learning progress. No timed access expiry has been added; the access-duration decision is still open. This is not a lifetime-access promise.

Course create/edit now presents an explicit **Free / Paid** choice. Free saves the existing `price: 0`; Paid saves a validated positive INR price, with no competing pricing flag or database migration. Existing zero/unpriced courses stay free. Assigned students can read free course details, lessons/progress, private videos, PDF notes and renewed playback links without Stripe settings or provider calls. Free quotes return INR 0 and suppress old pending Checkout details. Making a paid course free retains all orders, assignments and progress; returning it to paid restores current-mode verified-purchase checks. Existing paid orders remain valid, while unpaid/refunded/disputed students are locked again. Only the owner/admin can change price; free never means public access and a Stripe error never automatically makes a course free.

Published assigned courses remain visible on both the dashboard and course list before payment. Student-scoped summaries show required/pending/failed/paid/refund/dispute states and the INR price, without returning private provider IDs or URLs. A paid course remains visible when relocked. The dashboard's ready count excludes locked courses; Refresh reads fresh server state. Unassigned students and other instructors do not receive the course or its payment information.

## Backend configuration and deployment

Use the existing Render backend service's private Environment settings. Do not put secrets in chat, source control, frontend settings, `VITE_` variables or browser code.

```dotenv
STRIPE_MODE=test
STRIPE_SECRET_KEY=sk_test_REPLACE_PRIVATELY
STRIPE_WEBHOOK_SECRET=whsec_REPLACE_PRIVATELY
CLIENT_URL=https://YOUR_EXISTING_FRONTEND_ORIGIN
```

For live payments, set **`STRIPE_MODE=live`**, use an `sk_live_` value in **`STRIPE_SECRET_KEY`**, and enter the separate **live destination's** `whsec_` value in **`STRIPE_WEBHOOK_SECRET`**. These exact backend variable names are the contract; no frontend mode flag or key is required. `STRIPE_MODE` defaults to `test` only when absent. Empty, upper-case or other values fail closed. Mode is never inferred from the key or browser input. To return to testing, change all three settings to test mode and its matching key/destination secret together.

`CLIENT_URL` must be the exact frontend origin, without a path, credentials, query string or fragment. **Live mode requires HTTPS**. Test-mode localhost/127.0.0.1 development may use HTTP. Missing payment settings disable checkout without disabling free courses. Invalid mode, mismatched key prefix or an invalid configured signing-secret format prevents backend startup before database/object-store work. Routes also enforce configuration and reject opposite-mode provider objects/events, Connect and organization contexts. A `whsec_` prefix does not encode mode/account; signature verification and event `livemode` validate incoming events. Nonsecret `configured` readiness is a syntax check, not proof of valid credentials or account activation. Hosted redirects do not use `STRIPE_PUBLISHABLE_KEY` or any frontend publishable key.

Existing test collections `paymentorders` / `stripeevents` are preserved, including their indexes. Live records use separate `livepaymentorders` / `livestripeevents` collections with the same unique checkout/event constraints, without a data/index migration. Test payments never grant live access, or vice versa. Opposite-mode bookmarked orders return `404`; test pending orders cannot block live Checkout. Switching mode preserves records but hides the other mode's paid grants and outstanding orders. One deployment processes one mode at a time; opposite-mode webhook deliveries are rejected. Use a separate backend deployment if both modes must operate concurrently.

The pinned official Node SDK is **stripe 23.0.0**, with API version **2026-09-30.endive**, verified against its generated version and runtime configuration. The backend uses `npm ci` / `npm start`; no new worker/service/provider is required. Startup initializes the unique payment indexes. Preserve existing MongoDB, cookie/session, private R2, thumbnail and PDF settings. There are no conversion packages/assets in this release.

Deploy backend before frontend, then confirm the existing health endpoint and free course access. Both mode changes must be deployed: the earlier test-only backend still rejects live keys, and the earlier frontend rejects live Checkout responses. Adding a live Stripe destination or redeploying an older commit alone does not install this release.

## Webhook destination

Create a snapshot-event webhook destination for **Your account** in the matching mode/account: the same sandbox as the test key, or a **separate live destination** for the live key. Use API version **2026-09-30.endive**, and the existing public Render **backend** origin followed by:

```text
/api/payments/webhook
```

This is a public `POST` endpoint protected by Stripe's signature, with a 256 KiB raw JSON body limit. It runs before JSON parsing/session/sanitization middleware. Browser cookies or student credentials are not required. Use this destination's own `whsec_` signing secret in `STRIPE_WEBHOOK_SECRET`; a Stripe CLI listener's secret and another environment's secret are different.

Subscribe to:

```text
checkout.session.completed
checkout.session.async_payment_succeeded
checkout.session.async_payment_failed
checkout.session.expired
payment_intent.succeeded
payment_intent.payment_failed
payment_intent.canceled
charge.refunded
charge.dispute.created
charge.dispute.updated
charge.dispute.closed
```

The handler verifies the official signature/timestamp and retrieves canonical Session, PaymentIntent, Charge and, when applicable, Dispute state from Stripe. It checks configured mode on events and canonical provider objects, local order/student/course identity, payment mode, currency and exact amounts. The success-return query string never establishes payment. Unknown/other-account payments are ignored or rejected; failed processing returns a retryable error. Correctly signed, same-mode events outside the 11 supported types receive `200` with `ignored: true`, without order changes or provider API calls. Selecting all checkout/payment_intent/charge categories safely sends extra events; selecting only the list above avoids unnecessary deliveries. Invalid signatures, opposite-mode and Connect/organization events are rejected even for unsupported event types. Database event and per-order leases prevent concurrent work, and unique indexes prevent duplicate active checkout attempts. Canonical state makes stale success/expiry events safe after a refund or newer payment state.

Successful full/partial provider refunds, open disputes and lost/reversed disputes remove fresh paid-content access. A won dispute can restore paid status only when current canonical payment/refund state permits it. There is no in-app voluntary-refund action; this application behavior does not supersede provider or statutory requirements. Already-issued private R2 links remain bearer credentials until their existing expiry (normally five minutes); buffered/downloaded bytes cannot be revoked.

## Routes and retry behavior

- `GET /api/payments/courses/:courseId/quote`: student nomination check, server price/current paid state and nonsecret readiness. An unfinished checkout retains its original price snapshot.
- `POST /api/payments/checkout`: authenticated student, `{courseId, quotedAmountMinor}` and a stable `Idempotency-Key`; currency, price, account and destination come from the server. Repeated/different keys reuse the same active course checkout. Changed quotes are rejected before creating a new order; provider failures retain the order for safe retry.
- `GET /api/payments/orders/:orderId`: owner's order status only; private provider IDs/Checkout URL are not returned.
- `POST /api/payments/orders/:orderId/refresh`: owner-only canonical provider recheck for a delayed webhook; the user cannot post a paid status.
- `POST /api/payments/webhook`: signed raw-body snapshot events.

Checkout/provider-refresh calls are limited to 30 per student per 15 minutes in addition to the existing API limits. Stripe sets the Session deadline (normally 24 hours); the backend stores the returned `expires_at`. This is separate from course-access duration. The create request omits a timestamp fixed at local order creation: after a failed attempt, that old timestamp could fall below Stripe's minimum 30-minute creation window. An attached expired Session still requires status review. To retire an expired attempt when delivery is delayed, use **Check payment status** on its return page. Checkout uses Stripe's dynamic payment methods from the selected account's Dashboard settings; the backend does not send a static `payment_method_types` override. This matches the pinned SDK/API create contract and Stripe's documented migration. Stripe selects enabled methods eligible for the account, INR amount and customer; no specific method, including UPI, is guaranteed. Delayed completion remains locked until canonical Session/PaymentIntent/Charge state proves payment; the existing async success/failure webhook events handle later results. Account activation and method availability remain user-controlled and unverified.

## Method-selection correction

User-provided live diagnostics identified Stripe `400` / `StripeInvalidRequestError` on `payment_method_types`. The earlier request forced `["card"]`, but the pinned stripe 23.0.0 Checkout `SessionCreateParams` and current API create documentation omit that field. It remains present on response objects. The corrected create request omits the override and uses [Stripe's documented dynamic-method migration](https://docs.stripe.com/payments/payment-methods/dynamic-payment-methods). Browser-supplied method types/configuration are ignored; pricing, INR, mode, assignment and canonical paid/refund/dispute checks remain unchanged. The returned provider expiry replaces the provisional local deadline; neither expiry recovery nor method selection grants access. Live Checkout success is not claimed from local mocks.

## Immutable requests and legacy recovery

The follow-up live logs reported idempotency conflicts because the method/deadline correction changed parameters under an older provider key. New orders now atomically save a private immutable request snapshot, its creation time and a deterministic `checkout-v2` key before contacting Stripe. Every retry uses that same saved payload and key. Concurrent browser requests retain one active order and one provider operation. A changed frontend origin fails closed instead of silently changing the saved redirect URLs. Snapshots and recovery plans are excluded from browser DTOs.

Older attempts with no attached Session first list and validate matching provider Sessions, using pagination and the order's creation time. Recovery requires a complete scan within 500 Sessions and ten seconds; unavailable, mismatched or ambiguous results block replacement. An existing unpaid Session is reused. Completed/expired Sessions are canonically reconciled and sent to status review, preserving payment and access checks. If no Session exists, one immutable recovery plan preserves both known historical requests under the original key. It tries the current historical payload, then the original card/deadline payload only on an idempotency mismatch.

A new versioned operation is allowed only after a **replayed Stripe invalid-request `400`**, with no PaymentIntent on the error, plus a second complete empty Session scan. [Stripe's low-level error guidance](https://docs.stripe.com/error-low-level) distinguishes definitive client failures from indeterminate network/server failures and identifies cached replies with `Idempotent-Replayed`. Timeouts, `5xx`, non-replayed failures and unknown outcomes never rotate keys. The compare-and-set migration is additive; no order, event, payment record or assignment is reset/deleted. [Stripe can prune idempotency keys after 24 hours](https://docs.stripe.com/api/idempotent_requests), so old unattached attempts only reuse a found Session or stop for review; they do not blindly resend an expired operation. Local test/live cases cover concurrent migration, paginated reuse, already-paid reconciliation, mismatches, list outages, cached server failures and expired keys.

## Diagnosing Checkout errors

Application-generated Checkout `502` responses retain the pending order and use fixed public text. Render logs a JSON `stripe_payment_failure` record with operation (`checkout_create`, `checkout_reconcile`, `order_refresh`, `webhook_reconcile`), mode, Stripe error type, a fixed `reason` category and validated code/status/parameter/request ID when present. A cached response adds only the boolean `idempotentReplayed`. Raw provider messages, stacks, headers, URLs, payment objects, customer data and credentials are excluded. Known error codes/types and narrowly recognized method-availability wording map to fixed reasons; unfamiliar parameter-free `400` failures are `invalid_request_unclassified`, without an account/key guess. A fresh reason/request ID can narrow the remaining failure after deployment; the account owner can inspect that request in Workbench if needed. A generic `502` alone does not establish activation, authentication, validation or network failure. API readiness validates syntax, not account eligibility.

The reported `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` is a rate-limit validation log, not a Checkout failure response. Subsequent logged Checkout `502` responses after about two seconds require the provider diagnostic above. Proxy trust remains unchanged until the real trusted chain is verified; do not set `trust proxy=true` to suppress this warning. Render should use `NODE_ENV=production`, as already documented, so browser responses omit development stacks and production cookies use Secure. The user controls that private hosting setting.

## User-run hosted checks after deployment

Account activation, supported live methods, deployed cookies/proxy behavior and webhook delivery are not verified by local tests. The user reported setting private live credentials and creating a live destination; no credential values or account settings were inspected. For user-controlled live validation, confirm the deployed commits, `STRIPE_MODE=live`, matching private credentials and HTTPS origin; the paywall must show **Live payment** and **Continue to payment**. Any actual live purchase, refund or payout is the user's action, not part of agent validation. Stripe test card numbers belong only in test mode.

For sandbox validation with matching test settings:

1. Set an INR price on a synthetic course, add ready content and nominate a synthetic student. Keep a second student unassigned and a separate zero-price course for regression checks.
2. Sign in as the nominated student. The paid course must show a paywall and reveal no lessons/PDF links; the zero-price course should still open normally.
3. Open **Continue to test checkout**. Confirm the Stripe page is in test mode and shows the intended INR price. Use only Stripe's official test payment details, never a real card. Complete a test payment, return, and check that the webhook delivery receives `200`.
4. Confirm the server changes the order to `paid`, then open the course and test video sound, seek/renewal, PDF access and lesson completion. Revisit/reload; assignment is still required. The unassigned student and another instructor must remain denied.
5. Check canceled/declined test payments, retries and duplicate deliveries. In the Stripe test dashboard, simulate a refund/dispute when desired and verify new media/PDF requests become denied. No real refund or charge is needed.

Local checks use real HTTP, disposable MongoDB, official Stripe signature generation/verification and **mocked Stripe API calls**. They do not verify the user's keys, account activation, live payments, deployed webhook delivery or hosted sandbox Checkout. Private credentials were not inspected or transmitted by the agent.

Run `node --test tests/payments.test.js` or `npm test` with a disposable MongoDB on `TEST_MONGO_PORT` (default 27018). Tests create/drop only randomly named `lms_test_*` databases. Browser checks are documented in the frontend.

Primary references: [Stripe keys and mode isolation](https://docs.stripe.com/keys), [Stripe hosted Checkout](https://docs.stripe.com/payments/checkout/how-checkout-works), [webhook signatures and retries](https://docs.stripe.com/webhooks), [idempotent requests](https://docs.stripe.com/api/idempotent_requests), [INR minor units and limits](https://docs.stripe.com/currencies).
