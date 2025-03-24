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

        // Save the user's message
        const userMessage = new ChatMessage({
            paper: paperId,
            user: userId,
            content: question,
            role: "user",
        });
        await userMessage.save();

        // Get chat history for this paper-user combination
        const chatHistory = await ChatMessage.find({
            paper: paperId,
            user: userId,
        }).sort({ createdAt: 1 });

        // Check if paper context has been provided yet in this conversation
        const hasContextMessage = chatHistory.some(
            (msg) =>
                msg.role === "system" && msg.content.includes("PAPER DETAILS:")
        );

        // Prepare content for the API call
        let prompt = "";
        let contextUsed = {
            paperDetailsIncluded: false,
            knowledgeBaseIncluded: false,
        };

        // We'll always include paper context in the prompt for reliability
        // This is the key change - not relying on the model's memory
        const knowledgeBase = await KnowledgeBase.findOne({
            paper: paperId,
        });

        prompt = `
You are an AI assistant helping with a research paper. Answer the following question about this paper:

PAPER DETAILS:
Title: ${paper.title}
Authors: ${paper.authors || "Not specified"}
Abstract: ${paper.abstract || "Not provided"}
Keywords: ${paper.keywords?.join(", ") || "None"}
`;
        contextUsed.paperDetailsIncluded = true;

        if (knowledgeBase) {
            prompt += `
KNOWLEDGE BASE:
Summary: ${knowledgeBase.aggregatedSummary || "Not available"}
Key Concepts: ${knowledgeBase.aggregatedKeywords?.join(", ") || "None"}
Explanations: ${knowledgeBase.aggregatedExplanations || "Not available"}
`;
            contextUsed.knowledgeBaseIncluded = true;
        }

        // Add recent message history (last 3-5 exchanges) for context
        // Excluding system messages
        const relevantHistory = chatHistory
            .filter((msg) => msg.role !== "system")
            .slice(-6); // Last 3 exchanges (3 user + 3 assistant messages)

        if (relevantHistory.length > 0) {
            prompt += `\nRECENT CONVERSATION:\n`;
            for (const msg of relevantHistory) {
                prompt += `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}\n\n`;
            }
        }

        // Add the current question
        prompt += `\nUser: ${question}\n\nAssistant: `;

        // If this is the first message in a conversation, create and save a system message
        if (!hasContextMessage) {
            const systemMessage = new ChatMessage({
                paper: paperId,
                user: userId,
                content: `PAPER DETAILS:\nTitle: ${paper.title}\nAuthors: ${paper.authors || "Not specified"}\nAbstract: ${paper.abstract || "Not provided"}\nKeywords: ${paper.keywords?.join(", ") || "None"}${knowledgeBase ? `\n\nKNOWLEDGE BASE:\nSummary: ${knowledgeBase.aggregatedSummary || "Not available"}\nKey Concepts: ${knowledgeBase.aggregatedKeywords?.join(", ") || "None"}\nExplanations: ${knowledgeBase.aggregatedExplanations || "Not available"}` : ""}`,
                role: "system",
            });
            await systemMessage.save();
        }

        // Get AI response using combined prompt
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
            contextUsed,
        });
    } catch (err) {
        console.error("Error processing chat message:", err);
        next(err);
    }
});

// Other functions remain the same
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

        // Get chat messages for this paper, excluding system messages
        const messages = await ChatMessage.find({
            paper: paperId,
            user: userId,
            role: { $ne: "system" }, // Exclude system messages from the frontend
        }).sort({ createdAt: 1 });

        res.json(messages);
    } catch (err) {
        console.error("Error getting chat history:", err);
        next(err);
    }
});

export const getPaperDetails = asyncHandler(async (req, res, next) => {
    const { paperId } = req.params;
    const userId = req.user.id;

    try {
        const paper = await Paper.findById(paperId);
        if (!paper) {
            return res.status(404).json({ message: "Paper not found" });
        }

        if (paper.user.toString() !== userId) {
            return res.status(403).json({
                message: "You don't have permission to access this paper",
            });
        }

        // Return only essential paper details
        res.json({
            title: paper.title,
            authors: paper.authors,
            abstract: paper.abstract,
            keywords: paper.keywords,
            citations: paper.citations,
        });
    } catch (err) {
        console.error("Error getting paper details:", err);
        next(err);
    }
});

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
