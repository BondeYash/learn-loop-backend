import { Router } from "express";
import { changeMyPassword, forgotPassword, getMe, login, logout, register, resetPasswordWithToken } from "../controllers/authController.js";
import { protectAccount } from "../middleware/auth.js";
import { changePasswordValidator, forgotPasswordValidator, loginValidator, registerValidator, resetPasswordValidator } from "../validators/authValidators.js";

const router = Router();

router.post("/register", registerValidator, register);
router.post("/login", loginValidator, login);
router.post("/logout", logout);
router.get("/me", protectAccount, getMe);
router.post("/change-password", protectAccount, changePasswordValidator, changeMyPassword);
router.post("/forgot-password", forgotPasswordValidator, forgotPassword);
router.post("/reset-password/:token", resetPasswordValidator, resetPasswordWithToken);

export default router;
