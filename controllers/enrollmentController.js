import asyncHandler from "../utils/asyncHandler.js";
import ApiResponse from "../utils/ApiResponse.js";
import { enrollPublicCourse } from "../services/publicEnrollment.js";
import Course from "../models/Course.js";
import { captureAttribution } from "../services/acquisition.js";
import { stripeMode } from "../services/stripeMode.js";
export const enrollInPublicCourse = asyncHandler(async (req, res) => {
  const result = await enrollPublicCourse(req.params.id, req.user, req.body.quotedAmountMinor);
  if (req.body.attribution?.consent === true) { try { const course = await Course.findById(req.params.id); if (course?.price === 0 || stripeMode() === "live") await captureAttribution(course, req.user, req.body.attribution); } catch { /* Elective only. */ } }
  return new ApiResponse(res, 200, "You are enrolled in this course.", result);
});
