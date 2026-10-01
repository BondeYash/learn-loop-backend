import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import Category from "../models/Category.js";
import Course from "../models/Course.js";

export const listCategories = asyncHandler(async (req, res) => new ApiResponse(res, 200, "Categories retrieved", { categories: await Category.find().sort("name") }));
export const createCategory = asyncHandler(async (req, res) => new ApiResponse(res, 201, "Category created", { category: await Category.create(req.body) }));
export const updateCategory = asyncHandler(async (req, res) => { const category = await Category.findById(req.params.id); if (!category) throw new ApiError(404, "Category not found"); Object.assign(category, req.body); await category.save(); return new ApiResponse(res, 200, "Category updated", { category }); });
export const deleteCategory = asyncHandler(async (req, res) => { const category = await Category.findById(req.params.id); if (!category) throw new ApiError(404, "Category not found"); if (await Course.exists({ category: category._id })) throw new ApiError(409, "Cannot delete a category used by courses"); await category.deleteOne(); return new ApiResponse(res, 200, "Category deleted", {}); });
