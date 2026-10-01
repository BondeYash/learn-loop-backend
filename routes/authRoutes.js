import { Router } from "express";
import { forgotPassword, getMe, login, logout, register, resetPasswordWithToken } from "../controllers/authController.js";
import { protect } from "../middleware/auth.js";
import { forgotPasswordValidator, loginValidator, registerValidator, resetPasswordValidator } from "../validators/authValidators.js";

const router = Router();

router.post("/register", registerValidator, register);
router.post("/login", loginValidator, login);
router.post("/logout", logout);
router.get("/me", protect, getMe);
router.post("/forgot-password", forgotPasswordValidator, forgotPassword);
router.post("/reset-password/:token", resetPasswordValidator, resetPasswordWithToken);

export default router;
