import { body, validationResult } from "express-validator";
import ApiError from "../utils/ApiError.js";

const password = body("password").custom((value) => typeof value === "string" && Buffer.byteLength(value, "utf8") <= 72).withMessage("Password must fit within 72 UTF-8 bytes").isLength({ min: 8, max: 72 }).withMessage("Password must be at least 8 characters long");
const email = body("email").isEmail().withMessage("Please provide a valid email address").trim().toLowerCase();

export const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return next(new ApiError(400, "Validation failed", errors.array()));
  next();
};

export const registerValidator = [
  body("name").trim().notEmpty().withMessage("Name is required").isLength({ max: 100 }).withMessage("Name must be at most 100 characters"),
  email,
  password,
  body("role").optional().isIn(["student", "instructor"]).withMessage("Invalid role"),
  validate,
];
export const loginValidator = [email, body("password").notEmpty().withMessage("Password is required"), validate];
export const forgotPasswordValidator = [email, validate];
export const resetPasswordValidator = [password, validate];
