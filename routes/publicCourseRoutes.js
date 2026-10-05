import { Router } from "express";
import { listPublicCourses, getPublicCourse, publicPreview, publicThumbnail } from "../controllers/publicCourseController.js";
const router = Router();
router.get("/courses", listPublicCourses);
router.get("/courses/:id", getPublicCourse);
router.get("/courses/:id/preview", publicPreview);
router.get("/courses/:id/thumbnail", publicThumbnail);
export default router;
