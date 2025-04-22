import Paper from "../models/paper.model.js";
import KnowledgeBase from "../models/knowledgeBase.model.js";
import ChatMessage from "../models/chatMessage.model.js";
import {
    SYSTEM_PROMPT,
    generateChatResponse,
    parseGeminiResponse,
    callFunctionByName,
    PAPER_CONTEXT_CACHE,
    SEARCH_RESULT_CACHE,
    memoryCache
} from "../services/gemini.service.js";
import asyncHandler from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import fs from "fs/promises";
import path from "path";
import pdfParse from "pdf-parse";
import mongoose from "mongoose";

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

const buildInitialPrompt = (paper, contextData, question) => {
    let prompt = `${SYSTEM_PROMPT}\n\n`;

    prompt += contextData.getPaperDetails
        ? `Paper Details: ${JSON.stringify(contextData.getPaperDetails)}\n\n`
        : `Paper Title: ${paper.title}\nAbstract: ${paper.abstract}\n\n`;

    prompt +=
        contextData.searchKnowledgeBase?.length > 0
            ? `Relevant Context: ${JSON.stringify(contextData.searchKnowledgeBase)}\n\n`
            : `No relevant passages found. Using paper abstract:\n"${paper.abstract}"\n\n`;

    return (
        prompt + `My question is: ${question}\n\nPlease respond in JSON format.`
    );
};

const handleFunctionCall = async (name, paperId, userId, params) => {
    const validFunctions = new Set([
        "getPaperDetails",
        "searchKnowledgeBase",
        "getChatHistory",
    ]);

    if (!validFunctions.has(name)) {
        throw new Error(
            `Invalid function call: ${name}. Valid options: ${[...validFunctions].join(", ")}`
        );
    }

    return callFunctionByName(name, paperId, userId, params);
};

const validateResponseStructure = (parsed) => {
    // Allow empty evidence for general responses
    if (
        parsed.final_answer?.content &&
        parsed.final_answer.content.main_idea &&
        !parsed.thinking_process
    ) {
        return null; // General conversation format is valid
    }

    // For paper analysis questions
    if (!parsed.final_answer?.content || !parsed.thinking_process) {
        return "Invalid format. Required: main_idea, thinking_process";
    }

    const content = parsed.final_answer.content;

    // Check for sufficient detail in main idea
    if (!content.main_idea || content.main_idea.length < 50) {
        return "Main idea must be at least 50 characters for detailed responses";
    }

    // Check for sufficient evidence points
    if (
        !Array.isArray(content.supporting_evidence) ||
        content.supporting_evidence.length < 2
    ) {
        return "At least 2 detailed evidence points are required";
    }

    // Check for analysis depth
    if (!content.critical_analysis || content.critical_analysis.length < 200) {
        return "Critical analysis must be at least 200 characters for detailed responses";
    }

    return null; // Valid response structure
};

const formatFinalAnswer = (parsed) => {
    if (!parsed.final_answer?.content) return "Could not generate response";

    // For general conversations
    if (
        parsed.final_answer?.content?.main_idea &&
        !parsed.function_call &&
        !parsed.thinking_process
    ) {
        return parsed.final_answer.content.main_idea;
    }

    // Extract content components with validation to ensure nothing is lost
    const content = parsed.final_answer.content || {};
    const mainIdea = content.main_idea || "No main idea provided";
    const evidence = Array.isArray(content.supporting_evidence)
        ? content.supporting_evidence
        : [content.supporting_evidence].filter(Boolean);
    const analysis = content.critical_analysis || "";

    // Full detailed formatting
    let detailedResponse = `${mainIdea}\n\n`;

    if (evidence.length > 0) {
        detailedResponse += `## Key Evidence from Paper\n\n`;
        evidence.forEach((point, i) => {
            detailedResponse += `### Point ${i + 1}\n${point}\n\n`;
        });
    }

    if (analysis) {
        detailedResponse += `## Expert Analysis\n\n${analysis}`;
    }

    return detailedResponse;
};

// Controller functions
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

        // Clear caches for new paper
        PAPER_CONTEXT_CACHE.delete(paper._id);
        SEARCH_RESULT_CACHE.clear();

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

export const processChatMessage = asyncHandler(async (req, res) => {
    const { paperId } = req.params;
    const { question } = req.body;
    const userId = req.user.id;

    if (!question?.trim()) throw new ApiError(400, "Question is required");

    const paper = await Paper.findOne({ _id: paperId, user: userId });
    if (!paper) throw new ApiError(403, "Unauthorized access");

    try {
        // Save user message
        const userMessage = await ChatMessage.create({
            paper: paperId,
            user: userId,
            content: question,
            role: "user",
        });

        // Context management with improved caching
        const context = {
            data: {},
            usedFunctions: new Set(),
            apiCallsMade: 0,
            MAX_API_CALLS: 3,
            MAX_TURNS: 4,
            cacheHits: 0,
        };

        // Check global cache first
        const cacheKey = `${userId}:${paperId}`;
        const cachedData = memoryCache.get(cacheKey) || {};

        // Initial context setup with cache awareness
        try {
            // Check if paper details already in cache
            if (PAPER_CONTEXT_CACHE.has(paperId)) {
                context.data.getPaperDetails = PAPER_CONTEXT_CACHE.get(paperId);
                context.usedFunctions.add("getPaperDetails");
                context.cacheHits++;
                console.log("Cache hit: getPaperDetails");
            } else {
                context.data.getPaperDetails = await callFunctionByName(
                    "getPaperDetails",
                    paperId,
                    userId
                );
                context.usedFunctions.add("getPaperDetails");
                // Cache is handled inside callFunctionByName
            }

            // Optimize search by checking cache first
            const queryKey = `${paperId}-${question}`;
            if (SEARCH_RESULT_CACHE.has(queryKey)) {
                context.data.searchKnowledgeBase =
                    SEARCH_RESULT_CACHE.get(queryKey);
                context.usedFunctions.add("searchKnowledgeBase");
                context.cacheHits++;
                console.log("Cache hit: searchKnowledgeBase for", question);
            } else {
                const initialResults = await callFunctionByName(
                    "searchKnowledgeBase",
                    paperId,
                    userId,
                    { query: question }
                );

                if (!initialResults?.length) {
                    // Split search only if main search failed
                    const terms = question
                        .trim()
                        .split(/\s+/)
                        .filter((t) => t.length > 3);
                    for (const term of terms) {
                        const termQueryKey = `${paperId}-${term}`;

                        // Check cache for individual terms
                        if (SEARCH_RESULT_CACHE.has(termQueryKey)) {
                            context.data.searchKnowledgeBase =
                                SEARCH_RESULT_CACHE.get(termQueryKey);
                            context.usedFunctions.add("searchKnowledgeBase");
                            context.cacheHits++;
                            console.log(
                                "Cache hit: searchKnowledgeBase for term",
                                term
                            );
                            break;
                        }

                        const termResults = await callFunctionByName(
                            "searchKnowledgeBase",
                            paperId,
                            userId,
                            { query: term }
                        );
                        if (termResults?.length) {
                            context.data.searchKnowledgeBase = termResults;
                            context.usedFunctions.add("searchKnowledgeBase");
                            break;
                        }
                    }
                } else {
                    context.data.searchKnowledgeBase = initialResults;
                    context.usedFunctions.add("searchKnowledgeBase");
                }
            }
        } catch (contextError) {
            console.error("Context initialization error:", contextError);
        }

        // Conversation loop
        const messageHistory = [
            {
                role: "user",
                content: buildInitialPrompt(paper, context.data, question),
            },
        ];

        let finalAnswer = null;
        let turns = 0;

        while (turns < context.MAX_TURNS && !finalAnswer) {
            turns++;

            try {
                const rawResponse = await generateChatResponse(messageHistory);
                const parsed = parseGeminiResponse(rawResponse);
                console.log(`Gemini response (turn ${turns}):`, parsed);

                // Handle general conversations FIRST
                if (
                    parsed.final_answer?.content?.main_idea &&
                    !parsed.function_call
                ) {
                    finalAnswer = formatFinalAnswer(parsed);
                    break; // Exit loop for general responses
                }

                // Validate paper analysis responses
                const validationError = validateResponseStructure(parsed);
                if (validationError) {
                    messageHistory.push({
                        role: "user",
                        content: validationError,
                    });
                    continue;
                }

                // Handle function calls
                if (parsed.function_call?.name) {
                    if (context.apiCallsMade >= context.MAX_API_CALLS) {
                        messageHistory.push({
                            role: "user",
                            content:
                                "Maximum research depth reached. Providing final answer now.",
                        });
                        finalAnswer = formatFinalAnswer(parsed);
                        break;
                    }

                    const { name, parameters } = parsed.function_call;
                    const toolResult = await handleFunctionCall(
                        name,
                        paperId,
                        userId,
                        parameters
                    );
                    console.log(`Tool result for ${name}:`, toolResult);

                    context.usedFunctions.add(name);
                    context.data[name] = toolResult;
                    context.apiCallsMade++;

                    messageHistory.push({
                        role: "function",
                        name: name,
                        content: toolResult,
                    });

                    // Add context-aware guidance
                    messageHistory.push({
                        role: "user",
                        content:
                            name === "searchKnowledgeBase" &&
                            !toolResult?.length
                                ? `No results for "${parameters?.query || question}". Try different terms.`
                                : "Analyze these results and provide a answer in very detail.",
                    });
                    // console.log("Message history:", messageHistory);
                } else {
                    finalAnswer = formatFinalAnswer(parsed);
                }
            } catch (error) {
                console.error(`Turn ${turns} error:`, error);
                messageHistory.push({
                    role: "user",
                    content:
                        "Please respond using only the allowed functions: " +
                        "getPaperDetails, searchKnowledgeBase, getChatHistory",
                });
            }
        }

        // Final fallback
        if (!finalAnswer) {
            finalAnswer =
                "Unable to generate a complete answer. Please try rephrasing your question.";
        }

        // Save and return response
        const assistantMessage = await ChatMessage.create({
            paper: paperId,
            user: userId,
            content: finalAnswer,
            role: "assistant",
            metadata: {
                functionsUsed: [...context.usedFunctions],
                contextData: context.data,
            },
        });

        console.log("Chat processing metrics:", {
            cacheHits: context.cacheHits,
            apiCallsMade: context.apiCallsMade,
            turns: turns,
            functionsCalled: [...context.usedFunctions],
        });

        res.json({
            question: formatMessage(userMessage),
            answer: formatMessage(assistantMessage),
            context: context.data,
        });
    } catch (error) {
        console.error("Chat processing error:", {
            error: error.message,
            paperId,
            userId,
            question,
        });
        throw new ApiError(500, "Chat processing failed", error);
    }
});
