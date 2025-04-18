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

        // Initialize contextData and track used functions
        const usedFunctions = new Set();
        let contextData = {};
        let paperDetails = null; // Declare in outer scope

        // Start with initial context gathering
        try {
            // First get paper details
            paperDetails = await callFunctionByName(
                "getPaperDetails",
                paperId,
                userId
            );
            contextData["getPaperDetails"] = paperDetails;
            usedFunctions.add("getPaperDetails");

            // Initial search
            const initialSearchResult = await callFunctionByName(
                "searchKnowledgeBase",
                paperId,
                userId,
                { query: question }
            );

            // Fallback if no results
            if (!initialSearchResult || initialSearchResult.length === 0) {
                console.log("Initial search failed, trying individual terms");

                // Use QUESTION variable instead of undefined 'query'
                const queryTerms = question
                    .trim()
                    .split(/\s+/)
                    .filter((term) => term.length > 0);

                for (const term of queryTerms) {
                    const termResults = await callFunctionByName(
                        "searchKnowledgeBase",
                        paperId,
                        userId,
                        { query: term }
                    );
                    if (termResults.length > 0) {
                        contextData["searchKnowledgeBase"] = termResults;
                        usedFunctions.add("searchKnowledgeBase");
                        break;
                    }
                }
            } else {
                contextData["searchKnowledgeBase"] = initialSearchResult;
                usedFunctions.add("searchKnowledgeBase");
            }
        } catch (preSearchErr) {
            console.error("Initial context error:", preSearchErr);
        }

        // Build initial prompt with proper fallbacks
        let initialPrompt = `${SYSTEM_PROMPT}\n\n`;

        // Add paper details from contextData or direct paper object
        if (contextData.getPaperDetails) {
            initialPrompt += `Paper Details: ${JSON.stringify(contextData.getPaperDetails)}\n\n`;
        } else {
            initialPrompt += `Paper Title: ${paper.title}\nAbstract: ${paper.abstract}\n\n`;
        }

        // Add search context with fallback
        if (contextData.searchKnowledgeBase?.length > 0) {
            initialPrompt += `Relevant Context: ${JSON.stringify(contextData.searchKnowledgeBase)}\n\n`;
        } else {
            initialPrompt += `No relevant passages found. Using paper abstract:\n"${paper.abstract}"\n\n`;
        }

        initialPrompt += `My question is: ${question}\n\nPlease respond in JSON format with function_call if you need more info or final_answer if you can answer now.`;

        // Rest of the original logic remains the same
        const messageHistory = [{ role: "user", content: initialPrompt }];
        let finalAnswer = null;
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

                    // Provide better guidance based on function call results
                    if (name === "getPaperDetails") {
                        messageHistory.push({
                            role: "user",
                            content:
                                "Now that you have the paper details, please search for specific relevant information in the knowledge base. Use short, specific technical terms from the paper (like key concepts mentioned in the abstract or keywords) that would likely appear in explanatory passages.",
                        });
                    } else if (name === "searchKnowledgeBase") {
                        if (!toolResult || toolResult.length === 0) {
                            // If the search returned no results, try alternative searches
                            // Extract paper details if available
                            const paperDetails = contextData["getPaperDetails"];

                            if (
                                paperDetails &&
                                paperDetails.keywords &&
                                paperDetails.keywords.length > 0
                            ) {
                                // Suggest using keywords from the paper
                                const keywordSuggestions = paperDetails.keywords
                                    .slice(0, 3)
                                    .join(", ");
                                messageHistory.push({
                                    role: "user",
                                    content: `The search didn't return any results for "${parameters?.query || question}". Please try another search using more specific technical terms from the paper. Consider searching for these keywords from the paper: ${keywordSuggestions}, or try breaking down your query into smaller, more specific terms.`,
                                });
                            } else {
                                // Generic fallback if no keywords available
                                messageHistory.push({
                                    role: "user",
                                    content: `The search didn't return any results for "${parameters?.query || question}". Please try another search using different terms or concepts from the paper's abstract.`,
                                });
                            }
                        } else {
                            // Normal flow if search returned results
                            messageHistory.push({
                                role: "user",
                                content:
                                    "Based on these search results, please continue with any other function calls needed or provide your final answer. If these results don't fully answer the question, consider searching for additional relevant terms.",
                            });
                        }
                    } else {
                        // Default message for other function calls
                        messageHistory.push({
                            role: "user",
                            content:
                                "Now that you have the information from " +
                                name +
                                ", please continue with the next function call or provide your final answer.",
                        });
                    }
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

            // If we've reached the final turn and still have no answer, force a final response
            if (turns === MAX_TURNS - 1) {
                messageHistory.push({
                    role: "user",
                    content:
                        "Please provide your final answer based on the information you've gathered so far, even if it's incomplete.",
                });
            }
        }

        // Save assistant message
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
        console.error("Full error details:", {
            error: err,
            paperId,
            userId,
            question,
        });
        throw new ApiError(500, "Chat processing failed", err);
    }
});

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
