import Paper from "../models/paper.model.js";
import KnowledgeBase from "../models/knowledgeBase.model.js";
import ChatMessage from "../models/chatMessage.model.js";
import {
    SYSTEM_PROMPT,
    generateChatResponse,
    parseGeminiResponse,
    callFunctionByName,
} from "../services/gemini.service.js";
import asyncHandler from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import fs from "fs/promises";
import path from "path";
import pdfParse from "pdf-parse";
import mongoose from "mongoose";

// not used
export const getPaperDetails = asyncHandler(async (req, res) => {
    const { paperId } = req.params;
    const userId = req.user.id;

    const paper = await Paper.findOne({ _id: paperId, user: userId })
        .select("title authors abstract keywords createdAt")
        .lean();

    if (!paper) {
        throw new ApiError(404, "Paper not found");
    }

    res.json({
        success: true,
        data: formatPaperResponse(paper),
    });
});

export const processChatMessage = asyncHandler(async (req, res) => {
    const { paperId } = req.params;
    const { question } = req.body;
    const userId = req.user.id;

    if (!question?.trim()) throw new ApiError(400, "Question is required");

    const paper = await Paper.findOne({ _id: paperId, user: userId });
    if (!paper) throw new ApiError(403, "Unauthorized access");

    try {
        // Save user message first
        const userMessage = await ChatMessage.create({
            paper: paperId,
            user: userId,
            content: question,
            role: "user",
        });

        // Use a more direct approach - don't rely only on system message
        // Include a more explicit function-calling instruction with each user message
        const userPrompt = `
I'm asking you about a research paper with ID: ${paperId}. Please use the following tools to answer my question:
1. Use getPaperDetails() first to get basic information about the paper.
2. Use searchKnowledgeBase("${question}") to find relevant passages from the paper.
3. Use getChatHistory() if needed to see our previous conversation.

My question is: ${question}

Remember to respond in this JSON format:
\`\`\`json
{
  "function_call": {"name": "function_name", "parameters": {}},
  "thinking_process": "your reasoning here",
  "final_answer": null
}
\`\`\`
`;

        // Start with an empty message history (no system prompt here)
        const messageHistory = [{ role: "user", content: userPrompt }];

        const usedFunctions = new Set();
        let contextData = {};
        let finalAnswer = null;

        // Maximum number of turns to prevent infinite loops
        const MAX_TURNS = 5;
        let turns = 0;

        while (turns < MAX_TURNS) {
            turns++;

            const rawResponse = await generateChatResponse(messageHistory);
            const parsed = parseGeminiResponse(rawResponse);
            console.log("Gemini response (turn " + turns + "):", parsed);

            // Handle tool calling
            if (parsed.function_call?.name) {
                const { name, parameters } = parsed.function_call;
                let toolResult = null;

                try {
                    if (name === "getPaperDetails") {
                        toolResult = await callFunctionByName(
                            name,
                            paperId,
                            userId
                        );
                    } else if (name === "getChatHistory") {
                        toolResult = await callFunctionByName(
                            name,
                            paperId,
                            userId,
                            { limit: 5 }
                        );
                    } else if (name === "searchKnowledgeBase") {
                        toolResult = await callFunctionByName(
                            name,
                            paperId,
                            userId,
                            {
                                query: parameters?.query || question,
                            }
                        );
                    }

                    console.log(`Tool result (${name}):`, toolResult);

                    usedFunctions.add(name);
                    contextData[name] = toolResult;

                    // Add function response to message history
                    messageHistory.push({
                        role: "function",
                        name: name,
                        content: toolResult,
                    });

                    // Ask for next step or final answer
                    messageHistory.push({
                        role: "user",
                        content:
                            "Now that you have the information from " +
                            name +
                            ", please continue with the next function call or provide your final answer.",
                    });
                } catch (funcErr) {
                    console.error(`Error calling function ${name}:`, funcErr);
                    messageHistory.push({
                        role: "user",
                        content: `There was an error calling ${name}. Please try another approach or provide a final answer based on what you know.`,
                    });
                }
            } else {
                // No more function_call: it's the final answer
                finalAnswer =
                    parsed.final_answer || "I'm not sure how to answer that.";
                break;
            }
        }

        // Save assistant message only now
        const assistantMessage = await ChatMessage.create({
            paper: paperId,
            user: userId,
            content: finalAnswer,
            role: "assistant",
            metadata: {
                functionsUsed: [...usedFunctions],
                contextData: true,
            },
        });

        res.json({
            question: formatMessage(userMessage),
            answer: formatMessage(assistantMessage),
            context: contextData,
        });
    } catch (err) {
        throw new ApiError(500, "Chat processing failed", err);
    }
});

// not used
export const getChatHistory = asyncHandler(async (req, res) => {
    const { paperId } = req.params;
    const userId = req.user.id;

    const paper = await Paper.exists({ _id: paperId, user: userId });
    if (!paper) throw new ApiError(403, "Unauthorized access");

    const messages = await ChatMessage.find({
        paper: paperId,
        user: userId,
        role: { $in: ["user", "assistant"] },
    })
        .sort({ createdAt: 1 })
        .select("content role createdAt metadata")
        .lean();

    res.json(messages.map(formatMessage));
});

// not used
export const addSystemMessage = asyncHandler(async (req, res) => {
    const { paperId } = req.params;
    const { content } = req.body;
    const userId = req.user.id;

    if (!content?.trim()) throw new ApiError(400, "Content is required");

    const paper = await Paper.exists({ _id: paperId, user: userId });
    if (!paper) throw new ApiError(403, "Unauthorized access");

    const systemMessage = await ChatMessage.create({
        paper: paperId,
        user: userId,
        content: content.trim(),
        role: "system",
        metadata: { systemNote: true },
    });

    res.json(formatMessage(systemMessage));
});

export const chatUploadPaper = asyncHandler(async (req, res) => {
    const { chatId } = req.params;
    const file = req.file;
    const user = req.user;

    if (!file) throw new ApiError(400, "No file uploaded");

    try {
        // Validate chat ownership
        const chat = await ChatMessage.findById(chatId);
        if (!chat || chat.user.toString() !== user._id.toString()) {
            await fs.unlink(file.path);
            throw new ApiError(404, "Invalid chat session");
        }

        // Process paper
        const text = await extractTextFromPDF(file.buffer);
        const paper = await Paper.create({
            title: path.parse(file.originalname).name,
            content: text,
            user: user._id,
            fileSize: file.size,
        });

        // Update chat message with paper reference
        const updatedChat = await ChatMessage.findByIdAndUpdate(
            chatId,
            {
                $set: {
                    paper: paper._id,
                    metadata: {
                        ...chat.metadata,
                        uploadedPaper: paper._id,
                    },
                },
            },
            { new: true }
        ).lean();

        res.json({
            success: true,
            paper: formatPaperResponse(paper),
            chat: formatMessage(updatedChat),
        });
    } catch (err) {
        await fs.unlink(file.path).catch(() => {});
        throw new ApiError(500, "Paper upload failed", err);
    }
});

// Helper functions
function formatMessage(message) {
    return {
        id: message._id,
        content: message.content,
        role: message.role,
        createdAt: message.createdAt,
        metadata: message.metadata || {},
    };
}

function formatPaperResponse(paper) {
    return {
        id: paper._id,
        title: paper.title,
        abstract: paper.abstract,
        keywords: paper.keywords,
        createdAt: paper.createdAt,
    };
}

async function extractTextFromPDF(buffer) {
    try {
        const data = await pdfParse(buffer);
        return data.text.replace(/\s+/g, " ").trim();
    } catch (err) {
        throw new ApiError(400, "Invalid PDF file");
    }
}
