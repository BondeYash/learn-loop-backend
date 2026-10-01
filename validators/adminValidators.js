import { body, param, query } from "express-validator";
import { passwordRule, validate } from "./authValidators.js";
import ApiError from "../utils/ApiError.js";
const only = (...fields) => (req, res, next) => {
  if (!req.body || Object.keys(req.body).some((key) => !fields.includes(key))) return next(new ApiError(400, "Unexpected account field"));
  next();
};
export const listValidator = [query("page").optional().isInt({ min: 1, max: 100000 }), query("limit").optional().isInt({ min: 1, max: 100 }), query("search").optional().isString().isLength({ max: 100 }), query("role").optional().isIn(["student", "instructor", "admin"]), query("status").optional().isIn(["active", "suspended"]), validate];
export const createInstructorValidator = [only("name", "email", "temporaryPassword"), body("name").isString().trim().isLength({ min: 1, max: 100 }), body("email").isEmail().trim().toLowerCase().isLength({ max: 254 }), passwordRule("temporaryPassword", 12), validate];
export const accessValidator = [only("status"), param("id").isMongoId(), body("status").isIn(["active", "suspended"]), validate];
export const temporaryPasswordValidator = [only("temporaryPassword"), param("id").isMongoId(), passwordRule("temporaryPassword", 12), validate];
export const transferValidator = [only("instructorId"), param("id").isMongoId(), body("instructorId").isMongoId(), validate];
