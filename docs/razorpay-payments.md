# Razorpay course payments

Razorpay is the only active payment gateway. Course prices are INR rupees; the API converts them exactly to integer paise. New paid prices must be at least INR 1.00. Free enrollment remains available without payment credentials.

## Render configuration

Enter these privately in the backend service's Environment settings, then redeploy:

```dotenv
RAZORPAY_MODE=live
RAZORPAY_KEY_ID=your_live_key_id
RAZORPAY_KEY_SECRET=your_live_api_secret
RAZORPAY_WEBHOOK_SECRET=your_separate_random_webhook_secret
CLIENT_URL=https://praneet-vidyapeeth.online
```

The key ID must start with `rzp_live_` in live mode. Test mode is the default when `RAZORPAY_MODE` is absent and requires `rzp_test_` keys. Test and live payment records and webhook event IDs use separate collections; test payments cannot authorize live access. No private credential belongs in Git or a frontend `VITE_*` variable. The backend returns only the public key ID to the checkout widget.

The webhook secret is an independently generated random value of at least 16 characters. Enter the **same exact value** in Render and the Razorpay webhook Secret field. It is separate from the API key secret.

## Razorpay dashboard

1. Use **Live mode** for the live deployment. Confirm the activated account's website domain and enable **automatic capture** in payment capture settings. This integration grants access only after capture; it does not issue capture API calls.
2. Open **Account & Settings → Webhooks → Add new webhook**.
3. Recommended URL: `https://learn-loop-backend-qkq5.onrender.com/api/payments/razorpay/webhook`. This is the platform’s Render API; using it avoids browser checks on the frontend domain.
4. Secret: the same value configured as `RAZORPAY_WEBHOOK_SECRET` in Render.
5. Alert email: an address the operator monitors for delivery failures.
6. Select exactly `payment.captured`, `order.paid`, `payment.failed`, `refund.processed`.
7. After deployment, open the webhook URL in a browser. Its safe readiness response should show `provider: razorpay`, `mode: live`, `configured: true`. This confirms deployment and configuration syntax, not credential validity or dashboard delivery.
8. Create/enable the webhook. Do not create a Payment Page for this flow: students purchase through the platform's course page and Razorpay Standard Checkout.

Deployment check on 2026-10-12: the direct Render endpoint reports `mode: live`, `configured: true`, and rejects unsigned/invalid-signature POSTs with HTTP 400. The custom-domain endpoint is reachable with a browser user agent, but automated GET/POST requests returned HTTP 403 with Cloudflare error 1010. Use the direct Render URL for webhook delivery. The custom-domain URL can be used later after the operator exempts that exact webhook path from the relevant Cloudflare browser check and verifies a real dashboard delivery; do not disable protection across the entire site.

Use test keys and a separately configured Test-mode webhook to exercise the account without real charges. After switching to Live, the operator should deliberately make a purchase using a separate student account and confirm the Razorpay payment is **captured**, webhook delivery returns **2xx**, the payment record is **paid**, and enrollment/lesson access persists after reload. A simulated webhook or local fixture does not establish live account readiness.

## Implemented flow

- The authenticated student gets a server quote. Every published, ready paid course allows a deliberate student purchase without assignment, including private and legacy courses. Free private courses keep instructor-controlled enrollment.
- `POST /api/payments/checkout` saves an immutable quote and provider request, creates an order on the backend and returns its public checkout configuration. `Idempotency-Key` identifies a stable attempt. A lease and unique active student/course record prevent concurrent order creation. Interrupted creation is recovered by its exact receipt; an uncertain POST is not repeated automatically.
- The browser loads Razorpay's official checkout script only when the student chooses to pay. Success calls `POST /api/payments/orders/:orderId/verify`. The API verifies HMAC using the saved provider order ID and API secret, then reads canonical order/payment state. Authorization or a client success callback alone never opens lessons.
- Raw webhook bytes are authenticated with `X-Razorpay-Signature` before JSON/session middleware. Event IDs prevent duplicate processing, failed delivery can retry, and canonical reads prevent late failed events from undoing capture. Known captures allow parallel order/payment reads on refund delivery.
- `GET /api/payments/orders/:orderId` returns the saved status; a manual `/refresh` reconciles it with Razorpay. Captured purchases create enrollment idempotently for either visibility setting. Missing enrollment from prior paid records is repaired when the student opens their library or course. Instructor assignments remain separate and optional for buyers; archiving, unpublishing and suspended accounts retain access controls.
- Canonical partial/full refunds relock access based on that payment; an explicit instructor free-access grant remains valid until removed. Dashboard refund creation remains an operator action. This release does not automatically charge, capture, refund or pay instructors.

## Instructor free access

Instructors can grant complimentary access to selected registered students from the course curriculum. The API records `paymentWaivedAt` and `paymentWaivedBy` on their instructor assignment. It bypasses payment only for that student/course, without creating a paid order or changing the public price. The quote and library identify the waiver, and checkout refuses payment while it applies. Publication, archive, account and ownership checks still apply. Removing the assignment removes the waiver but preserves paid purchases and progress. Existing assignments remain unchanged until an instructor explicitly grants free access.

## Existing records and limitations

Existing payment collections and records are retained for history and paid access. Historical records are labelled generically and are read-only through the new gateway. An unfinished historical payment blocks a replacement checkout until an administrator resolves its outcome; this change does not drop financial data or indexes.

Razorpay orders have no hosted session expiry; no artificial expiry is added to new orders. Historical expiry timestamps remain available for older records. A definitive provider rejection or a canonical failed payment permits a new deliberate attempt; uncertain creation remains pending for recovery. Credential/account changes on an unfinished creation require operator review.

Refund events synchronize payments; chargebacks/disputes, reconciliation jobs for missed deliveries, tax invoices, automatic refunds and marketplace instructor settlements are follow-up work. Incoming webhook events use the account's canonical API state rather than trusting event amounts. Account API read failures leave confirmed access unchanged until reconciliation succeeds.

## Verification

`node --test tests/payments.test.js` exercises real HTTP cookie auth, raw HMAC webhooks and disposable MongoDB for both modes, with synthetic provider APIs. It covers stable creation/recovery, price/ownership/mode validation, captured-only access, duplicate/out-of-order delivery, refunds, unassigned private/public purchases, automatic dashboard enrollment, purchased mock-test access, publication and archive checks, and recovered historical purchases.

The paired frontend has checkout unit tests and `tests/payments_browser.py`, which forwards real UI requests to this API and disposable MongoDB while replacing only Razorpay provider calls and checkout SDK. No automated test reads live credentials or performs a real charge/refund/payout.

References: [Standard Checkout integration](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/), [webhook setup](https://razorpay.com/docs/webhooks/setup-edit-payments/), [webhook signature validation](https://razorpay.com/docs/webhooks/validate-test/), [payment events](https://razorpay.com/docs/webhooks/payments/), [refund events](https://razorpay.com/docs/webhooks/refunds/), [order recovery by receipt](https://razorpay.com/docs/api/orders/fetch-all/), [Cloudflare error 1010](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/).
