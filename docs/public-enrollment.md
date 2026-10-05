# Public enrollment and payment records (Stage 2)

Public discovery is separate from learning access. A course must currently be Public, published, unarchived and ready for enrollment. Existing private courses and legacy courses remain assignment controlled. This release does not reprice or publish production courses or invent course details, support contacts, policies or invoices.

## Student flow

Choose a public course, then sign in or create a student account. A validated local return destination survives switching between login/signup and reloading. Authentication never automatically enrolls or charges the student. Free courses show **Enroll for free** and require an explicit action; this works without configured payment credentials. Paid courses reuse the existing hosted checkout and canonical server verification. A settled public purchase automatically saves enrollment through webhook/reconciliation, including when the student never returns to the website. Pending, failed, canceled, expired, refunded and disputed attempts do not grant paid access.

`/payments` lists the signed-in student's attempts in the current server mode. `/payments/:id` shows the saved title/INR amount, reference, dates, status and refunded amount, plus current course-access availability. These records are not tax invoices. Other accounts and the other payment mode cannot read them. A return URL alone never grants access.

## Server rules

- `POST /api/courses/:id/enroll`: student authentication, Mongo ID and integer `quotedAmountMinor` required. Only a current public course is eligible. Free enrollment requires a zero quote; paid enrollment requires an owned, server-verified paid order in the current mode.
- `GET /api/payments/orders`: own current-mode history; bounded `page` (1–10000), `limit` (1–50, default 20). DTOs omit provider identifiers, checkout URLs, request keys and private account data.
- Existing quote/checkout/status/refresh/webhook routes are reused. Prices and mode remain server controlled. Stable provider contracts and active attempts preserve retry/idempotency behavior; an earlier pending amount is displayed separately from a changed current course price.
- Enrollment is unique per student/course. Public free consent and public purchase modes are separate from `assignedBy`. Old unassigned records are not automatically eligible. An explicit public checkout may adopt an earlier owned attempt without replacing its immutable provider request; passive quote/history reads cannot do that.
- Learning access always rechecks current course visibility/publication/archive and account authorization. Paid courses additionally require a current-mode paid order. A test public purchase cannot become a live entitlement, even if a course is subsequently free. Explicit free enrollment remains valid across payment modes. Prior valid purchases remain recognized when prices change.
- Enrollment/progress are retained through repeated fulfillment, pricing/visibility changes, refunds and disputes. Removing an instructor assignment unsets only `assignedBy`, preserving progress and legitimate public enrollment. A public flag never grants private-course access. Refund/dispute status removes fresh paid-material access; a course explicitly made free uses free-access rules.

## Shared select correction

All single-value `select.input-field` controls reserve text padding and use a decorative chevron inset from the rounded right edge, including dark theme and admin dialogs. Browser-native selection and keyboard behavior remain intact. Forced-colors mode restores the native arrow; multiple selects are unchanged.

## Verification and boundaries

Backend tests use disposable local MongoDB and actual HTTP/signature verification with provider/storage APIs mocked. They cover free/paid public enrollment, canonical settlement, duplicate requests/deliveries, private-course rejection, account/mode isolation, current availability, pricing transitions, refunds and preserved progress. Frontend checks include authentication return-path security, existing session races, build/proxy checks, and isolated Chrome enrollment/history/payment/native-select flows in light/dark themes, mobile/desktop layouts and 200% zoom.

The existing Stripe adapter is retained; no Indian gateway has been selected or implemented. No account is created, provider settings changed or real charge/refund/payout performed. Configuration syntax and local mocked success do not establish account eligibility, India availability, hosted checkout readiness or deployed webhook delivery. The previously reported live provider failure remains unverified. The visual refresh, assessments/practical exercises and consent/attribution are separate later increments.
