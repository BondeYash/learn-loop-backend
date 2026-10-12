import Course from "../models/Course.js";
import User from "../models/User.js";
import { publicCourseFilter, catalogCourseFilter } from "./publicCatalog.js";
import { saveCourseEnrollment } from "./courseEnrollment.js";
import { paymentOrderModel } from "../models/PaymentOrder.js";
import { paymentMode } from "./paymentSettings.js";
import { ensureCourseReady } from "./courseReadiness.js";
import { requireCourseAccess } from "./courseAccess.js";
import ApiError from "../utils/ApiError.js";

export async function fulfillPurchase(order) {
  if (order.status !== "paid") return;
  const [course, student] = await Promise.all([Course.exists({ _id: order.course, ...catalogCourseFilter }), User.exists({ _id: order.student, role: "student", status: "active", mustChangePassword: false })]);
  if (course && student) await saveCourseEnrollment(order.student, order.course, order.testMode ? "test" : "live");
}
export async function enrollPublicCourse(courseId, user, quotedAmountMinor) {
  const course = await Course.findOne({ _id: courseId, ...publicCourseFilter });
  if (!course) throw new ApiError(404, "This public course is unavailable for enrollment.");
  await ensureCourseReady(course._id);
  let mode;
  if (course.price) {
    mode = paymentMode();
    if (!await paymentOrderModel(mode).exists({ student: user._id, course: course._id, status: "paid", testMode: mode === "test" })) throw new ApiError(402, "Complete verified payment before enrolling in this paid course.");
  } else if (quotedAmountMinor !== 0) throw new ApiError(409, "The course price changed. Refresh before enrolling.");
  const enrollment = await saveCourseEnrollment(user._id, course._id, mode);
  if (!await Course.exists({ _id: course._id, ...publicCourseFilter, price: course.price })) throw new ApiError(409, "The course changed while enrolling. Refresh before continuing.");
  await requireCourseAccess(course._id, user);
  return { courseId: String(course._id), enrollmentId: String(enrollment._id), access: true };
}
