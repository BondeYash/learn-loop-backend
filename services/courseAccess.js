import Course from "../models/Course.js";
import Enrollment from "../models/Enrollment.js";
import ApiError from "../utils/ApiError.js";
import { paymentOrderModel } from "../models/PaymentOrder.js";
import { stripeMode } from "./stripeMode.js";
export const managesCourse = (course, user) => user.role === "admin" || (user.role === "instructor" && String(course.instructor._id || course.instructor) === String(user._id));
// Publication controls discovery. Full learning content separately requires an
// assignment or deliberate public enrollment, plus current-mode paid status.
export function hasCourseEnrollment(course, enrollment) {
  return Boolean(enrollment && (enrollment.assignedBy || course.visibility === "public" && (enrollment.publicFreeEnrollment || enrollment.publicPurchaseModes?.includes(stripeMode()))));
}
export async function courseEnrollment(course, user) {
  if (user.role !== "student" || !course.isPublished || course.archivedAt) return null;
  const enrollment = await Enrollment.findOne({ student: user._id, course: course._id });
  return hasCourseEnrollment(course, enrollment) ? enrollment : null;
}
export async function requireCheckoutEligibility(courseId, user) {
  const course = await Course.findById(courseId);
  if (!course) throw new ApiError(404, "Course not found");
  if (course.archivedAt) throw new ApiError(410, "This course has been archived and is unavailable.");
  if (user.role === "student" && course.isPublished && course.visibility === "public") return course;
  return requireCourseNomination(courseId, user);
}
export function catalogOutline(modules) {
  return modules.map((module) => ({
    _id: module._id,
    title: module.title,
    order: module.order,
    lessons: module.lessons.map((lesson) => ({ _id: lesson._id, title: lesson.title, contentType: lesson.contentType, order: lesson.order, locked: true })),
  }));
}
export async function requireCourseNomination(courseId, user) {
  const course = await Course.findById(courseId);
  if (!course) throw new ApiError(404, "Course not found");
  if (course.archivedAt) throw new ApiError(410, "This course has been archived and is unavailable.");
  if (managesCourse(course, user)) return course;
  if (!await courseEnrollment(course, user)) throw new ApiError(403, course.visibility === "public" && course.isPublished ? "Enroll in this course before opening its learning materials." : "This course is not assigned to your account or is not published.");
  return course;
}
export async function requireCourseAccess(courseId, user) {
  const course = await requireCourseNomination(courseId, user);
  if (managesCourse(course, user) || !course.price) return course;
  const mode = stripeMode();
  const payment = await paymentOrderModel(mode).exists({ student: user._id, course: course._id, status: "paid", testMode: mode === "test" });
  if (!payment) {
    const error = new ApiError(402, "Payment is required to access this course.");
    error.code = "PAYMENT_REQUIRED";
    error.courseId = String(course._id);
    throw error;
  }
  return course;
}
