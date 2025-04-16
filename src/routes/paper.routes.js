import express from "express";
import {
    // uploadPaper,
    getPapers,
    getPaperById,
    deletePaper,
    uploadPapers,
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

export default router;
