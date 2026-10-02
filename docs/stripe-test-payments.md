# Stripe test payments

This release uses one platform-owned Stripe account, INR, hosted Checkout and **test mode only**. No Connect transfers, split payouts, subscriptions, voluntary refund endpoint or live-payment path is included. Course prices remain INR rupees in the existing `Course.price` field; immutable orders store integer paise. Existing zero/unpriced courses are not migrated to paid courses.

An instructor/admin sets INR 0 for a free course or INR 0.50–999999.99 with at most two decimals. Assignment nominates a student; it **does not waive payment for a paid course**. A paid student needs a current assignment, an active account, a published/unarchived course and a verified `paid` order to read lessons/progress or receive fresh private video/PDF links. Owner/admin previews retain their existing role checks. Payment never creates an assignment, reopens an archived course, or clears learning progress. No timed access expiry has been added; the access-duration decision is still open. This is not a lifetime-access promise.

Published assigned courses remain visible on both the dashboard and course list before payment. Student-scoped summaries show required/pending/failed/paid/refund/dispute states and the INR price, without returning private provider IDs or URLs. A paid course remains visible when relocked. The dashboard's ready count excludes locked courses; Refresh reads fresh server state. Unassigned students and other instructors do not receive the course or its payment information.

## Backend configuration and deployment

Use the existing Render backend service's private Environment settings. Do not put secrets in chat, source control, frontend settings, `VITE_` variables or browser code.

```dotenv
STRIPE_SECRET_KEY=sk_test_REPLACE_PRIVATELY
STRIPE_WEBHOOK_SECRET=whsec_REPLACE_PRIVATELY
CLIENT_URL=https://YOUR_EXISTING_FRONTEND_ORIGIN
```

`CLIENT_URL` already exists and must be the exact HTTPS frontend origin, without a path, credentials, query string or fragment. Local localhost/127.0.0.1 development may use HTTP. Missing payment settings disable checkout without disabling free courses. A configured live secret key prevents backend startup. Payment routes also reject live keys, live provider objects, Connect and organization webhook contexts. Hosted Checkout redirects do not need `STRIPE_PUBLISHABLE_KEY` or a frontend publishable key. Any existing publishable environment variable is unused.

The pinned official Node SDK is **stripe 23.0.0**, with API version **2026-09-30.endive**, verified against its generated version and runtime configuration. The backend uses `npm ci` / `npm start`; no new worker/service/provider is required. Startup initializes the unique payment indexes. Preserve existing MongoDB, cookie/session, private R2, thumbnail and PDF settings. There are no conversion packages/assets in this release.

Deploy backend before frontend, then confirm the existing health endpoint and free course access. Until the new backend is deployed, the webhook route below does not exist on the public service. Adding a Stripe destination alone does not deploy application code.

## Webhook destination

In the same Stripe **test environment/sandbox** as the `sk_test_` key, create a snapshot-event webhook destination for **Your account**. Use API version **2026-09-30.endive**, and the existing public Render **backend** origin followed by:

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

The handler verifies the official signature/timestamp and retrieves canonical Session, PaymentIntent, Charge and, when applicable, Dispute state from Stripe. It checks test mode, local order/student/course identity, mode, currency and exact amounts. The success-return query string never establishes payment. Unknown/other-account payments are ignored or rejected; failed processing returns a retryable error. Database event and per-order leases prevent concurrent work, and unique indexes prevent duplicate active checkout attempts. Canonical state makes stale success/expiry events safe after a refund or newer payment state.

Successful full/partial provider refunds, open disputes and lost/reversed disputes remove fresh paid-content access. A won dispute can restore paid status only when current canonical payment/refund state permits it. There is no in-app voluntary-refund action; this application behavior does not supersede provider or statutory requirements. Already-issued private R2 links remain bearer credentials until their existing expiry (normally five minutes); buffered/downloaded bytes cannot be revoked.

## Routes and retry behavior

- `GET /api/payments/courses/:courseId/quote`: student nomination check, server price/current paid state and nonsecret readiness. An unfinished checkout retains its original price snapshot.
- `POST /api/payments/checkout`: authenticated student, `{courseId, quotedAmountMinor}` and a stable `Idempotency-Key`; currency, price, account and destination come from the server. Repeated/different keys reuse the same active course checkout. Changed quotes are rejected before creating a new order; provider failures retain the order for safe retry.
- `GET /api/payments/orders/:orderId`: owner's order status only; private provider IDs/Checkout URL are not returned.
- `POST /api/payments/orders/:orderId/refresh`: owner-only canonical provider recheck for a delayed webhook; the user cannot post a paid status.
- `POST /api/payments/webhook`: signed raw-body snapshot events.

Checkout/provider-refresh calls are limited to 30 per student per 15 minutes in addition to the existing API limits. Checkout sessions expire after approximately 31 minutes; this timeout is separate from course-access duration. To retire an expired attempt when delivery is delayed, use **Check payment status** on its return page. Card Checkout is the implemented method; UPI and other methods are not promised. Supported methods, country/account restrictions and deployed cookie/proxy behavior require a sandbox check in the user's actual account.

## User-run hosted sandbox check after deployment

1. Set an INR price on a synthetic course, add ready content and nominate a synthetic student. Keep a second student unassigned and a separate zero-price course for regression checks.
2. Sign in as the nominated student. The paid course must show a paywall and reveal no lessons/PDF links; the zero-price course should still open normally.
3. Open **Continue to test checkout**. Confirm the Stripe page is in test mode and shows the intended INR price. Use only Stripe's official test payment details, never a real card. Complete a test payment, return, and check that the webhook delivery receives `200`.
4. Confirm the server changes the order to `paid`, then open the course and test video sound, seek/renewal, PDF access and lesson completion. Revisit/reload; assignment is still required. The unassigned student and another instructor must remain denied.
5. Check canceled/declined test payments, retries and duplicate deliveries. In the Stripe test dashboard, simulate a refund/dispute when desired and verify new media/PDF requests become denied. No real refund or charge is needed.

Local checks use real HTTP, disposable MongoDB, official Stripe signature generation/verification and **mocked Stripe API calls**. They do not verify the user's keys, account activation, live payments, deployed webhook delivery or hosted sandbox Checkout. Private credentials were not inspected or transmitted by the agent.

Run `node --test tests/payments.test.js` or `npm test` with a disposable MongoDB on `TEST_MONGO_PORT` (default 27018). Tests create/drop only randomly named `lms_test_*` databases. Browser checks are documented in the frontend.

Primary references: [Stripe hosted Checkout](https://docs.stripe.com/payments/checkout/how-checkout-works), [webhook signatures and retries](https://docs.stripe.com/webhooks), [idempotent requests](https://docs.stripe.com/api/idempotent_requests), [INR minor units and limits](https://docs.stripe.com/currencies).
