import cloudinary from "../config/cloudinary.js";
import ApiError from "../utils/ApiError.js";
import Category from "../models/Category.js";
import Course from "../models/Course.js";
import Module from "../models/Module.js";
import Lesson from "../models/Lesson.js";
import VideoAsset from "../models/VideoAsset.js";
import Enrollment from "../models/Enrollment.js";
import Progress from "../models/Progress.js";

export const requireCourseOwner = async (courseId, user) => {
  const course = await Course.findById(courseId);
  if (!course) throw new ApiError(404, "Course not found");
  if (user.role !== "admin" && course.instructor.toString() !== String(user._id)) throw new ApiError(403, "You do not own this course");
  return course;
};
export const ensureCategory = async (categoryId) => {
  if (!(await Category.exists({ _id: categoryId }))) throw new ApiError(400, "Selected category does not exist");
};
export const uploadCourseThumbnail = (buffer) => {
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) throw new ApiError(503, "Image uploads are not configured");
  return new Promise((resolve, reject) => cloudinary.uploader.upload_stream({ folder: "lms/course-thumbnails", resource_type: "image" }, (error, result) => error ? reject(error) : resolve({ url: result.secure_url, publicId: result.public_id })).end(buffer));
};
export const courseCurriculum = async (courseId) => {
  const modules = await Module.find({ course: courseId }).sort("order").lean();
  const lessons = await Lesson.find({ course: courseId }).select("-contentUrl").populate("video", "status error filename size chunkSize chunkCount duration uploadMode").sort("order").lean();
  return modules.map((module) => ({ ...module, lessons: lessons.filter((lesson) => lesson.module.toString() === module._id.toString()) }));
};
export const deleteCourseWithContent = async (course) => {
  await VideoAsset.updateMany({ course: course._id }, { status: "cancelled" });
  await Enrollment.deleteMany({ course: course._id });
  await Progress.deleteMany({ course: course._id });
  await Promise.all([Lesson.deleteMany({ course: course._id }), Module.deleteMany({ course: course._id })]);
  await course.deleteOne();
};
