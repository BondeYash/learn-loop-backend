import { body, validationResult } from "express-validator";
import ApiError from "../utils/ApiError.js";

export const passwordRule = (field = "password", minimum = 8) => body(field).custom((value) => typeof value === "string" && Buffer.byteLength(value, "utf8") <= 72).withMessage("Password must fit within 72 UTF-8 bytes").isLength({ min: minimum, max: 72 }).withMessage(`Password must be at least ${minimum} characters long`);
const password = passwordRule();
const email = body("email").isEmail().withMessage("Please provide a valid email address").trim().toLowerCase();

export const validate = (req, res, next) => {
  const errors = validationResult(req);
  // express-validator includes submitted values by default, including passwords.
  if (!errors.isEmpty()) return next(new ApiError(400, "Validation failed", errors.array().map(({ msg, path, location }) => ({ msg, path, location }))));
  next();
};

export const registerValidator = [
  body("name").trim().notEmpty().withMessage("Name is required").isLength({ max: 100 }).withMessage("Name must be at most 100 characters"),
  email,
  password,
  body("role").optional().equals("student").withMessage("Instructor accounts must be created by an administrator"),
  validate,
];
export const loginValidator = [email, body("password").notEmpty().withMessage("Password is required"), validate];
export const forgotPasswordValidator = [email, validate];
export const resetPasswordValidator = [password, validate];
export const changePasswordValidator = [body("currentPassword").isString().isLength({ min: 1, max: 72 }), passwordRule("password", 12), validate];
