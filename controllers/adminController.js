import bcrypt from "bcryptjs";
import User from "../models/User.js";
import Session from "../models/Session.js";
import Course from "../models/Course.js";
import VideoAsset from "../models/VideoAsset.js";
import AuditEvent from "../models/AuditEvent.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import { publicUser } from "../services/authService.js";
import { purgeCourse } from "../services/courseService.js";

const listOptions = (req) => ({ page: Number(req.query.page) || 1, limit: Number(req.query.limit) || 25 });
const searchExpression = (value) => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
const account = (user) => ({ ...publicUser(user), createdAt: user.createdAt, temporaryPasswordExpiresAt: user.temporaryPasswordExpiresAt });
const success = (res, message, data, status = 200) => new ApiResponse(res, status, message, data);
const audit = (res, action, target) => { res.locals.auditAction = action; res.locals.auditTarget = String(target); };
export const overview = asyncHandler(async (req, res) => {
  const [instructors, students, suspended, courses, published, videos, ready] = await Promise.all([
    User.countDocuments({ role: "instructor" }), User.countDocuments({ role: "student" }), User.countDocuments({ status: "suspended" }),
    Course.countDocuments({ archivedAt: null }), Course.countDocuments({ isPublished: true, archivedAt: null }), VideoAsset.countDocuments(), VideoAsset.countDocuments({ status: "ready" }),
  ]);
  return success(res, "Platform overview", { instructors, students, suspended, courses, published, videos, ready });
});
export const listUsers = asyncHandler(async (req, res) => {
  const { page, limit } = listOptions(req);
  const filter = {};
  if (req.query.role) filter.role = req.query.role;
  if (req.query.status === "active") filter.status = { $ne: "suspended" };
  if (req.query.status === "suspended") filter.status = "suspended";
  if (req.query.search) { const search = searchExpression(req.query.search); filter.$or = [{ email: search }, { name: search }]; }
  const [users, total] = await Promise.all([User.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit), User.countDocuments(filter)]);
  return success(res, "Accounts retrieved", { users: users.map(account), total, page, limit });
});
export const createInstructor = asyncHandler(async (req, res) => {
  if (await User.exists({ email: req.body.email })) throw new ApiError(409, "An account already uses this email. No password or role was changed.");
  const user = await User.create({ name: req.body.name, email: req.body.email, password: req.body.temporaryPassword, role: "instructor", createdBy: req.user._id, mustChangePassword: true, temporaryPasswordExpiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000) });
  audit(res, "instructor.created", user._id);
  return success(res, "Instructor created. Share the temporary password privately; it expires in 72 hours.", { user: account(user) }, 201);
});
async function managedUser(id, actor) {
  const user = await User.findById(id);
  if (!user) throw new ApiError(404, "Account not found");
  if (String(user._id) === String(actor._id) || user.role === "admin") throw new ApiError(403, "Administrator access cannot be changed here. This protects against lockout.");
  return user;
}
export const setUserAccess = asyncHandler(async (req, res) => {
  const user = await managedUser(req.params.id, req.user);
  const status = req.body.status;
  // Increment even for a repeated suspension; old sessions must never be revived.
  const updated = await User.findOneAndUpdate({ _id: user._id, role: { $ne: "admin" } }, { $set: { status }, $inc: { authVersion: 1 }, $unset: { resetPasswordToken: 1, resetPasswordExpires: 1 } }, { new: true });
  if (!updated) throw new ApiError(409, "Account changed. Refresh and retry.");
  await Session.deleteMany({ user: user._id });
  audit(res, status === "suspended" ? "account.suspended" : "account.restored", user._id);
  return success(res, status === "suspended" ? "Account access paused. Existing sessions were revoked." : "Account access restored. The user must sign in again.", { user: account(updated) });
});
export const setTemporaryPassword = asyncHandler(async (req, res) => {
  const user = await managedUser(req.params.id, req.user);
  if (user.role !== "instructor") throw new ApiError(400, "Temporary passwords are managed here only for instructors");
  const password = await bcrypt.hash(req.body.temporaryPassword, 12);
  const updated = await User.findOneAndUpdate({ _id: user._id, role: "instructor" }, {
    $set: { password, mustChangePassword: true, temporaryPasswordExpiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000) },
    $inc: { authVersion: 1 }, $unset: { resetPasswordToken: 1, resetPasswordExpires: 1 },
  }, { new: true });
  if (!updated) throw new ApiError(409, "Account changed. Refresh and retry.");
  await Session.deleteMany({ user: user._id });
  audit(res, "instructor.password-reset", user._id);
  return success(res, "Temporary password replaced. Existing sessions were revoked; account access status is unchanged.", { user: account(updated) });
});
export const listVideos = asyncHandler(async (req, res) => {
  const { page, limit } = listOptions(req);
  const filter = req.query.search ? { filename: searchExpression(req.query.search) } : {};
  const [videos, total] = await Promise.all([
    VideoAsset.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).populate("owner", "name email").populate("course", "title isPublished archivedAt").populate("lesson", "title video"),
    VideoAsset.countDocuments(filter),
  ]);
  return success(res, "Video inventory retrieved", { videos: videos.map((video) => ({
    id: video._id, filename: video.filename, status: video.status, size: video.outputSize || video.size, duration: video.duration, createdAt: video.createdAt,
    owner: video.owner && { id: video.owner._id, name: video.owner.name, email: video.owner.email },
    course: video.course && { id: video.course._id, title: video.course.title, published: video.course.isPublished, archived: Boolean(video.course.archivedAt) },
    lesson: video.lesson && { id: video.lesson._id, title: video.lesson.title },
    attached: Boolean(video.lesson?.video && String(video.lesson.video) === String(video._id)),
  })), total, page, limit });
});
export const listAudit = asyncHandler(async (req, res) => {
  const { page, limit } = listOptions(req);
  const [events, total] = await Promise.all([AuditEvent.find().sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).populate("actor", "name email"), AuditEvent.countDocuments()]);
  return success(res, "Admin activity retrieved", { events: events.map((event) => ({ id: event._id, actor: event.actor && { name: event.actor.name, email: event.actor.email }, action: event.action, path: event.path, method: event.method, target: event.target, outcome: event.outcome, httpStatus: event.httpStatus, createdAt: event.createdAt })), total, page, limit });
});
export const listAdminCourses = asyncHandler(async (req, res) => {
  const { page, limit } = listOptions(req);
  const filter = { archivedAt: req.query.archived === "true" ? { $ne: null } : null, ...(req.query.search ? { title: searchExpression(req.query.search) } : {}) };
  const [courses, total] = await Promise.all([
    Course.find(filter).sort({ updatedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).populate("instructor", "name email status").populate("category", "name"),
    Course.countDocuments(filter),
  ]);
  return success(res, "All courses retrieved", { courses, total, page, limit });
});
export const transferCourse = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) throw new ApiError(404, "Course not found");
  if (course.archivedAt) throw new ApiError(409, "Restore this course before changing its instructor");
  const instructor = await User.findOne({ _id: req.body.instructorId, role: "instructor", status: { $ne: "suspended" } });
  if (!instructor) throw new ApiError(400, "Choose an active instructor account");
  if (String(course.instructor) === String(instructor._id)) return success(res, "This instructor already owns the course", { course });
  if (await VideoAsset.exists({ course: course._id, status: { $in: ["uploading", "verifying", "queued", "processing"] } })) throw new ApiError(409, "Finish or remove pending video uploads before transferring this course");
  const updated = await Course.findOneAndUpdate({ _id: course._id, instructor: course.instructor }, { instructor: instructor._id }, { new: true });
  if (!updated) throw new ApiError(409, "Course ownership changed. Refresh before retrying.");
  audit(res, "course.transferred", course._id);
  return success(res, "Course transferred. The previous instructor no longer has access; student assignments are preserved.", { course: updated });
});
export const deleteAdminCourse = asyncHandler(async (req, res) => {
  const course = await purgeCourse(req.params.id);
  audit(res, "course.deleted", course._id);
  return success(res, "Course deleted. It is removed from the catalog, and its lessons, assignments, and files are no longer available.", {});
});
