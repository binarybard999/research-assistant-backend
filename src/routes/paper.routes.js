import express from "express";
import {
    // uploadPaper,
    getPapers,
    getPaperById,
    deletePaper,
    uploadPapers,
    toggleFavorite,
    addAnnotation,
    getAnnotations,
    deleteAnnotation,
    updatePaperMetadata,
    getPaperCitations,
    addCitation,
    deleteCitation,
} from "../controllers/paper.controller.js";
import { authMiddleware } from "../middlewares/auth.middleware.js";
import { paperUpload } from "../middlewares/multer.middleware.js";
import { checkUploadLimit } from "../middlewares/rateLimit.middleware.js";

const router = express.Router();

router.use(authMiddleware);

const validateFiles = (req, res, next) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ message: "No files uploaded" });
    }
    next();
};

router.post(
    "/batch-upload",
    authMiddleware,
    paperUpload.array("files", 10),
    validateFiles,
    checkUploadLimit,
    uploadPapers
);

router.get("/", getPapers);
router.get("/:id", getPaperById);
router.delete("/:id", deletePaper);

// Paper CRUD operations
router.patch("/:id", updatePaperMetadata);

// Favorites
router.patch("/:id/favorite", toggleFavorite);

// Annotations
router.get("/:id/annotations", getAnnotations);
router.post("/:id/annotations", addAnnotation);
router.delete("/:id/annotations/:annotationId", deleteAnnotation);

// Citations
router.get("/:id/citations", getPaperCitations);
router.post("/:id/citations", addCitation);
router.delete("/:id/citations/:citationId", deleteCitation);

export default router;
