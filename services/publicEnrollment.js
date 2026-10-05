import Course from "../models/Course.js";
import User from "../models/User.js";
import Enrollment from "../models/Enrollment.js";
import { publicCourseFilter } from "./publicCatalog.js";
import { paymentOrderModel } from "../models/PaymentOrder.js";
import { stripeMode } from "./stripeMode.js";
import { ensureCourseReady } from "./courseReadiness.js";
import { requireCourseAccess } from "./courseAccess.js";
import ApiError from "../utils/ApiError.js";

async function savePublicEnrollment(student, course, mode) {
  const update = { $setOnInsert: { student, course, status: "active", enrolledAt: new Date() }, ...(mode ? { $addToSet: { publicPurchaseModes: mode } } : { $set: { publicFreeEnrollment: true } }) };
  try { return await Enrollment.findOneAndUpdate({ student, course }, update, { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }); }
  catch (error) { if (error.code !== 11000) throw error; return Enrollment.findOneAndUpdate({ student, course }, update, { new: true, runValidators: true }); }
}
export async function fulfillPublicPurchase(order) {
  if (order.status !== "paid" || order.enrollmentType !== "public" && !order.publicEnrollmentRequestedAt) return;
  // Existing private/legacy orders never create an assignment. These flags only
  // authorize a still-public course, and paid access rechecks canonical orders.
  const [course, student] = await Promise.all([Course.exists({ _id: order.course, ...publicCourseFilter }), User.exists({ _id: order.student, role: "student", status: "active", mustChangePassword: false })]);
  if (course && student) await savePublicEnrollment(order.student, order.course, order.testMode ? "test" : "live");
}
export async function enrollPublicCourse(courseId, user, quotedAmountMinor) {
  const course = await Course.findOne({ _id: courseId, ...publicCourseFilter });
  if (!course) throw new ApiError(404, "This public course is unavailable for enrollment.");
  await ensureCourseReady(course._id);
  let mode;
  if (course.price) {
    mode = stripeMode();
    if (!await paymentOrderModel(mode).exists({ student: user._id, course: course._id, status: "paid", testMode: mode === "test" })) throw new ApiError(402, "Complete verified payment before enrolling in this paid course.");
  } else if (quotedAmountMinor !== 0) throw new ApiError(409, "The course price changed. Refresh before enrolling.");
  const enrollment = await savePublicEnrollment(user._id, course._id, mode);
  if (!await Course.exists({ _id: course._id, ...publicCourseFilter, price: course.price })) throw new ApiError(409, "The course changed while enrolling. Refresh before continuing.");
  await requireCourseAccess(course._id, user);
  return { courseId: String(course._id), enrollmentId: String(enrollment._id), access: true };
}
