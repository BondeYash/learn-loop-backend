import { currentProgress, withCurrentCompletion } from "../services/currentProgress.js";
import User from "../models/User.js";
import Enrollment from "../models/Enrollment.js";
import Progress from "../models/Progress.js";
import Course from "../models/Course.js";
import { ensureCourseReady } from "../services/courseReadiness.js";
import { requireCourseOwner } from "../services/courseService.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
export const listAssignments = asyncHandler(async (req, res) => {
  await requireCourseOwner(req.params.id, req.user);
  const assignments = await Enrollment.find({ course: req.params.id, assignedBy: { $exists: true } }).populate("student", "name email").sort("-createdAt");
  const progress = await currentProgress(assignments);
  return new ApiResponse(res, 200, "Assignments retrieved", { assignments: assignments.map((item) => withCurrentCompletion(item.toObject(), progress.get(`${item.student._id}:${item.course}`))) });
});
export const assignStudents = asyncHandler(async (req, res) => {
  const course = await requireCourseOwner(req.params.id, req.user);
  if (req.body.makeAvailable !== undefined && typeof req.body.makeAvailable !== "boolean") throw new ApiError(400, "makeAvailable must be true or false");
  if (req.body.makeAvailable === true) await ensureCourseReady(course._id);
  if (!Array.isArray(req.body.emails) || !req.body.emails.length || req.body.emails.length > 100 || req.body.emails.some((email) => typeof email !== "string" || email.length > 254)) throw new ApiError(400, "Provide 1–100 registered student email addresses");
  const emails = [...new Set(req.body.emails.map((email) => email.trim().toLowerCase()))];
  const students = await User.find({ role: "student", email: { $in: emails } }).select("_id email");
  const missing = emails.filter((email) => !students.some((student) => student.email === email));
  if (missing.length) throw new ApiError(400, `These addresses are not registered student accounts: ${missing.join(", ")}`);
  await Enrollment.bulkWrite(students.map((student) => ({ updateOne: { filter: { student: student._id, course: course._id }, update: { $set: { assignedBy: req.user._id }, $setOnInsert: { status: "active", enrolledAt: new Date() } }, upsert: true } })));
  if (req.body.makeAvailable === true) {
    const shared = await Course.updateOne({ _id: course._id, archivedAt: null, instructor: course.instructor }, { isPublished: true, publishedAt: course.publishedAt || new Date() });
    if (!shared.matchedCount) throw new ApiError(409, "Course access changed. Assignments were saved, but access was not opened. Refresh the course.");
  }
  return new ApiResponse(res, 200, req.body.makeAvailable ? "Course shared with assigned students." : "Students assigned. Repeated assignments are safe.", { assigned: students.length });
});
export const revokeAssignment = asyncHandler(async (req, res) => {
  await requireCourseOwner(req.params.id, req.user);
  await Enrollment.deleteOne({ course: req.params.id, student: req.params.studentId });
  await Progress.deleteOne({ course: req.params.id, student: req.params.studentId });
  return new ApiResponse(res, 200, "Course access removed", {});
});
