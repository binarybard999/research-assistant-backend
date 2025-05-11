import express from "express";
import { authMiddleware } from "../middlewares/auth.middleware.js";
import {
    getLists,
    createList,
    addToList,
    removeFromList,
    getPublicLists,
    updateList,
    deleteList,
    addCollaborator,
} from "../controllers/readingList.controller.js";

const router = express.Router();

router.use(authMiddleware);

// Basic CRUD operations
router.get("/", getLists);
router.post("/", createList);
router.put("/:id", updateList);
router.delete("/:id", deleteList);

// Managing papers in reading lists
router.post("/add", addToList);
router.delete("/:listId/papers", removeFromList);

// Public lists
router.get("/public", getPublicLists);

// Collaboration
router.post("/collaborator", addCollaborator);

export default router;
