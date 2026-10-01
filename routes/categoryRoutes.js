import { Router } from "express";
import { createCategory, deleteCategory, listCategories, updateCategory } from "../controllers/categoryController.js";
import { authorize, protect } from "../middleware/auth.js";
import { categoryIdValidator, categoryValidator } from "../validators/categoryValidators.js";
const router = Router();
router.get("/", listCategories); router.post("/", protect, authorize("admin"), categoryValidator, createCategory); router.patch("/:id", protect, authorize("admin"), categoryIdValidator, categoryValidator, updateCategory); router.delete("/:id", protect, authorize("admin"), categoryIdValidator, deleteCategory);
export default router;
