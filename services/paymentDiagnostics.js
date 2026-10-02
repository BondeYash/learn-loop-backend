// Provider messages/objects can contain secrets or customer data. Log only
// bounded diagnostic identifiers; use the request ID in Stripe Workbench.
const types = new Set(["StripeCardError", "StripeInvalidRequestError", "StripeAPIError", "StripeAuthenticationError", "StripePermissionError", "StripeRateLimitError", "StripeConnectionError", "StripeIdempotencyError"]);
const operations = new Set(["checkout_create", "checkout_reconcile", "order_refresh", "webhook_reconcile"]);
const privateIdentifier = /^(?:sk|rk|pk|whsec|cs|pi|ch|acct)_/i;
const params = new Set(["amount", "currency", "line_items", "metadata", "client_reference_id", "payment_intent_data", "payment_method_types", "mode", "success_url", "cancel_url", "expires_at", "customer", "customer_creation", "billing_address_collection", "automatic_tax", "tax_id_collection", "shipping_address_collection"]);
const parameterCodes = new Set(["parameter_missing", "parameter_unknown", "parameter_invalid_empty", "parameter_invalid_integer", "parameter_invalid_string_blank", "parameters_exclusive", "amount_too_small", "amount_too_large", "invalid_charge_amount"]);
const typeReasons = new Map(Object.entries({ StripeAuthenticationError: "authentication", StripePermissionError: "permission", StripeRateLimitError: "rate_limit", StripeConnectionError: "connection", StripeIdempotencyError: "idempotency_mismatch", StripeAPIError: "provider_api", StripeCardError: "card" }));

export function paymentFailureReason(error) {
  if (typeReasons.has(error?.type)) return typeReasons.get(error.type);
  if (error?.type !== "StripeInvalidRequestError") return "unknown";
  if (error.code === "testmode_charges_only") return "live_activation_required";
  if (parameterCodes.has(error.code)) return "request_parameters";
  // Recognize fixed wording only. No provider substring is ever returned or
  // logged; an unfamiliar no-code/no-param 400 remains explicitly unclassified.
  if (typeof error.message === "string" && error.message.length <= 2000 && /^(?:There are no valid payment method types for the Checkout session\.|No valid payment method types for this Checkout Session\.)(?:\s|$)/.test(error.message)) return "no_eligible_payment_methods";
  return "invalid_request_unclassified";
}

export function checkoutFailureMessage(error) {
  const messages = {
    live_activation_required: "Live payments need account setup. Please contact the course administrator.",
    no_eligible_payment_methods: "No eligible payment method is available for this checkout. Please contact the course administrator.",
    authentication: "Payment configuration needs attention. Please contact the course administrator.",
    permission: "Payment configuration needs attention. Please contact the course administrator.",
    request_parameters: "Payment setup needs attention. Please contact the course administrator.",
    idempotency_mismatch: "The saved payment attempt needs review. No replacement checkout was opened.",
    invalid_request_unclassified: "Stripe rejected this payment setup. Please contact the course administrator.",
  };
  return messages[paymentFailureReason(error)] || "Stripe checkout is temporarily unavailable. Retry this same payment attempt.";
}

export function paymentFailureDiagnostic(error, operation, mode) {
  const result = { event: "stripe_payment_failure", operation: operations.has(operation) ? operation : "unknown", mode: mode === "test" || mode === "live" ? mode : "unknown", type: types.has(error?.type) ? error.type : "UnknownError", reason: paymentFailureReason(error) };
  if (typeof error?.code === "string" && /^[a-z][a-z0-9_]{1,63}$/.test(error.code) && !privateIdentifier.test(error.code)) result.code = error.code;
  if (Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599) result.status = error.statusCode;
  if (typeof error?.requestId === "string" && /^req_[A-Za-z0-9]{1,80}$/.test(error.requestId)) result.requestId = error.requestId;
  if (error?.headers?.["idempotent-replayed"] === "true") result.idempotentReplayed = true;
  if (typeof error?.param === "string" && /^[a-z_]+(?:\[(?:[a-z_]+|[0-9]+)\])*$/.test(error.param) && error.param.length <= 120 && params.has(error.param.split("[")[0]) && !/(?:sk|rk|pk|whsec)_/i.test(error.param)) result.param = error.param;
  return result;
}

export function reportPaymentFailure(error, operation, mode) {
  console.error(JSON.stringify(paymentFailureDiagnostic(error, operation, mode)));
}
