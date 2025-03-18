import KnowledgeBase from "../models/knowledgeBase.model.js";
import asyncHandler from "../utils/asyncHandler.js";

// Get Knowledge Base Entry by Paper ID
export const getKnowledgeBaseByPaperId = asyncHandler(
    async (req, res, next) => {
        const { paperId } = req.params;

        const knowledgeEntry = await KnowledgeBase.findOne({ paper: paperId });

        if (!knowledgeEntry) {
            return res
                .status(404)
                .json({ message: "Knowledge base entry not found" });
        }

        res.json(knowledgeEntry);
    }
);

// Get All Knowledge Base Entries
export const getAllKnowledgeBaseEntries = asyncHandler(
    async (req, res, next) => {
        const knowledgeEntries = await KnowledgeBase.find();

        if (!knowledgeEntries.length) {
            return res
                .status(404)
                .json({ message: "No knowledge base entries found" });
        }

        res.json(knowledgeEntries);
    }
);
