import ApiError from "../utils/ApiError.js";

// Existing Course.price remains INR rupees. Convert decimal text to integer
// paise without binary floating-point multiplication or rounding extra digits.
export function rupeesToMinor(value) {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(text)) throw new ApiError(400, "Price must be INR 0–999999.99 with at most two decimal places.");
  const [whole, fraction = ""] = text.split(".");
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (amount !== 0 && amount < 50) throw new ApiError(400, "Paid course prices must be at least INR 0.50.");
  return amount;
}
