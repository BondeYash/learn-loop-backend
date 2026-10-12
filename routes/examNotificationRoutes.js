import { Router } from "express";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import { examNotificationService } from "../services/examNotifications.js";

const router = Router();
router.get("/exam-notifications", asyncHandler(async (req, res) => {
  const service = req.app.locals.examNotificationService || examNotificationService;
  return new ApiResponse(res, 200, "Exam notifications", await service.get());
}));
export default router;
