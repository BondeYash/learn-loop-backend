import { DoubtSettings, DoubtUsage } from "../models/DoubtDost.js";
import ApiError from "../utils/ApiError.js";
export const DEFAULT_DOUBT_MODEL = "openai/gpt-oss-20b";
export const modelName = () => process.env.GROQ_MODEL || DEFAULT_DOUBT_MODEL;
const indiaDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
export const monthKey = () => `month:${indiaDate().slice(0, 7)}`;
export const dayKey = (user) => `day:${indiaDate()}:${user}`;
export async function doubtSettings() {
  return await DoubtSettings.findById("global") || new DoubtSettings();
}
export async function reserveUsage(id, field, amount, maximum) {
  try { await DoubtUsage.updateOne({ _id: id }, { $setOnInsert: { ...(/^(month|day):/.test(id) ? { expiresAt: new Date(Date.now() + 100 * 86400000) } : {}) } }, { upsert: true }); }
  catch (e) { if (e.code !== 11000) throw e; }
  const result = await DoubtUsage.findOneAndUpdate({ _id: id, [field]: { $lte: maximum - amount } }, { $inc: { [field]: amount } }, { new: true });
  if (!result) throw new ApiError(429, field === "bytes" || field === "documents" ? "The knowledge base storage or document allowance is full. An admin can remove PDFs or increase the allowance." : `Doubt Dost's ${id.startsWith("day:") ? "daily" : "monthly"} ${field === "pages" ? "PDF page" : "answer"} allowance has been reached. Please try later or ask your instructor.`);
  return result;
}
export async function answerAllowance(settings, user) {
  const monthly = monthKey(), daily = dayKey(user);
  await reserveUsage(monthly, "answers", 1, settings.monthlyAnswers);
  try { await reserveUsage(daily, "answers", 1, settings.dailyAnswers); }
  catch (e) { await DoubtUsage.updateOne({ _id: monthly }, { $inc: { answers: -1 } }); throw e; }
  return monthly;
}
