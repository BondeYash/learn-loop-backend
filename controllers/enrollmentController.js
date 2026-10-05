import asyncHandler from "../utils/asyncHandler.js";
import ApiResponse from "../utils/ApiResponse.js";
import { enrollPublicCourse } from "../services/publicEnrollment.js";
export const enrollInPublicCourse = asyncHandler(async (req, res) => new ApiResponse(res, 200, "You are enrolled in this course.", await enrollPublicCourse(req.params.id, req.user, req.body.quotedAmountMinor)));
