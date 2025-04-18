import { GoogleGenerativeAI } from "@google/generative-ai";
import { setTimeout } from "timers/promises";
import Paper from "../models/paper.model.js";
import KnowledgeBase from "../models/knowledgeBase.model.js";
import ChatMessage from "../models/chatMessage.model.js";
import { ApiError } from "../utils/ApiError.js";
import mongoose from "mongoose";

// =======================
// CONFIGURATION
// =======================

const RATE_LIMIT = {
    free: {
        requests: 15,
        perMinutes: 1,
        delayBetweenChunks: 5000,
    },
    pro: {
        requests: 60,
        perMinutes: 1,
        delayBetweenChunks: 1000,
    },
    enterprise: {
        requests: 300,
        perMinutes: 1,
        delayBetweenChunks: 500,
    },
};

const CACHE_DURATION = 10 * 60 * 1000; // 10 mins
const memoryCache = new Map(); // Key: `${userId}:${paperId}`, Value: { getPaperDetails, searchKnowledgeBase, getChatHistory }

let requestCount = 0;
let lastRequestTime = Date.now();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash",
    generationConfig: {
        temperature: 0.7,
        topP: 0.95,
        topK: 40,
        maxOutputTokens: 8192,
        responseMimeType: "text/plain",
    },
    safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
    ],
});

// =======================
// RATE LIMITER
// =======================

async function rateLimitedCall(fn, tier = "free") {
    const limit = RATE_LIMIT[tier] || RATE_LIMIT.free;

    if (Date.now() - lastRequestTime > limit.perMinutes * 60 * 1000) {
        requestCount = 0;
        lastRequestTime = Date.now();
    }

    while (requestCount >= limit.requests) {
        const waitTime =
            limit.perMinutes * 60 * 1000 - (Date.now() - lastRequestTime);
        await setTimeout(waitTime + 1000);
        requestCount = 0;
        lastRequestTime = Date.now();
    }

    requestCount++;
    return fn();
}

// =======================
// CHUNK ANALYSIS PIPELINE
// =======================

export const analyzePaperChunks = async (
    chunks,
    previousSummary = null,
    tier = "free"
) => {
    const batchSize = 3;
    const results = [];

    for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);

        const result = await rateLimitedCall(
            () => processBatch(batch, previousSummary, tier),
            tier
        );

        results.push(result);
        console.log(`Response for chunk ${i + 1} - ${i + batchSize}:`, result);
    }

    return {
        summaries: results.flatMap((r) => r.summaries),
        aggregatedSummary: results.map((r) => r.merged).join("\n"),
        keywordsArray: results.flatMap((r) => r.keywords),
    };
};

// =======================
// PROCESS SINGLE BATCH
// =======================

async function processBatch(chunks, previousSummary, tier) {
    const formattedChunks = chunks
        .map((chunk, index) => `Chunk ${index + 1}: ${chunk}`)
        .join("\n\n");

    const prompt = `
You are a JSON-only AI. Never write text or code fences, only return raw JSON.

Analyze the following paper chunks in sequence${previousSummary ? `, building on this previous summary: "${previousSummary}"` : ""}.

Chunks:
${formattedChunks}

Return a response matching this JSON format exactly:

{
  "chunks": [
    {
      "summary": "concise summary",
      "keywords": ["kw1", "kw2"],
      "connections": ["relates_to_X", "contrasts_with_Y"]
    }
  ],
  "merged_summary": "combined narrative"
}
`.trim();

    try {
        const response = await model.generateContent(prompt);
        const textResponse = response.response.text();

        const cleanedResponse = textResponse
            .replace(/^```json|```$/g, "")
            .trim();

        const result = JSON.parse(cleanedResponse);
        return {
            summaries: result.chunks,
            merged: result.merged_summary,
            keywords: result.chunks.flatMap((c) => c.keywords),
        };
    } catch (err) {
        console.error("Batch processing error:", err);
        return {
            summaries: chunks.map(() => ({
                summary: "Analysis failed",
                keywords: [],
                connections: [],
            })),
            merged: previousSummary || "",
            keywords: [],
        };
    }
}

// =======================
// KEYWORD EXTRACTION (Fallback Helper)
// =======================

function extractKeywords(resultText) {
    const matches = resultText.match(/\b([a-zA-Z]{4,})\b/g);
    return [...new Set(matches || [])].slice(0, 15);
}

// =======================
// SUMMARY REFINEMENT
// =======================

export const refineSummary = async (summary) => {
    const prompt = `You are a JSON-only AI. Return your answer only as JSON with no text or code block.

Condense this summary into no more than 3 paragraphs while keeping key insights.

Input summary:
"""${summary}"""

Output:
{
  "summary": "condensed summary"
}`;

    try {
        const response = await model.generateContent(prompt);
        const textResponse = response.response.text();
        const cleaned = textResponse
            .replace(/```json/g, "")
            .replace(/```/g, "")
            .trim();
        return JSON.parse(cleaned).summary;
    } catch (err) {
        console.error("Summary refinement error:", err);
        return summary; // Return original if refinement fails
    }
};

// =======================
// TEXT & CHAT UTILITIES
// =======================

// ------------------ System Prompt ------------------
export const SYSTEM_PROMPT = `
You are an AI research assistant specialized in helping users understand academic papers.

Context:
- The user is asking questions about a specific paper (paperId is already known).
- You can call tools to retrieve information about the paper and related content.
- The Database is a collection of chunks of text from the paper in MongoDB.

Functions available:
1. getPaperDetails(): Returns title, abstract, and keywords of the paper.
2. searchKnowledgeBase(query, maxResults=3): Returns chunks of text relevant to a given question.
3. getChatHistory(limit=5): Retrieves the most recent user-assistant interactions.

Instructions:
- Always begin by calling getPaperDetails and getChatHistory (limit=5).
- When a user asks a question, always perform a searchKnowledgeBase(query).
- If searchKnowledgeBase returns no results, fall back to using the abstract, summary, or keywords from getPaperDetails.
- Use the retrieved context to generate the final answer.
- Do not ask for paper ID. It is already known.

Response protocol:
- Use the following JSON format:
\`\`\`json
{
  "function_call": {
    "name": "function_name",
    "parameters": { ... }
  },
  "thinking_process": "reasoning steps",
  "final_answer": "direct answer when all needed context is available"
}
\`\`\`

Important:
- If you need to call a function (like searchKnowledgeBase), return a function_call and leave final_answer empty or incomplete.
- Only provide a complete final_answer once you have all the necessary context.
- The final assistant message shown to the user will only be the final_answer after all tool calls are complete.
`;

// ------------------ Response Parser ------------------
export function parseGeminiResponse(response) {
    try {
        // Case 1: Already a JS object
        if (typeof response === "object" && response !== null) {
            return response;
        }

        // Make sure response is a string
        if (typeof response !== "string") {
            console.warn("Unexpected response type:", typeof response);
            return {
                function_call: null,
                thinking_process: null,
                final_answer: String(response),
            };
        }

        // Case 2: String with ```json block
        const jsonBlockMatch = response.match(/```json\s*([\s\S]*?)```/);
        if (jsonBlockMatch) {
            try {
                return JSON.parse(jsonBlockMatch[1]);
            } catch (jsonErr) {
                console.warn("Failed to parse JSON block:", jsonErr);
                // Fall through to Case 4
            }
        }

        // Case 3: Plain JSON string
        if (response.trim().startsWith("{") && response.trim().endsWith("}")) {
            try {
                return JSON.parse(response);
            } catch (jsonErr) {
                console.warn("Failed to parse JSON string:", jsonErr);
                // Fall through to Case 4
            }
        }

        // Case 4: Not JSON at all, just text response
        return {
            function_call: null,
            thinking_process: null,
            final_answer: response.trim(),
        };
    } catch (err) {
        console.error("Failed to parse Gemini response:", err);
        return {
            function_call: null,
            thinking_process: null,
            final_answer: "Error processing response",
        };
    }
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ------------------ Function Call Registry ------------------
const FUNCTION_HANDLERS = {
    getPaperDetails: async (paperId, userId) => {
        const paper = await Paper.findOne({ _id: paperId, user: userId })
            .populate("knowledgeBase") // If linked
            .select(
                "title authors abstract keywords summary citations annotations"
            )
            .lean();

        return {
            title: paper.title,
            abstract: paper.abstract,
            keywords: paper.keywords,
            summary: paper.summary || "",
        };
    },

    // 1. Improve the searchKnowledgeBase function
    searchKnowledgeBase: async (paperId, userId, { query, maxResults = 3 }) => {
        // Create multiple query terms by splitting the query and using each word separately
        const queryTerms = query.split(/\s+/).filter((term) => term.length > 3); // Only use words longer than 3 chars

        let regexPattern;
        if (queryTerms.length > 0) {
            const escapedTerms = queryTerms.map((term) => escapeRegExp(term));
            // Create regex with lookaheads to require all terms
            const lookaheads = escapedTerms
                .map((term) => `(?=.*${term})`)
                .join("");
            regexPattern = new RegExp(`^${lookaheads}.*$`, "i");
        } else {
            regexPattern = new RegExp(query, "i");
        }

        const results = await KnowledgeBase.aggregate([
            {
                $match: {
                    paper: new mongoose.Types.ObjectId(paperId),
                    $text: { $search: query },
                },
            },
            { $unwind: "$chunks" },
            {
                $sort: {
                    score: { $meta: "textScore" }, // Sort by relevance
                },
            },
            { $limit: 3 },
            {
                $project: {
                    text: "$chunks.text",
                    _id: 0,
                    score: { $meta: "textScore" },
                },
            },
        ]);

        if (results.length === 0 && queryTerms.length > 1) {
            // If no results and multiple terms, try with individual term searches
            const individualSearchPromises = queryTerms.map((term) =>
                KnowledgeBase.aggregate([
                    { $match: { paper: new mongoose.Types.ObjectId(paperId) } },
                    { $unwind: "$chunks" },
                    {
                        $match: {
                            "chunks.text": { $regex: new RegExp(term, "i") },
                        },
                    },
                    { $project: { text: "$chunks.text", _id: 0 } },
                    { $limit: 1 },
                ])
            );

            const individualResults = await Promise.all(
                individualSearchPromises
            );
            const flatResults = individualResults.flat();

            if (flatResults.length > 0) {
                return flatResults.slice(0, maxResults).map((r) => r.text);
            }
        }

        return results.map((r) => r.text);
    },

    getChatHistory: async (paperId, userId, limit = 5) => {
        return ChatMessage.find({
            paper: paperId,
            user: userId,
            role: { $in: ["user", "assistant"] },
        })
            .sort({ createdAt: -1 })
            .limit(limit)
            .select("content role createdAt")
            .lean();
    },
};

// In callFunctionByName function
export const callFunctionByName = async (
    name,
    paperId,
    userId,
    params = {}
) => {
    const cacheKey = `${userId}:${paperId}`;
    if (!memoryCache.has(cacheKey)) {
        memoryCache.set(cacheKey, {});
    }

    const paperCache = memoryCache.get(cacheKey);

    // Cache `getPaperDetails`
    if (name === "getPaperDetails") {
        if (paperCache.getPaperDetails) return paperCache.getPaperDetails;

        const result = await FUNCTION_HANDLERS.getPaperDetails(paperId, userId);
        paperCache.getPaperDetails = result;
        return result;
    }

    // Cache `getChatHistory`
    if (name === "getChatHistory") {
        if (paperCache.getChatHistory) return paperCache.getChatHistory;

        const result = await FUNCTION_HANDLERS.getChatHistory(
            paperId,
            userId,
            params.limit || 5
        );
        paperCache.getChatHistory = result;
        return result;
    }

    // Cache `searchKnowledgeBase` per query
    if (name === "searchKnowledgeBase") {
        const query = params.query || "";
        paperCache.searchKnowledgeBase = paperCache.searchKnowledgeBase || {};
        if (paperCache.searchKnowledgeBase[query]) {
            return paperCache.searchKnowledgeBase[query];
        }

        const result = await FUNCTION_HANDLERS.searchKnowledgeBase(
            paperId,
            userId,
            params // Pass the entire params object, not spreading it
        );
        paperCache.searchKnowledgeBase[query] = result;
        return result;
    }

    // fallback - don't spread params here either
    return FUNCTION_HANDLERS[name](paperId, userId, params);
};

export const generateResponse = async (prompt) => {
    try {
        const result = await model.generateContent(prompt);
        return result.response.text();
    } catch (err) {
        console.error("Generation error:", err);
        throw new Error("Failed to generate response");
    }
};

export const generateChatResponse = async (
    messages,
    systemPrompt = SYSTEM_PROMPT
) => {
    try {
        // Extract the last message (usually the user's question)
        const lastMessage = messages[messages.length - 1];

        // Filter history messages (excluding system messages and the last message)
        const historyMessages = messages
            .slice(0, -1)
            .filter((msg) => msg.role !== "system");

        // Create chat with history
        const chat = model.startChat({
            history: historyMessages.map((msg) => formatMessageForGemini(msg)),
        });

        // For the first message in a conversation, include system instructions with user's question
        let messageContent = lastMessage.content;
        if (historyMessages.length === 0 && systemPrompt) {
            messageContent = `${systemPrompt}\n\nUser question: ${messageContent}`;
        }

        // Send message with modified content
        const result = await chat.sendMessage(messageContent);
        return result.response.text();
    } catch (err) {
        console.error("Chat error:", err);
        throw new Error("Chat processing failed");
    }
};

export const formatMessageForGemini = (msg) => {
    // For function responses, format in the way Gemini expects
    if (msg.role === "function") {
        return {
            role: "model", // Change from "function" to "model"
            parts: [
                {
                    text: JSON.stringify({
                        function_response: {
                            name: msg.name,
                            response: msg.content,
                        },
                    }),
                },
            ],
        };
    }

    // Regular message formatting
    return {
        role: msg.role === "assistant" ? "model" : msg.role,
        parts: [{ text: msg.content }],
    };
};

// Cache Expiry
const setWithExpiry = (key, value) => {
    memoryCache.set(key, { value, timestamp: Date.now() });
};

const getWithExpiry = (key) => {
    const data = memoryCache.get(key);
    if (!data) return null;
    if (Date.now() - data.timestamp > CACHE_DURATION) {
        memoryCache.delete(key);
        return null;
    }
    return data.value;
};

// =======================
// EXPORT MODULE
// =======================

export default {
    analyzePaperChunks,
    refineSummary,
    generateResponse,
    generateChatResponse,
};
