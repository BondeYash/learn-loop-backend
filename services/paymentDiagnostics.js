// Provider messages/objects can contain secrets or customer data. Log only
// bounded diagnostic identifiers; use the request ID in Stripe Workbench.
const types = new Set(["StripeCardError", "StripeInvalidRequestError", "StripeAPIError", "StripeAuthenticationError", "StripePermissionError", "StripeRateLimitError", "StripeConnectionError", "StripeIdempotencyError"]);
const operations = new Set(["checkout_create", "order_refresh", "webhook_reconcile"]);
const privateIdentifier = /^(?:sk|rk|pk|whsec|cs|pi|ch|acct)_/i;
const params = new Set(["amount", "currency", "line_items", "metadata", "client_reference_id", "payment_intent_data", "payment_method_types", "mode", "success_url", "cancel_url", "expires_at", "customer", "customer_creation", "billing_address_collection", "automatic_tax", "tax_id_collection", "shipping_address_collection"]);

export function paymentFailureDiagnostic(error, operation, mode) {
  const result = { event: "stripe_payment_failure", operation: operations.has(operation) ? operation : "unknown", mode: mode === "test" || mode === "live" ? mode : "unknown", type: types.has(error?.type) ? error.type : "UnknownError" };
  if (typeof error?.code === "string" && /^[a-z][a-z0-9_]{1,63}$/.test(error.code) && !privateIdentifier.test(error.code)) result.code = error.code;
  if (Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599) result.status = error.statusCode;
  if (typeof error?.requestId === "string" && /^req_[A-Za-z0-9]{1,80}$/.test(error.requestId)) result.requestId = error.requestId;
  if (typeof error?.param === "string" && /^[a-z_]+(?:\[(?:[a-z_]+|[0-9]+)\])*$/.test(error.param) && error.param.length <= 120 && params.has(error.param.split("[")[0]) && !/(?:sk|rk|pk|whsec)_/i.test(error.param)) result.param = error.param;
  return result;
}

export function reportPaymentFailure(error, operation, mode) {
  console.error(JSON.stringify(paymentFailureDiagnostic(error, operation, mode)));
}
