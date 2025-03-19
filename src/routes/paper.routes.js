import express from "express";
import {
    uploadPaper,
    getPapers,
    getPaperById,
    deletePaper
} from "../controllers/paper.controller.js";
import { authMiddleware } from "../middlewares/auth.middleware.js";
import uploadMiddleware from "../middlewares/multer.middleware.js";

const router = express.Router();

router.use(authMiddleware);

router.post("/upload", uploadMiddleware.single("file"), uploadPaper);
// router.post("/upload", upload.single("file"), uploadPaper);
router.get("/", getPapers);
router.get("/:id", getPaperById);
router.delete('/:id', deletePaper);

export default router;
