import { body, param } from "express-validator";
import { validate } from "./authValidators.js";
import { rupeesToMinor } from "../services/coursePricing.js";
import { safePublicUrl } from "../services/publicCatalog.js";
const priceField = () => body("price").optional().custom((value) => { rupeesToMinor(value); return true; }).customSanitizer((value) => rupeesToMinor(value) / 100);

const objectId = (field) => param(field).isMongoId().withMessage(`Invalid ${field}`);
const publicFields = () => [body("visibility").optional().isIn(["private", "public"]), ...Object.entries({ examName: 120, summary: 500, audience: 1000, publicInstructorName: 120, publicInstructorBio: 2000 }).map(([field, max]) => body(field).optional().isString().bail().trim().isLength({ max })), body("supportEmail").optional().isString().bail().trim().custom((value) => value === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254).withMessage("Use a valid support email or leave it blank."), ...["supportUrl", "termsUrl", "privacyPolicyUrl", "refundPolicyUrl"].map((field) => body(field).optional().isString().bail().trim().custom((value) => value === "" || value.length <= 2000 && safePublicUrl(value)).withMessage("Public links must use HTTPS without a username or password.")), body("previewLesson").optional({ nullable: true }).isMongoId().withMessage("Choose a valid sample lesson.")];
const courseFields = [
  body("title").trim().notEmpty().withMessage("Course title is required").isLength({ max: 160 }),
  body("description").trim().notEmpty().withMessage("Course description is required").isLength({ max: 10000 }),
  body("category").isMongoId().withMessage("A valid category is required"),
  priceField(),
  ...publicFields(),
  body("level").optional().isIn(["beginner", "intermediate", "advanced"]),
  body("language").optional().trim().isLength({ max: 50 }),
  body("requirements").optional().isArray(), body("requirements.*").optional().trim().isLength({ max: 300 }),
  body("learningOutcomes").optional().isArray(), body("learningOutcomes.*").optional().trim().isLength({ max: 300 }),
];
const lessonFields = [body("title").trim().notEmpty().withMessage("Lesson title is required").isLength({ max: 160 }), body("contentType").optional().isIn(["video", "pdf", "text"]), body("contentUrl").optional().trim().isURL().withMessage("Content URL must be valid"), body("content").optional().trim().isLength({ max: 50000 }), body("duration").optional().isFloat({ min: 0 }).toFloat(), body("order").optional().isInt({ min: 0 }).toInt(), body("isPreview").optional().isBoolean().toBoolean()];
export const createCourseValidator = [...courseFields, body("setupLessons").optional().isBoolean().toBoolean(), validate];
export const updateCourseValidator = [objectId("id"), body("title").optional().trim().notEmpty().isLength({ max: 160 }), body("description").optional().trim().notEmpty().isLength({ max: 10000 }), body("category").optional().isMongoId(), priceField(), ...publicFields(), body("level").optional().isIn(["beginner", "intermediate", "advanced"]), body("language").optional().trim().isLength({ max: 50 }), body("requirements").optional().isArray(), body("learningOutcomes").optional().isArray(), validate];
export const courseIdValidator = [objectId("id"), validate];
export const publishValidator = [objectId("id"), body("published").isBoolean().withMessage("published must be true or false").toBoolean(), validate];
export const moduleValidator = [objectId("id"), body("title").trim().notEmpty().withMessage("Module title is required").isLength({ max: 160 }), body("order").optional().isInt({ min: 0 }).toInt(), validate];
export const moduleIdValidator = [objectId("id"), objectId("moduleId"), validate];
export const lessonValidator = [objectId("id"), objectId("moduleId"), ...lessonFields, validate];
export const lessonIdValidator = [objectId("id"), objectId("lessonId"), validate];
export const updateLessonValidator = [objectId("id"), objectId("lessonId"), body("title").optional().trim().notEmpty().isLength({ max: 160 }), body("contentType").optional().isIn(["video", "pdf", "text"]), body("content").optional().isString().bail().trim().isLength({ max: 50000 }), body("contentUrl").optional().trim().isURL(), body("duration").optional().isFloat({ min: 0 }).toFloat(), body("order").optional().isInt({ min: 0 }).toInt(), body("isPreview").optional().isBoolean().toBoolean(), validate];
