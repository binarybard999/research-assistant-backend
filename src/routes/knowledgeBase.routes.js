import express from "express";
import {
    getKnowledgeBaseByPaperId,
    getAllKnowledgeBaseEntries,
} from "../controllers/knowledgeBase.controller.js";
import { authMiddleware } from "../middlewares/auth.middleware.js";

const router = express.Router();

router.use(authMiddleware);

// Route to get knowledge base entry by paper ID
router.get("/:paperId", getKnowledgeBaseByPaperId);

// Route to get all knowledge base entries
router.get("/", getAllKnowledgeBaseEntries);

export default router;