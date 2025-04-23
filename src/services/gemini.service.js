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

export const CACHE_DURATION = 10 * 60 * 1000; // 10 mins
export const memoryCache = new Map(); // Key: `${userId}:${paperId}`, Value: { getPaperDetails, searchKnowledgeBase, getChatHistory }
export const PAPER_CONTEXT_CACHE = new Map(); // Key: paperId
export const SEARCH_RESULT_CACHE = new Map(); // Key: paperId+query

let requestCount = 0;
let lastRequestTime = Date.now();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// Using gemini-pro for more sophisticated text analysis (upgraded from gemini-flash)
const model = genAI.getGenerativeModel({
    model: "gemini-2.0-pro", // Upgraded model for better analysis
    generationConfig: {
        temperature: 0.6, // Reduced for more consistent results
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

// Fast model for simpler tasks
const fastModel = genAI.getGenerativeModel({
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
    const batchSize = 2; // Reduced batch size for better analysis
    const results = [];
    let allChunkData = [];

    for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);

        const result = await rateLimitedCall(
            () => processBatch(batch, previousSummary, tier),
            tier
        );

        results.push(result);
        allChunkData = [...allChunkData, ...result.chunkDetails];
        console.log(`Response for chunk ${i + 1} - ${i + batchSize}:`, result);

        // Apply rate limiting delay between batches
        if (i + batchSize < chunks.length) {
            const delay = RATE_LIMIT[tier].delayBetweenChunks || 1000;
            await setTimeout(delay);
        }
    }

    // After processing all chunks individually, create an integrated summary
    const integratedSummary = await generateIntegratedSummary(
        allChunkData,
        results.map((r) => r.merged).join("\n\n"),
        tier
    );

    return {
        summaries: results.flatMap((r) => r.summaries),
        aggregatedSummary: integratedSummary.overview,
        keywordsArray:
            integratedSummary.keywords ||
            [...new Set(results.flatMap((r) => r.keywords))].slice(0, 20),
        hierarchicalSummary: integratedSummary,
    };
};

// =======================
// PROCESS SINGLE BATCH
// =======================

async function processBatch(chunks, previousSummary, tier) {
    // Limit chunk size before sending to API
    const safeSizedChunks = chunks.map((chunk) =>
        chunk.length > 5000 ? chunk.substring(0, 5000) + "..." : chunk
    );

    const formattedChunks = safeSizedChunks
        .map((chunk, index) => `Chunk ${index + 1}: ${chunk}`)
        .join("\n\n");

    const prompt = `
You are a JSON-only AI. Never write text or code fences, only return raw JSON.

Analyze the following academic paper chunks in sequence${previousSummary ? `, building on this previous summary: "${previousSummary}"` : ""}.

Chunks:
${formattedChunks}

For each chunk, identify:
1. Main topics and subtopics with specific terminology
2. Key points, findings, and data with precise details
3. Methodology information with technical specifics
4. Results and conclusions with actual values/outcomes when present
5. Relationships and connections to earlier content

Return a response matching this JSON format exactly:

{
  "chunks": [
    {
      "summary": "detailed summary of the chunk's content",
      "keywords": ["keyword1", "keyword2", "keyword3"],
      "topics": [
        {
          "name": "main topic name",
          "subtopics": ["subtopic1", "subtopic2"],
          "key_points": ["specific point with details", "another specific point"]
        }
      ],
      "connections": ["connects to previous topic X", "builds on methodology Y"]
    }
  ],
  "merged_summary": "combined narrative that integrates all chunks analyzed in this batch",
  "topic_structure": {
    "main_topics": [
      {
        "name": "topic1",
        "summary": "comprehensive topic summary",
        "subtopics": ["subtopic1", "subtopic2"]
      }
    ]
  }
}`.trim();

    try {
        const response = await fastModel.generateContent(prompt);
        const textResponse = response.response.text();

        const cleanedResponse = textResponse
            .replace(/^```json|```$/g, "")
            .trim();

        const result = JSON.parse(cleanedResponse);

        // Extract detailed information about each chunk for hierarchical summary
        const chunkDetails = result.chunks.map((chunk, i) => ({
            text: chunks[i],
            summary: chunk.summary,
            keywords: chunk.keywords || [],
            topics: chunk.topics || [],
            connections: chunk.connections || [],
        }));

        return {
            summaries: result.chunks,
            merged: result.merged_summary,
            keywords: result.chunks.flatMap((c) => c.keywords),
            chunkDetails: chunkDetails, // Store detailed information for later use
            topicStructure: result.topic_structure,
        };
    } catch (err) {
        console.error("Batch processing error:", err);
        // Fallback to simpler analysis using fast model if main model fails
        try {
            const fallbackResult = await fastModel.generateContent(
                `Summarize these chunks of academic text and extract 5-10 keywords:\n${formattedChunks}`
            );
            const fallbackText = fallbackResult.response.text();
            return {
                summaries: chunks.map(() => ({
                    summary: fallbackText,
                    keywords: extractKeywords(fallbackText),
                    connections: [],
                })),
                merged: fallbackText,
                keywords: extractKeywords(fallbackText),
                chunkDetails: chunks.map((chunk) => ({
                    text: chunk,
                    summary: fallbackText,
                    keywords: extractKeywords(fallbackText),
                })),
            };
        } catch (fallbackErr) {
            console.error("Fallback processing also failed:", fallbackErr);
            return {
                summaries: chunks.map(() => ({
                    summary: previousSummary || "Analysis failed",
                    keywords: [],
                    connections: [],
                })),
                merged: previousSummary || "Analysis failed",
                keywords: [],
                chunkDetails: chunks.map((chunk) => ({
                    text: chunk,
                    summary: "Analysis failed",
                    keywords: [],
                })),
            };
        }
    }
}

// Function to generate a comprehensive hierarchical summary
async function generateIntegratedSummary(
    allChunkData,
    combinedSummaries,
    tier
) {
    // Extract all topics from chunk data
    const allTopics = allChunkData
        .flatMap((chunk) => chunk.topics || [])
        .filter(Boolean);

    // Extract all keywords for better context
    const allKeywords = [
        ...new Set(
            allChunkData
                .flatMap((chunk) => chunk.keywords || [])
                .filter(Boolean)
        ),
    ];

    // Create a unified topic list with deduplicated topics
    const topicNames = [...new Set(allTopics.map((t) => t.name))];

    const hierarchicalPrompt = `
You are a JSON-only AI. Return only raw JSON without any code fences or explanatory text.

Analyze the following summaries from an academic paper to create a comprehensive hierarchical summary:

${combinedSummaries}

Important topics identified: ${topicNames.join(", ")}
Important keywords: ${allKeywords.slice(0, 20).join(", ")}

Return a structured hierarchical summary with the following JSON format:

{
  "overview": "Comprehensive 2-3 paragraph summary of the entire paper that identifies the main research question, methodology, and key findings",
  "keywords": ["keyword1", "keyword2", "..."],
  "sections": [
    {
      "title": "Major Section/Topic 1",
      "summary": "Detailed explanation of this section/topic including specific findings, methodologies, or arguments"
    },
    {
      "title": "Major Section/Topic 2",
      "summary": "Detailed explanation of this section/topic"
    }
  ]
}

Requirements:
1. The overview should provide a complete picture of the paper's purpose and findings
2. Identify 3-7 major sections/topics that represent the paper's structure
3. Each section summary should be detailed (100+ words) and include specific information
4. Choose the most distinctive keywords that best represent the paper content
5. Ensure the hierarchical structure reflects the paper's actual organization
`;

    try {
        const response = await rateLimitedCall(
            () => fastModel.generateContent(hierarchicalPrompt),
            tier
        );

        const textResponse = response.response.text();

        // Improved cleaning to handle control characters and other JSON issues
        const cleanedResponse = textResponse
            .replace(/```json|```/g, "")
            .replace(/[\u0000-\u001F\u007F-\u009F]/g, "") // Remove all control characters
            .trim();

        try {
            // Try to parse the cleaned JSON
            const result = JSON.parse(cleanedResponse);

            // Ensure the result has the expected structure
            if (!result.overview)
                result.overview = combinedSummaries.slice(0, 500);
            if (!result.sections || !Array.isArray(result.sections)) {
                result.sections = topicNames.slice(0, 5).map((name) => ({
                    title: name,
                    summary: `This section covers topics related to ${name}.`,
                }));
            }

            return result;
        } catch (parseErr) {
            console.error("Failed to parse hierarchical summary:", parseErr);
            console.log(
                "Problematic JSON string:",
                cleanedResponse.substring(0, 200) + "..."
            );

            // More robust fallback - try to extract parts manually
            let overview = "";
            try {
                const overviewMatch = cleanedResponse.match(
                    /"overview"\s*:\s*"([^"]+)"/
                );
                if (overviewMatch && overviewMatch[1]) {
                    overview = overviewMatch[1];
                }
            } catch (e) {}

            // Create fallback structure
            return {
                overview: overview || combinedSummaries.slice(0, 500),
                keywords: allKeywords.slice(0, 20),
                sections: topicNames.slice(0, 5).map((name) => ({
                    title: name,
                    summary: `This section covers topics related to ${name}.`,
                })),
            };
        }
    } catch (err) {
        console.error("Failed to generate hierarchical summary:", err);
        return {
            overview: combinedSummaries.slice(0, 500),
            keywords: allKeywords.slice(0, 20),
            sections: topicNames.slice(0, 5).map((name) => ({
                title: name,
                summary: `This section covers topics related to ${name}.`,
            })),
        };
    }
}

export const generateHierarchicalSummary = async (combinedSummaries) => {
    const hierarchicalPrompt = `
    Analyze these summaries from different sections of a research paper:
    
    ${combinedSummaries.substring(0, 10000)} // Limit the input size
    
    Create a structured hierarchical summary with:
    1. Overview: A comprehensive 2-3 paragraph summary of the entire paper
    2. Sections: Identify 3-7 key topics/sections and create a summary for each
    
    Return JSON in this format:
    {
      "overview": "overall paper summary (2-3 paragraphs)",
      "sections": [
        {"title": "Topic/Section 1", "summary": "detailed summary"},
        {"title": "Topic/Section 2", "summary": "detailed summary"}
      ]
    }
    `;

    try {
        const response = await fastModel.generateContent(hierarchicalPrompt);
        const textResponse = response.response.text();

        // Clean the response - remove control characters that break JSON parsing
        const cleanedResponse = textResponse
            .replace(/```json|```/g, "")
            .replace(/[\u0000-\u001F\u007F-\u009F]/g, "") // Remove all control characters
            .trim();

        try {
            return JSON.parse(cleanedResponse);
        } catch (parseError) {
            console.error("JSON parse error:", parseError);

            // Try a more robust approach - extract sections manually
            let overview = "";
            const sections = [];

            // Try to extract overview using regex
            const overviewMatch = cleanedResponse.match(
                /"overview"\s*:\s*"([^"]+)"/
            );
            if (overviewMatch && overviewMatch[1]) {
                overview = overviewMatch[1];
            }

            // Try to extract sections using regex
            const sectionsMatch = cleanedResponse.match(
                /"sections"\s*:\s*\[(.*)\]/s
            );
            if (sectionsMatch && sectionsMatch[1]) {
                const sectionItems = sectionsMatch[1].split(/},\s*{/);

                for (const item of sectionItems) {
                    const titleMatch = item.match(/"title"\s*:\s*"([^"]+)"/);
                    const summaryMatch = item.match(
                        /"summary"\s*:\s*"([^"]+)"/
                    );

                    if (
                        titleMatch &&
                        titleMatch[1] &&
                        summaryMatch &&
                        summaryMatch[1]
                    ) {
                        sections.push({
                            title: titleMatch[1],
                            summary: summaryMatch[1],
                        });
                    }
                }
            }

            return {
                overview:
                    overview ||
                    "Summary extraction failed. Please see the individual section summaries.",
                sections:
                    sections.length > 0
                        ? sections
                        : [
                              {
                                  title: "Main Content",
                                  summary:
                                      "Please refer to the individual chunk summaries for details.",
                              },
                          ],
            };
        }
    } catch (err) {
        console.error("Hierarchical summary generation error:", err);
        return {
            overview:
                "Failed to generate a comprehensive summary due to a processing error.",
            sections: [
                {
                    title: "Content",
                    summary:
                        "The system was unable to generate section summaries.",
                },
            ],
        };
    }
};

// =======================
// KEYWORD EXTRACTION (Fallback Helper)
// =======================

function extractKeywords(resultText) {
    // Enhanced keyword extraction
    // First try to find keyword-like patterns
    const keywordPatterns = [
        /\b([A-Z][a-z]{2,}(?:\s[A-Z][a-z]{2,})*)\b/g, // Title case phrases
        /\b([a-z]{4,}(?:-[a-z]{2,})+)\b/g, // Hyphenated terms
        /\b([a-z]{4,})\b/g, // Basic words
    ];

    let keywords = [];

    // Extract potential keywords using patterns
    keywordPatterns.forEach((pattern) => {
        const matches = resultText.match(pattern) || [];
        keywords = [...keywords, ...matches];
    });

    // Filter out common stopwords
    const stopwords = [
        "and",
        "the",
        "this",
        "that",
        "with",
        "from",
        "have",
        "has",
        "been",
        "were",
        "they",
        "their",
        "there",
    ];
    keywords = keywords.filter((kw) => !stopwords.includes(kw.toLowerCase()));

    // Deduplicate and limit
    return [...new Set(keywords)].slice(0, 15);
}

// =======================
// SUMMARY REFINEMENT
// =======================

export const refineSummary = async (summary) => {
    const prompt = `You are a JSON-only AI. Return your answer only as JSON with no text or code block.

Condense and enhance this summary into 2-3 paragraphs (250-400 words) while preserving key insights, methodology details, and specific findings. Make it more coherent and readable.

Input summary:
"""${summary}"""

Output:
{
  "summary": "condensed, improved summary that retains specific details and technical accuracy"
}`;

    try {
        const response = await fastModel.generateContent(prompt);
        const textResponse = response.response.text();
        const cleaned = textResponse
            .replace(/```json/g, "")
            .replace(/```/g, "")
            .trim();
        return JSON.parse(cleaned).summary;
    } catch (err) {
        console.error("Summary refinement error:", err);
        try {
            // Fallback to simple trimming and cleaning
            if (summary.length > 800) {
                return summary.slice(0, 800) + "...";
            }
            return summary;
        } catch (fallbackErr) {
            return summary; // Return original if all processing fails
        }
    }
};

// =======================
// TEXT & CHAT UTILITIES
// =======================

export const SYSTEM_PROMPT = `
You are an advanced AI research assistant specialized in analyzing academic papers in extreme detail.

# CRITICAL REQUIREMENT: Always provide COMPREHENSIVE RESPONSES
- Your answers must be HIGHLY DETAILED (minimum 500 words for technical questions)
- Include SPECIFIC examples from the paper
- Add your own expert analysis that goes BEYOND the paper's content
- Include comparisons to related research when relevant

# Response Modes
1. General Conversations (use only for greetings/administrative queries):
\`\`\`json
{
  "final_answer": {
    "content": {
      "main_idea": "Your natural language response here"
    }
  }
}
\`\`\`

2. Paper Analysis Mode (use for ALL technical/research questions):
\`\`\`json
{
  "function_call": {
    "name": "searchKnowledgeBase",
    "parameters": {
      "query": "optimized search terms",
      "context_hints": ["specific section references if known"]
    }
  },
  "thinking_process": [
    {"depth_assessment": "technical complexity level"},
    {"user_needs": "specific analysis goals"},
    {"sections_of_interest": "relevant paper sections"}
  ],
  "final_answer": {
    "content": {
      "main_idea": "Comprehensive thesis statement (1-2 paragraphs)",
      "supporting_evidence": [
        "DETAILED evidence point 1 with specific quotes and page numbers",
        "DETAILED evidence point 2 with specific methodology insights",
        "DETAILED evidence point 3 with results analysis",
        "DETAILED evidence point 4 with limitations discussion"
      ],
      "critical_analysis": "Deep expert analysis (3+ paragraphs) that EXTENDS beyond the paper content with your own insights, connections to broader field, and future implications"
    }
  }
}
\`\`\`

# Allowed Functions
1. getPaperDetails - Get paper metadata
2. searchKnowledgeBase - Search paper content
3. getChatHistory - Get conversation history

# CACHING PROTOCOL (Critical)
- NEVER make redundant function calls
- If you've already retrieved paper details, DO NOT call getPaperDetails again
- If you've searched for a specific term, DO NOT search for it again
- Check content of previous function responses before making new calls

Remember: Your primary value is providing EXTREMELY THOROUGH analysis that combines paper content with your own expertise.
`;

export function parseGeminiResponse(response) {
    try {
        if (typeof response === "object") return response;

        // Convert to string if it's not already
        const responseStr =
            typeof response === "string" ? response : JSON.stringify(response);

        // Clean up code block formatting, control characters, and trim
        let jsonString = responseStr
            .replace(/```json\s*/gi, "") // Remove opening ```json
            .replace(/```/g, "") // Remove closing ```
            .replace(/[\u0000-\u001F\u007F-\u009F]/g, "") // Remove control characters
            .trim();

        // Try parsing directly
        return JSON.parse(jsonString);
    } catch (error) {
        console.error("JSON Parse Error:", {
            error: error.message,
            rawResponse:
                typeof response === "string"
                    ? response.substring(0, 300) + "..."
                    : "non-string response",
        });

        // Better error handling - try multiple salvage strategies
        try {
            let result;

            // Strategy 1: Try to find the last complete JSON object
            if (typeof response === "string") {
                // First, try to fix common unterminated string issues
                let fixedJson = response;

                // Check if we have an unterminated string (look for orphaned quotes)
                const matches = fixedJson.match(/"([^"\\]*(\\.[^"\\]*)*)$/);
                if (matches) {
                    // Add closing quote to fix unterminated string
                    fixedJson += '"';
                }

                // Check for unclosed braces/brackets
                const openBraces = (fixedJson.match(/\{/g) || []).length;
                const closeBraces = (fixedJson.match(/\}/g) || []).length;
                const openBrackets = (fixedJson.match(/\[/g) || []).length;
                const closeBrackets = (fixedJson.match(/\]/g) || []).length;

                // Add missing closing braces/brackets
                for (let i = 0; i < openBraces - closeBraces; i++) {
                    fixedJson += "}";
                }

                for (let i = 0; i < openBrackets - closeBrackets; i++) {
                    fixedJson += "]";
                }

                // Clean the JSON before parsing
                fixedJson = fixedJson
                    .replace(/```json\s*/gi, "")
                    .replace(/```/g, "")
                    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
                    .trim();

                try {
                    return JSON.parse(fixedJson);
                } catch (e) {
                    // If fixing didn't work, continue to other strategies
                }
            }

            // Strategy 2: Look for well-formed JSON sections
            if (typeof response === "string") {
                const possibleJsonMatch = response.match(/\{[\s\S]*\}/);
                if (possibleJsonMatch) {
                    // Clean the matched JSON before parsing
                    const cleaned = possibleJsonMatch[0].replace(
                        /[\u0000-\u001F\u007F-\u009F]/g,
                        ""
                    );
                    try {
                        return JSON.parse(cleaned);
                    } catch (e) {
                        // If this fails, continue to next strategy
                    }
                }
            }

            // Strategy 3: Try to reconstruct a minimal valid object from the response
            if (typeof response === "string") {
                // Extract any key-value pairs we can find
                const keyValuePairs = {};
                const keyValueRegex =
                    /"([^"]+)"\s*:\s*("[^"]*"|[\d\.]+|true|false|null|\{[\s\S]*?\}|\[[\s\S]*?\])/g;
                let match;

                while ((match = keyValueRegex.exec(response)) !== null) {
                    try {
                        const key = match[1];
                        const value = JSON.parse(match[2]);
                        keyValuePairs[key] = value;
                    } catch (e) {
                        // Skip this pair if we can't parse it
                    }
                }

                if (Object.keys(keyValuePairs).length > 0) {
                    return keyValuePairs;
                }
            }
        } catch (salvageErr) {
            console.error("Salvage Error:", salvageErr);
        }

        // Return a safe fallback with as much of the original response as possible
        return {
            function_call: null,
            thinking_process: null,
            final_answer: {
                content: {
                    main_idea:
                        typeof response === "string"
                            ? response.substring(0, 500)
                            : "Error processing response",
                    parse_error: error.message,
                },
            },
        };
    }
}

// Fixed regex escape function
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function searchKnowledgeBase(paperId, userId, { query, maxResults = 3 }) {
    // Create multiple query terms by splitting the query
    const queryTerms = query.split(/\s+/).filter((term) => term.length > 3);

    // Try multiple search strategies in order of specificity

    // 1. First try full-text search with the entire query
    let results = await KnowledgeBase.aggregate([
        {
            $match: {
                paper: new mongoose.Types.ObjectId(paperId),
                $text: { $search: query },
            },
        },
        { $unwind: "$chunks" },
        {
            $sort: {
                score: { $meta: "textScore" },
            },
        },
        { $limit: maxResults },
        {
            $project: {
                text: "$chunks.text",
                summary: "$chunks.summary",
                keywords: "$chunks.keywords",
                _id: 0,
                score: { $meta: "textScore" },
            },
        },
    ]);

    // 2. If no results, try regex with all terms (AND condition)
    if (results.length === 0 && queryTerms.length > 0) {
        const escapedTerms = queryTerms.map((term) => escapeRegExp(term));
        const regexPatterns = escapedTerms.map((term) => new RegExp(term, "i"));

        results = await KnowledgeBase.aggregate([
            { $match: { paper: new mongoose.Types.ObjectId(paperId) } },
            { $unwind: "$chunks" },
            {
                $match: {
                    $and: regexPatterns.map((pattern) => ({
                        "chunks.text": { $regex: pattern },
                    })),
                },
            },
            { $limit: maxResults },
            {
                $project: {
                    text: "$chunks.text",
                    summary: "$chunks.summary",
                    keywords: "$chunks.keywords",
                    _id: 0,
                },
            },
        ]);
    }

    // 3. If still no results, try individual terms (OR condition)
    if (results.length === 0 && queryTerms.length > 0) {
        const individualSearchPromises = queryTerms.map((term) =>
            KnowledgeBase.aggregate([
                { $match: { paper: new mongoose.Types.ObjectId(paperId) } },
                { $unwind: "$chunks" },
                {
                    $match: {
                        "chunks.text": {
                            $regex: new RegExp(escapeRegExp(term), "i"),
                        },
                    },
                },
                {
                    $project: {
                        text: "$chunks.text",
                        summary: "$chunks.summary",
                        keywords: "$chunks.keywords",
                        _id: 0,
                        term: { $literal: term }, // Track which term matched
                    },
                },
                { $limit: 1 },
            ])
        );

        const individualResults = await Promise.all(individualSearchPromises);
        results = individualResults.flat();
    }

    // 4. If still no results, just return the first chunk as fallback
    if (results.length === 0) {
        const fallback = await KnowledgeBase.findOne(
            { paper: paperId },
            {
                chunks: { $slice: [0, 1] },
            }
        );

        if (fallback && fallback.chunks && fallback.chunks.length > 0) {
            results = [
                {
                    text: fallback.chunks[0].text,
                    summary: fallback.chunks[0].summary,
                    keywords: fallback.chunks[0].keywords,
                },
            ];
        }
    }

    // Return the best chunks we found, prioritizing text field
    return results.map((r) => r.text);
}

// =======================
// FUNCTION CALL REGISTRY
// =======================
const FUNCTION_HANDLERS = {
    getPaperDetails: async (paperId, userId) => {
        const paper = await Paper.findOne({ _id: paperId, user: userId })
            .populate("knowledgeBase") // If linked
            .select(
                "title authors abstract keywords summary citations annotations"
            )
            .lean();

        if (!paper) {
            throw new ApiError(404, "Paper not found");
        }

        return {
            title: paper.title,
            abstract: paper.abstract,
            keywords: paper.keywords,
            summary: paper.summary || "",
            hierarchicalSummary:
                paper.knowledgeBase?.hierarchicalSummary || null,
        };
    },

    // Use the improved search function
    searchKnowledgeBase,

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

    // Paper-level context cache
    if (name === "getPaperDetails") {
        if (PAPER_CONTEXT_CACHE.has(paperId)) {
            return PAPER_CONTEXT_CACHE.get(paperId);
        }
        const result = await FUNCTION_HANDLERS[name](paperId, userId);
        PAPER_CONTEXT_CACHE.set(paperId, result);
        return result;
    }

    // Search result cache
    if (name === "searchKnowledgeBase") {
        const queryKey = `${paperId}-${params.query}`;
        // Cache validation
        if (SEARCH_RESULT_CACHE.has(queryKey)) {
            const cached = SEARCH_RESULT_CACHE.get(queryKey);
            if (cached.length >= params.maxResults) {
                return cached.slice(0, params.maxResults);
            }
        }
        const result = await FUNCTION_HANDLERS[name](paperId, userId, params);
        SEARCH_RESULT_CACHE.set(queryKey, result);
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

    // fallback - don't spread params here either
    return FUNCTION_HANDLERS[name](paperId, userId, params);
};

export const generateResponse = async (prompt) => {
    try {
        const result = await fastModel.generateContent(prompt);
        return result.response.text();
    } catch (err) {
        console.error("Generation error:", err);
        // Try fallback model
        try {
            const fallbackResult = await fastModel.generateContent(prompt);
            return fallbackResult.response.text();
        } catch (fallbackErr) {
            throw new Error("Failed to generate response");
        }
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
        const chat = fastModel.startChat({
            history: historyMessages.map((msg) => formatMessageForGemini(msg)),
        });

        // For the first message in a conversation, include system instructions with user's question
        let messageContent = lastMessage.content;
        if (historyMessages.length === 0 && systemPrompt) {
            messageContent = `${systemPrompt}\n\nUser question: ${messageContent}`;
        }

        // Send message with modified content
        const result = await chat.sendMessage(messageContent);
        console.log("Gemini Raw Response: ", result.response.text());
        return result.response.text();
    } catch (err) {
        console.error("Chat error:", err);
        try {
            // Fallback to fast model
            const fallbackChat = fastModel.startChat({
                history: messages
                    .slice(0, -1)
                    .filter((msg) => msg.role !== "system")
                    .map((msg) => formatMessageForGemini(msg)),
            });

            const fallbackResult = await fallbackChat.sendMessage(
                messages[messages.length - 1].content
            );
            return fallbackResult.response.text();
        } catch (fallbackErr) {
            throw new Error("Chat processing failed");
        }
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

// =======================
// EXPORT MODULE
// =======================

export default {
    analyzePaperChunks,
    refineSummary,
    generateResponse,
    generateChatResponse,
    generateHierarchicalSummary,
};
