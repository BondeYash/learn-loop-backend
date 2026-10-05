import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import ApiError from "../utils/ApiError.js";
import Category from "../models/Category.js";
import Course from "../models/Course.js";
import Module from "../models/Module.js";
import Lesson from "../models/Lesson.js";
import Enrollment from "../models/Enrollment.js";
import Progress from "../models/Progress.js";
import CourseNote from "../models/CourseNote.js";
import Assessment from "../models/Assessment.js";
import AssessmentAttempt from "../models/AssessmentAttempt.js";
import { PracticalTask, PracticalRecord, CourseQuestion } from "../models/LearningSupport.js";
import VideoAsset from "../models/VideoAsset.js";
import { r2Client } from "./videoObjectStore.js";

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
const storageKey = (bucket, key) => bucket && key ? `${bucket}/${key}` : null;
export async function purgeCourse(courseId) {
  const course = await Course.findById(courseId).select("+thumbnail.objectKey +thumbnail.storageBucket");
  if (!course) throw new ApiError(404, "Course not found");
  const [notes, videos] = await Promise.all([
    CourseNote.find({ course: course._id }),
    VideoAsset.find({ course: course._id }),
  ]);
  const objects = new Map();
  const remember = (bucket, key) => { const id = storageKey(bucket, key); if (id) objects.set(id, { bucket, key }); };
  remember(course.thumbnail?.storageBucket, course.thumbnail?.objectKey);
  for (const note of notes) remember(note.storageBucket, note.objectKey);
  for (const video of videos) { remember(video.storageBucket, video.objectKey); remember(video.storageBucket, video.uploadKey); }
  if (objects.size) {
    try {
      const client = r2Client();
      await Promise.all([...objects.values()].map((object) => client.send(new DeleteObjectCommand({ Bucket: object.bucket, Key: object.key })).catch(() => {})));
    } catch { /* Missing storage configuration must not keep the course in the catalog. */ }
  }
  await Promise.all([
    Module.deleteMany({ course: course._id }),
    Lesson.deleteMany({ course: course._id }),
    Enrollment.deleteMany({ course: course._id }),
    Progress.deleteMany({ course: course._id }),
    CourseNote.deleteMany({ course: course._id }),
    Assessment.deleteMany({ course: course._id }),
    AssessmentAttempt.deleteMany({ course: course._id }),
    PracticalTask.deleteMany({ course: course._id }),
    PracticalRecord.deleteMany({ course: course._id }),
    CourseQuestion.deleteMany({ course: course._id }),
    VideoAsset.deleteMany({ course: course._id }),
  ]);
  const removed = await Course.deleteOne({ _id: course._id });
  if (!removed.deletedCount) throw new ApiError(409, "Course changed while it was being deleted. Refresh and retry.");
  return course;
}
