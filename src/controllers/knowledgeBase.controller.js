import mongoose from "mongoose";
import Paper from "../models/paper.model.js";
import KnowledgeBase from "../models/knowledgeBase.model.js";
import asyncHandler from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";

// Get Knowledge Base Entry by Paper ID
export const getKnowledgeBaseByPaperId = asyncHandler(async (req, res) => {
    const { paperId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(paperId)) {
        throw new ApiError(400, "Invalid paper ID");
    }
    const knowledgeEntry = await KnowledgeBase.findOne({ paper: paperId });

    if (!knowledgeEntry) {
        throw new ApiError(404, "Knowledge base entry not found");
    }

    res.json(knowledgeEntry);
});

// Get All Knowledge Base Entries
export const getAllKnowledgeBaseEntries = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();

    // Step 1: Get all paper IDs that belong to the logged-in user
    const userPapers = await Paper.find({ user: userId }).select("_id").lean();

    const userPaperIds = userPapers.map((paper) => paper._id);

    if (!userPaperIds.length) {
        throw new ApiError(404, "No papers found for the current user");
    }

    // Step 2: Find knowledge entries that match those paper IDs
    const knowledgeEntries = await KnowledgeBase.find({
        paper: { $in: userPaperIds },
    });

    // const knowledgeEntries = await KnowledgeBase.find({
    //     paper: { $in: userPaperIds },
    // }).populate("paper"); // or select specific fields like .populate("paper", "title createdAt")

    if (!knowledgeEntries.length) {
        throw new ApiError(
            404,
            "No knowledge base entries found for your papers"
        );
    }

    res.json(knowledgeEntries);
});
