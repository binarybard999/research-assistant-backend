import express from "express";
import {
    processChatMessage,
    getChatHistory,
    addSystemMessage,
    getPaperDetails,
} from "../controllers/paperChat.controller.js";
import { authMiddleware } from "../middlewares/auth.middleware.js";

const router = express.Router();

router.use(authMiddleware);

// Process a chat message and get a response
router.post("/:paperId/chat", processChatMessage);

// Get chat history for a paper
router.get("/:paperId/chat/history", getChatHistory);

// Add route for paper details
router.get("/:paperId/details", getPaperDetails);

// Add the route for system messages
router.post("/:paperId/system", addSystemMessage);

export default router;
