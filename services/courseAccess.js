import Course from "../models/Course.js";
import Enrollment from "../models/Enrollment.js";
import ApiError from "../utils/ApiError.js";
export const managesCourse = (course, user) => user.role === "admin" || (user.role === "instructor" && String(course.instructor._id || course.instructor) === String(user._id));
export async function requireCourseAccess(courseId, user) {
  const course = await Course.findById(courseId);
  if (!course) throw new ApiError(404, "Course not found");
  if (managesCourse(course, user)) return course;
  const assignment = user.role === "student" && course.isPublished && await Enrollment.exists({ student: user._id, course: course._id, assignedBy: { $exists: true } });
  if (!assignment) throw new ApiError(403, "This course is not assigned to your account or is not published.");
  return course;
}
