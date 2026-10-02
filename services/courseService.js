import ApiError from "../utils/ApiError.js";
import Category from "../models/Category.js";
import Course from "../models/Course.js";
import Module from "../models/Module.js";
import Lesson from "../models/Lesson.js";

export const requireCourseOwner = async (courseId, user, { allowArchived = false } = {}) => {
  const course = await Course.findById(courseId);
  if (!course) throw new ApiError(404, "Course not found");
  if (user.role !== "admin" && course.instructor.toString() !== String(user._id)) throw new ApiError(403, "You do not own this course");
  if (course.archivedAt && !allowArchived) throw new ApiError(410, "This course is archived. Restore it before making changes.");
  return course;
};
export const ensureCategory = async (categoryId) => {
  if (!(await Category.exists({ _id: categoryId }))) throw new ApiError(400, "Selected category does not exist");
};
export const courseCurriculum = async (courseId) => {
  const modules = await Module.find({ course: courseId }).sort("order").lean();
  const lessons = await Lesson.find({ course: courseId }).select("-contentUrl").populate("video", "status error filename size chunkSize chunkCount duration uploadMode").sort("order").lean();
  return modules.map((module) => ({ ...module, lessons: lessons.filter((lesson) => lesson.module.toString() === module._id.toString()) }));
};
export const archiveCourse = async (course, user) => {
  // One document controls access. Curriculum, progress, assignments and media are
  // retained for recovery; no permanent object deletion runs on this path.
  await Course.updateOne({ _id: course._id, archivedAt: null }, { $set: { archivedAt: new Date(), archivedBy: user._id, isPublished: false }, $unset: { publishedAt: 1 } });
};
export const restoreCourse = async (course) => {
  await Course.updateOne({ _id: course._id, archivedAt: { $ne: null } }, { $set: { archivedAt: null, isPublished: false }, $unset: { archivedBy: 1, publishedAt: 1 } });
};
