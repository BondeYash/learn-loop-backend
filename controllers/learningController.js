import ApiResponse from "../utils/ApiResponse.js";
import ApiError from "../utils/ApiError.js";
import asyncHandler from "../utils/asyncHandler.js";
import Lesson from "../models/Lesson.js";
import Enrollment from "../models/Enrollment.js";
import Progress from "../models/Progress.js";
import { currentProgress, withCurrentCompletion } from "../services/currentProgress.js";
import { hasCourseEnrollment, requireCourseAccess } from "../services/courseAccess.js";
import { withCoursePayments } from "../services/coursePayments.js";
export const myEnrollments = asyncHandler(async (req, res) => {
  const enrollments = await Enrollment.find({ student: req.user._id }).populate({ path: "course", match: { isPublished: true, archivedAt: null }, populate: [{ path: "instructor", select: "name" }, { path: "category", select: "name" }] });
  const visible = enrollments.filter((item) => item.course && hasCourseEnrollment(item.course, item)).map((item) => item.toObject());
  const courses = new Map((await withCoursePayments(visible.map((item) => item.course), req.user._id)).map((course) => [String(course._id), course]));
  for (const item of visible) item.course = courses.get(String(item.course._id));
  const progress = await currentProgress(visible);
  return new ApiResponse(res, 200, "Enrolled courses retrieved", { enrollments: visible.map((item) => withCurrentCompletion(item, progress.get(`${item.student}:${item.course._id}`))) });
});
export const completeLesson = asyncHandler(async (req, res) => {
  const lesson = await Lesson.findById(req.params.id).populate("video", "status");
  if (!lesson) throw new ApiError(404, "Lesson not found");
  await requireCourseAccess(lesson.course, req.user);
  if (lesson.contentType === "video" && lesson.video?.status !== "ready") throw new ApiError(409, "This video is not ready");
  const total = await Lesson.countDocuments({ course: lesson.course });
  const progress = await Progress.findOneAndUpdate({ student: req.user._id, course: lesson.course }, { $addToSet: { completedLessons: lesson._id } }, { new: true, upsert: true, setDefaultsOnInsert: true });
  const existing = await Lesson.countDocuments({ course: lesson.course, _id: { $in: progress.completedLessons } });
  progress.percentage = total ? Math.min(100, Math.round(existing / total * 100)) : 0;
  await progress.save();
  await Enrollment.updateOne({ student: req.user._id, course: lesson.course }, progress.percentage === 100 ? { status: "completed", completedAt: new Date() } : { $set: { status: "active" }, $unset: { completedAt: 1 } });
  return new ApiResponse(res, 200, "Lesson marked complete", { progress });
});
export const courseProgress = asyncHandler(async (req, res) => {
  await requireCourseAccess(req.params.id, req.user);
  const progress = await currentProgress([{ student: req.user._id, course: req.params.id }]);
  return new ApiResponse(res, 200, "Progress retrieved", { progress: progress.get(`${req.user._id}:${req.params.id}`) });
});
