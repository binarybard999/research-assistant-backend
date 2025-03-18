import Paper from "../models/paper.model.js";
import KnowledgeBase from "../models/knowledgeBase.model.js";
import ChatMessage from "../models/chatMessage.model.js";
import geminiService from "../services/gemini.service.js";
import asyncHandler from "../utils/asyncHandler.js";

// Process a chat message and get a response
export const processChatMessage = asyncHandler(async (req, res, next) => {
    const { paperId } = req.params;
    const { question } = req.body;
    const userId = req.user.id;

    try {
        // Get the paper and knowledge base
        const paper = await Paper.findById(paperId);
        if (!paper) {
            return res.status(404).json({ message: "Paper not found" });
        }

        // Check if the user has access to this paper
        if (paper.user.toString() !== userId) {
            return res.status(403).json({
                message: "You don't have permission to access this paper",
            });
        }

        // Get the knowledge base for context
        const knowledgeBase = await KnowledgeBase.findOne({ paper: paperId });

        // Save the user's message
        const userMessage = new ChatMessage({
            paper: paperId,
            user: userId,
            content: question,
            role: "user",
        });
        await userMessage.save();

        // Create a prompt for the AI using the paper content and question
        const prompt = `
      Based on the following paper information:
      
      Title: ${paper.title}
      Abstract: ${paper.abstract || "Not provided"}
      Keywords: ${paper.keywords?.join(", ") || "None"}
      
      ${
          knowledgeBase
              ? `
      Summary: ${knowledgeBase.aggregatedSummary || "Not available"}
      Key concepts: ${knowledgeBase.aggregatedKeywords?.join(", ") || "None"}
      `
              : ""
      }
      
      Please answer the following question about this paper:
      ${question}
    `;

        // Get response from the AI service
        const aiResponse = await geminiService.generateResponse(prompt);

        // Save the AI's response
        const assistantMessage = new ChatMessage({
            paper: paperId,
            user: userId,
            content: aiResponse,
            role: "assistant",
        });
        await assistantMessage.save();

        // Return both messages
        res.json({
            userMessage: userMessage,
            assistantMessage: assistantMessage,
        });
    } catch (err) {
        console.error("Error processing chat message:", err);
        next(err);
    }
});

// Get chat history for a paper
export const getChatHistory = asyncHandler(async (req, res, next) => {
    const { paperId } = req.params;
    const userId = req.user.id;

    try {
        // First verify the user has access to this paper
        const paper = await Paper.findById(paperId);
        if (!paper) {
            return res.status(404).json({ message: "Paper not found" });
        }

        if (paper.user.toString() !== userId) {
            return res.status(403).json({
                message: "You don't have permission to access this paper",
            });
        }

        // Get chat messages for this paper
        const messages = await ChatMessage.find({
            paper: paperId,
            user: userId,
        }).sort({ createdAt: 1 });

        res.json(messages);
    } catch (err) {
        console.error("Error getting chat history:", err);
        next(err);
    }
});

// Process a system message (for notifications, etc.)
export const addSystemMessage = asyncHandler(async (req, res, next) => {
    const { paperId } = req.params;
    const { content } = req.body;
    const userId = req.user.id;

    try {
        // Get the paper
        const paper = await Paper.findById(paperId);
        if (!paper) {
            return res.status(404).json({ message: "Paper not found" });
        }

        // Check if the user has access to this paper
        if (paper.user.toString() !== userId) {
            return res.status(403).json({
                message: "You don't have permission to access this paper",
            });
        }

        // Save the system message
        const systemMessage = new ChatMessage({
            paper: paperId,
            user: userId,
            content: content,
            role: "system",
        });
        await systemMessage.save();

        // Return the message
        res.json({
            message: "System message added successfully",
            systemMessage: systemMessage,
        });
    } catch (err) {
        console.error("Error adding system message:", err);
        next(err);
    }
});
