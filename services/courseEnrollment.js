import Course from "../models/Course.js";
import Enrollment from "../models/Enrollment.js";
import { paymentOrderModel } from "../models/PaymentOrder.js";
import { paymentMode } from "./paymentSettings.js";

export async function saveCourseEnrollment(student, course, mode) {
  // Keep the existing field for compatibility with saved enrollments. A purchase
  // now enrolls the buyer regardless of the course's free-enrollment policy.
  const update = { $setOnInsert: { student, course, status: "active", enrolledAt: new Date() }, ...(mode ? { $addToSet: { publicPurchaseModes: mode } } : { $set: { publicFreeEnrollment: true } }) };
  try { return await Enrollment.findOneAndUpdate({ student, course }, update, { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }); }
  catch (error) { if (error.code !== 11000) throw error; return Enrollment.findOneAndUpdate({ student, course }, update, { new: true, runValidators: true }); }
}

// Repair older purchases and interrupted fulfillment when the student opens
// their library. The current payment collection remains the access authority.
export async function restorePurchasedEnrollments(student) {
  const mode = paymentMode();
  const purchased = await paymentOrderModel(mode).distinct("course", { student, status: "paid", testMode: mode === "test" });
  if (!purchased.length) return;
  const [courses, enrolled] = await Promise.all([
    Course.find({ _id: { $in: purchased }, isPublished: true, archivedAt: null }).select("_id").lean(),
    Enrollment.distinct("course", { student, course: { $in: purchased }, publicPurchaseModes: mode }),
  ]);
  const existing = new Set(enrolled.map(String));
  await Promise.all(courses.filter(course => !existing.has(String(course._id))).map(course => saveCourseEnrollment(student, course._id, mode)));
}
