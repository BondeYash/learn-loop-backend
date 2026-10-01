import { body, param } from "express-validator";
import { validate } from "./authValidators.js";
export const categoryValidator = [body("name").trim().notEmpty().withMessage("Category name is required").isLength({ max: 80 }), body("description").optional().trim().isLength({ max: 500 }), validate];
export const categoryIdValidator = [param("id").isMongoId().withMessage("Invalid category id"), validate];
