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
  const refreshed = await currentProgress([{ student: req.user._id, course: lesson.course }]);
  return new ApiResponse(res, 200, "Lesson marked complete", { progress: refreshed.get(`${req.user._id}:${lesson.course}`) });
});
export const courseProgress = asyncHandler(async (req, res) => {
  await requireCourseAccess(req.params.id, req.user);
  const progress = await currentProgress([{ student: req.user._id, course: req.params.id }]);
  return new ApiResponse(res, 200, "Progress retrieved", { progress: progress.get(`${req.user._id}:${req.params.id}`) });
});
export const visitLesson = asyncHandler(async (req, res) => {
  const lesson = await Lesson.findById(req.params.id).populate("video", "status duration");
  if (!lesson) throw new ApiError(404, "Lesson unavailable.");
  await requireCourseAccess(lesson.course, req.user);
  if (!(lesson.contentType === "text" || lesson.contentType === "video" && lesson.video?.status === "ready")) throw new ApiError(409, "This lesson is not ready to resume.");
  const { position, revision, requestId } = req.body;
  if (!Number.isInteger(position) || position < 0 || position > 14400 || lesson.contentType === "text" && position !== 0 || lesson.video?.duration > 0 && position > Math.ceil(lesson.video.duration) || !Number.isSafeInteger(revision) || revision < 0 || typeof requestId !== "string" || !/^[a-f\d-]{36}$/i.test(requestId)) throw new ApiError(400, "Provide a valid position, version and stable request identifier.");
  const filter = { student: req.user._id, course: lesson.course }, current = await Progress.findOne(filter);
  if (current?.resumeRequestId !== requestId) {
    const fields = { resume: { lesson: lesson._id, position, visitedAt: new Date() }, resumeRequestId: requestId };
    let saved;
    if (current) saved = await Progress.findOneAndUpdate({ _id: current._id, ...(revision === 0 ? { $or: [{ resumeRevision: 0 }, { resumeRevision: { $exists: false } }] } : { resumeRevision: revision }) }, { $set: fields, $inc: { resumeRevision: 1 } }, { new: true });
    else {
      if (revision !== 0) throw new ApiError(409, "Your learning place changed. Reload before saving.");
      try { saved = await Progress.create({ ...filter, ...fields, resumeRevision: 1 }); }
      catch (e) { if (e.code !== 11000) throw e; saved = await Progress.findOne({ ...filter, resumeRequestId: requestId }); }
    }
    if (!saved) throw new ApiError(409, "Another visit updated your learning place. Reload the lesson before saving again.");
  }
  const progress = await currentProgress([{ student: req.user._id, course: lesson.course }]);
  return new ApiResponse(res, 200, "Learning place saved; completion unchanged", { progress: progress.get(`${req.user._id}:${lesson.course}`) });
});
