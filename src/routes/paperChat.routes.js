import express from "express";
import {
    processChatMessage,
    getChatHistory,
    addSystemMessage,
    getPaperDetails,
    chatUploadPaper,
} from "../controllers/paperChat.controller.js";
import { authMiddleware } from "../middlewares/auth.middleware.js";
import { chatUpload } from "../middlewares/multer.middleware.js";
import { checkChatUploadLimit } from "../middlewares/rateLimit.middleware.js";

const router = express.Router();

router.use(authMiddleware);

router.post("/:paperId/chat", processChatMessage);
router.get("/:paperId/chat/history", getChatHistory);
router.get("/:paperId/details", getPaperDetails);
router.post("/:paperId/system", addSystemMessage);
router.post(
    "/:chatId/upload",
    chatUpload.single("paper"),
    checkChatUploadLimit,
    chatUploadPaper
);

export default router;
