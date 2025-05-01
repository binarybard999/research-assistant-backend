import express from "express";
import { authMiddleware } from "../middlewares/auth.middleware.js";
import {
    getActivity,
    clearActivity,
    getActivityStats,
} from "../controllers/activity.controller.js";

const router = express.Router();

router.use(authMiddleware);

// Basic activity endpoints
router.get("/", getActivity);
router.delete("/", clearActivity);

// Statistics endpoint
router.get("/stats", getActivityStats);

export default router;
