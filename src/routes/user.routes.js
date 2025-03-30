import express from "express";
import {
    register,
    login,
    logout,
    refreshAccessToken,
    getCurrentUser,
} from "../controllers/user.controller.js";
import { authMiddleware } from "../middlewares/auth.middleware.js";

const router = express.Router();

router.post("/register", register);
router.post("/login", login);
router.post("/refresh-token", refreshAccessToken);
router.get("/current-user", authMiddleware, getCurrentUser);
router.post("/logout", authMiddleware, logout);

export default router;
