# Course enrollment and payment records

Every published, unarchived paid course is available for student purchase, including private and legacy courses. Verified payment automatically enrolls the buyer without instructor assignment. Free private courses still require assignment; free public courses offer explicit self-enrollment. Checkout requires ready learning materials. No production course is repriced or published automatically.

## Student flow

Choose a course from the catalog or student dashboard, then sign in or create a student account. A validated local return destination survives switching between login/signup and reloading. Authentication never automatically enrolls or charges the student. Free courses show **Enroll for free** and require an explicit action; this works without configured payment credentials. Paid courses show **Pay with Razorpay** in live mode. A captured, server-verified purchase automatically saves enrollment through signed checkout verification or webhook reconciliation, including when the student never returns to the website. Lessons, PDFs and published mock tests then open immediately; the dashboard retains the purchased course after reload. Pending, failed, canceled, expired, refunded and disputed attempts do not grant paid access.

`/payments` lists the signed-in student's attempts in the current server mode. `/payments/:id` shows the saved title/INR amount, reference, dates, status and refunded amount, plus current course-access availability. These records are not tax invoices. Other accounts and the other payment mode cannot read them. A return URL alone never grants access.

## Server rules

- `POST /api/courses/:id/enroll`: student authentication, Mongo ID and integer `quotedAmountMinor` required. This explicit enrollment endpoint remains restricted to current public courses; paid purchases fulfill enrollment automatically for either visibility setting. Free enrollment requires a zero quote; paid enrollment requires an owned, server-verified paid order in the current mode.
- `GET /api/payments/orders`: own current-mode history; bounded `page` (1–10000), `limit` (1–50, default 20). DTOs omit provider identifiers, checkout URLs, request keys and private account data.
- Existing quote/checkout/status/refresh/webhook routes are reused. Prices and mode remain server controlled. Stable provider contracts and active attempts preserve retry/idempotency behavior; an earlier pending amount is displayed separately from a changed current course price.
- Enrollment is unique per student/course. Free public consent and verified purchase modes are separate from `assignedBy`. The existing `publicPurchaseModes` field now stores purchases for either visibility setting; no data migration is needed. New payment orders use `enrollmentType: purchase`. Student library and course reads repair missing enrollment from existing current-mode paid records, preserving progress. An arbitrary unassigned record cannot grant access.
- Learning access always rechecks publication/archive and account authorization. A paid purchase remains valid if the instructor changes the free-enrollment/sample policy to Private. Paid courses require a current-mode paid order. A test purchase cannot become a live entitlement, even if a course is subsequently free. Explicit free enrollment remains valid across payment modes. Prior valid purchases remain recognized when prices change.
- Enrollment/progress are retained through repeated fulfillment, pricing/visibility changes, refunds and disputes. Removing an instructor assignment unsets only `assignedBy`, preserving progress and legitimate enrollment. Removing an assignment cannot revoke a verified purchase. A free public-enrollment flag alone does not grant private-course access. Refund/dispute status removes fresh paid-material access; a course explicitly made free uses free-access rules.

## Instructor flow

Create a paid course, save lessons or PDF notes, then use **Publish course** at the top of the curriculum. Assign students is optional for paid courses and does not waive their price. The public catalog offers **Sign in to buy**, and signed-in students can pay directly. Public/Private settings control free enrollment and anonymous samples; both allow purchases of published paid courses.

## Shared select correction

All single-value `select.input-field` controls reserve text padding and use a decorative chevron inset from the rounded right edge, including dark theme and admin dialogs. Browser-native selection and keyboard behavior remain intact. Forced-colors mode restores the native arrow; multiple selects are unchanged.

## Verification and boundaries

Backend tests use disposable local MongoDB and actual HTTP/signature verification with provider/storage APIs mocked. They cover free public enrollment, unassigned private/public purchases, legacy purchase recovery, canonical capture, duplicate requests/deliveries, free private-course rejection, account/mode isolation, current availability, pricing transitions, refunds and preserved progress. Frontend checks include authentication return-path security, existing session races, build/proxy checks, and isolated Chrome enrollment/history/payment/native-select flows in light/dark themes, mobile/desktop layouts and 200% zoom.

Razorpay is the payment provider. Server-created orders, signed checkout verification and signed webhooks confirm captured INR payments before access is granted. Existing payment records are retained. See [Razorpay setup and validation limits](razorpay-payments.md). No real charge, refund or payout is performed by automated tests. The visual refresh, assessments/practical exercises and optional acquisition are delivered in subsequent stages; see [current staged evidence](staged-release.md).
