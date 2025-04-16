import pdfParse from "pdf-parse";
import fs from "fs/promises";
import path from "path";
import Paper from "../models/paper.model.js";
import User from "../models/user.model.js";
import KnowledgeBase from "../models/knowledgeBase.model.js";
import asyncHandler from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import ChatMessage from "../models/chatMessage.model.js";
import geminiService from "../services/gemini.service.js";

const normalizeText = (text) => text.replace(/\s+/g, " ").trim();

export async function extractTextFromPDF(buffer) {
    try {
        const data = await pdfParse(buffer);
        const extracted = normalizeText(data.text);

        if (!extracted || extracted.length < 20) {
            // Could be image-only or blank PDF
            console.warn("⚠️ PDF appears to contain no extractable text.");
            throw new ApiError(400, "PDF contains no readable text");
        }

        return extracted;
    } catch (err) {
        console.error("❌ PDF parsing failed:", err.message);
        throw new ApiError(400, "Invalid or unreadable PDF file");
    }
}

async function removeFile(filePath) {
    if (!filePath) {
        console.warn("No file path provided to removeFile");
        return;
    }

    try {
        await fs.unlink(filePath);
        console.log(`✅ File deleted: ${filePath}`);
    } catch (err) {
        if (err.code === "EBUSY" || err.code === "EPERM") {
            console.warn(`⚠️ File is busy, retrying delete in 1s: ${filePath}`);
            await new Promise((resolve) => setTimeout(resolve, 1000));
            try {
                await fs.unlink(filePath);
                console.log(`✅ File deleted after retry: ${filePath}`);
            } catch (retryErr) {
                console.error(
                    `❌ Retry failed to delete file: ${filePath}`,
                    retryErr
                );
            }
        } else if (err.code === "ENOENT") {
            console.warn(`⚠️ File already deleted or not found: ${filePath}`);
        } else {
            console.error(`❌ File cleanup error: ${filePath}`, err);
        }
    }
}

export const uploadPapers = asyncHandler(async (req, res) => {
    try {
        const user = await User.findById(req.user?._id);

        if (!user) {
            console.error("Authenticated user not found in database");
            throw new ApiError(401, "User not found");
        }

        const files = req.files;
        console.log("Received files:", files);
        console.log("User ID:", user._id);

        if (!files || files.length === 0) {
            console.warn("No files uploaded");
            throw new ApiError(400, "No files uploaded");
        }

        console.log(`Received ${files.length} files from user ${user._id}`);

        // Tier validation
        const remainingUploads =
            user.uploadLimits.monthlyUploads - user.usage.currentMonthUploads;

        const maxAllowed = Math.min(
            remainingUploads,
            user.uploadLimits.concurrentPapers
        );

        if (files.length > maxAllowed) {
            const excessFiles = files.slice(maxAllowed);
            await Promise.all(excessFiles.map((f) => removeFile(f.path)));

            console.warn(
                `Upload limit exceeded. Allowed: ${maxAllowed}, Uploaded: ${files.length}`
            );

            throw new ApiError(413, {
                message: `Exceeded ${user.tier} tier limit`,
                limits: {
                    monthly: user.uploadLimits.monthlyUploads,
                    concurrent: user.uploadLimits.concurrentPapers,
                    remaining: remainingUploads,
                },
                rejectedFiles: excessFiles.map((f) => ({
                    filename: f.originalname,
                    error: "Upload limit exceeded",
                })),
            });
        }

        // Process uploaded papers
        const results = await Promise.allSettled(
            files.map((file) => processSinglePaper(file, user, req.body))
        );

        const successfulUploads = results.filter(
            (r) => r.status === "fulfilled"
        ).length;

        // Update user's monthly usage count
        if (successfulUploads > 0) {
            await User.findByIdAndUpdate(user._id, {
                $inc: { "usage.currentMonthUploads": successfulUploads },
            });
        }

        // Log processing summary
        console.log(
            `Processing completed for ${files.length} files. Success: ${successfulUploads}, Failed: ${results.length - successfulUploads}`
        );

        // Build response
        const response = {
            success: successfulUploads,
            failed: results.length - successfulUploads,
            papers: results.map((result, i) => {
                if (result.status === "fulfilled" && result.value?.paper) {
                    return {
                        ...formatPaperResponse(result.value.paper),
                        status: "fulfilled",
                    };
                } else {
                    console.error(
                        `Paper #${i + 1} failed or malformed result:`,
                        result
                    );
                    return {
                        error:
                            result.reason?.message ||
                            "Unknown error or malformed response",
                        status: result.status,
                    };
                }
            }),
            limits: {
                remaining: remainingUploads - successfulUploads,
                monthlyLimit: user.uploadLimits.monthlyUploads,
                concurrentLimit: user.uploadLimits.concurrentPapers,
            },
        };

        res.status(response.failed > 0 ? 207 : 200).json(response);
    } catch (err) {
        console.error("UploadPapers Error:", err);
        throw err; // Let asyncHandler convert it into proper ApiError response
    }
});

// Enhanced processing with progress tracking
async function processSinglePaper(file, user, metadata) {
    let paper;

    try {
        // ✅ Read file from disk safely
        const absolutePath = path.resolve(file.path);
        const buffer = await fs.readFile(absolutePath);

        // ✅ Extract and validate text
        const text = await extractTextFromPDF(buffer);
        const chunks = chunkText(text); // Creating chunks for semantic search

        // ✅ Create paper and placeholder KB
        const [createdPaper] = await Promise.all([
            Paper.create({
                title: metadata.title || path.parse(file.originalname).name,
                authors: metadata.authors || "",
                abstract: metadata.abstract || "",
                content: text,
                user: user._id,
                fileSize: file.size,
                processingStatus: "analyzing",
            }),
            KnowledgeBase.create({
                paper: null, // update later
                aggregatedSummary: "Analysis in progress...",
                aggregatedKeywords: [],
                chunks: chunks.map((text) => ({ text })), // each chunk in an object
            }),
        ]);

        paper = createdPaper;

        // ✅ Update KB with paper ref
        await KnowledgeBase.updateOne({ paper: null }, { paper: paper._id });

        // ✅ Process with Gemini
        const { aggregatedSummary, keywordsArray } =
            await processChunksWithGemini(chunks, user, paper);

        // ✅ Final updates
        await Promise.all([
            Paper.findByIdAndUpdate(paper._id, {
                summary: aggregatedSummary,
                keywords: keywordsArray,
                processingStatus: "completed",
            }),
            KnowledgeBase.findOneAndUpdate(
                { paper: paper._id },
                {
                    aggregatedSummary,
                    aggregatedKeywords: keywordsArray,
                }
            ),
        ]);

        // ✅ Return paper with populated KB
        return {
            paper: await Paper.findById(paper._id)
                .populate("knowledgeBase")
                .lean(),
        };
    } catch (err) {
        console.error("❌ processSinglePaper failed:", err);

        // Rollback if paper was partially created
        if (paper?._id) {
            await Promise.allSettled([
                Paper.findByIdAndDelete(paper._id),
                KnowledgeBase.deleteOne({ paper: paper._id }),
            ]);
        }

        return {
            error: err.message || "Failed to process PDF",
            filename: file.originalname,
        };
    } finally {
        try {
            await removeFile(file.path); // safe cleanup
        } catch (cleanupError) {
            console.warn(
                "⚠️ Failed to clean up file:",
                file.path,
                cleanupError.message
            );
        }
    }
}

// Helper functions
async function processChunksWithGemini(chunks, user, paper) {
    const result = await geminiService.analyzePaperChunks(
        chunks,
        null, // no previous summary initially
        user.tier
    );

    if (!result || !Array.isArray(result.summaries)) {
        throw new Error("Gemini analysis failed or returned invalid data.");
    }

    // Optional: store progress as 100% complete
    await Paper.updateOne(
        { _id: paper._id },
        {
            $set: {
                processingProgress: 100,
            },
        }
    );

    return {
        aggregatedSummary: await geminiService.refineSummary(
            result.aggregatedSummary
        ),
        keywordsArray: result.keywordsArray,
    };
}

function chunkText(text, chunkSize = 5000) {
    return Array.from({ length: Math.ceil(text.length / chunkSize) }, (_, i) =>
        text.slice(i * chunkSize, (i + 1) * chunkSize)
    );
}

function formatPaperResponse(paper, textLength = null, chunkCount = null) {
    if (!paper || !paper._id) {
        throw new Error("Invalid paper object passed to formatPaperResponse");
    }

    return {
        id: paper._id,
        title: paper.title,
        keywords: (paper.keywords || []).slice(0, 10),
        originalTextLength: textLength || paper.content?.length || 0,
        normalizedTextLength: paper.content?.length || 0,
        chunksProcessed: chunkCount || 0,
        createdAt: paper.createdAt,
    };
}

function formatBatchResponse(results) {
    return {
        success: results.filter((r) => r.status === "fulfilled").length,
        failed: results.filter((r) => r.status === "rejected").length,
        papers: results.map((r) =>
            r.value?.paper ? formatPaperResponse(r.value.paper) : null
        ),
        errors: results.map((r) => r.reason?.message || "Unknown error"),
    };
}

export const getPapers = asyncHandler(async (req, res) => {
    const papers = await Paper.find({ user: req.user.id })
        .populate({
            path: "knowledgeBase",
            select: "aggregatedSummary aggregatedKeywords",
        })
        .select("title authors abstract createdAt keywords knowledgeBase summary")
        .lean();

    console.log(papers);

    res.json(
        papers.map((paper) => ({
            ...paper,
            // Flatten the knowledgeBase data
            summary: paper.knowledgeBase?.aggregatedSummary || paper.summary || "",
            keywords: paper.knowledgeBase?.aggregatedKeywords || paper.keywords,
            // Remove the nested knowledgeBase if needed
            knowledgeBase: undefined,
        }))
    );
});

export const getPaperById = asyncHandler(async (req, res) => {
    const paper = await Paper.findById(req.params.id)
        .populate({
            path: "knowledgeBase",
            select: "aggregatedSummary aggregatedKeywords chunks hierarchicalSummary",
        })
        .lean();

    if (!paper) throw new ApiError(404, "Paper not found");
    if (paper.user.toString() !== req.user.id) {
        throw new ApiError(403, "Unauthorized access");
    }

    res.json({
        ...paper,
        knowledgeBase: paper.knowledgeBase || {
            aggregatedSummary: "",
            aggregatedKeywords: [],
            chunks: [],
            hierarchicalSummary: {},
        },
    });
});

export const deletePaper = asyncHandler(async (req, res) => {
    const paper = await Paper.findById(req.params.id);
    if (!paper) throw new ApiError(404, "Paper not found");
    if (paper.user.toString() !== req.user.id) {
        throw new ApiError(403, "Unauthorized operation");
    }

    await Promise.all([
        ChatMessage.deleteMany({ paper: paper._id }),
        KnowledgeBase.deleteOne({ paper: paper._id }),
        Paper.findByIdAndDelete(paper._id),
    ]);

    res.json({ message: "Paper and associated data deleted successfully" });
});
