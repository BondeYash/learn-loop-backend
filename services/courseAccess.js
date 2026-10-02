import Course from "../models/Course.js";
import Enrollment from "../models/Enrollment.js";
import ApiError from "../utils/ApiError.js";
import { paymentOrderModel } from "../models/PaymentOrder.js";
import { stripeMode } from "./stripeMode.js";
export const managesCourse = (course, user) => user.role === "admin" || (user.role === "instructor" && String(course.instructor._id || course.instructor) === String(user._id));
export async function requireCourseNomination(courseId, user) {
  const course = await Course.findById(courseId);
  if (!course) throw new ApiError(404, "Course not found");
  if (course.archivedAt) throw new ApiError(410, "This course has been archived and is unavailable.");
  if (managesCourse(course, user)) return course;
  const assignment = user.role === "student" && course.isPublished && await Enrollment.exists({ student: user._id, course: course._id, assignedBy: { $exists: true } });
  if (!assignment) throw new ApiError(403, "This course is not assigned to your account or is not published.");
  return course;
}
export async function requireCourseAccess(courseId, user) {
  const course = await requireCourseNomination(courseId, user);
  if (managesCourse(course, user) || !course.price) return course;
  const mode = stripeMode();
  const payment = await paymentOrderModel(mode).exists({ student: user._id, course: course._id, status: "paid", testMode: mode === "test" });
  if (!payment) {
    const error = new ApiError(402, "Payment is required to access this assigned course.");
    error.code = "PAYMENT_REQUIRED";
    error.courseId = String(course._id);
    throw error;
  }
  return course;
}
