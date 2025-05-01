import express from "express";
import { authMiddleware } from "../middlewares/auth.middleware.js";
import {
    getUserLibrary,
    getFavoritePapers,
    getFullPaperDetails,
    exportBundle,
    getRecommendations,
    getLibraryStats,
    exportCitations,
    bulkTagPapers,
    saveReadingSession,
    getTrendingPapers,
} from "../controllers/library.controller.js";
import { toggleFavorite } from "../controllers/paper.controller.js";

const router = express.Router();

router.use(authMiddleware);

// Basic library endpoints
router.get("/", getUserLibrary);
router.get("/favorites", getFavoritePapers);
router.get("/stats", getLibraryStats);
router.get("/trending", getTrendingPapers);

// Paper management
router.patch("/papers/:id/favorite", toggleFavorite);
router.get("/papers/:id/details", getFullPaperDetails);
router.get("/papers/:id/export", exportBundle);
router.get("/papers/:id/recommendations", getRecommendations);
router.post("/papers/reading-session", saveReadingSession);

// Bulk operations
router.post("/papers/tags", bulkTagPapers);
router.post("/papers/citations", exportCitations);

export default router;
