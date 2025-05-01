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
import { logActivity } from "./activity.controller.js";
import mongoose from "mongoose";

const normalizeText = (text) => text.replace(/\s+/g, " ").trim();

export async function extractTextFromPDF(buffer) {
    try {
        const data = await pdfParse(buffer);
        const extracted = normalizeText(data.text);

        if (!extracted || extracted.length < 20) {
            console.warn("⚠️ PDF appears to contain no extractable text.");
            throw new ApiError(400, "PDF contains no readable text");
        }

        return extracted;
    } catch (err) {
        console.error("❌ PDF parsing failed:", err.message);
        throw new ApiError(400, "Invalid or unreadable PDF file");
    }
}

// Chunking with text segmentation
function chunkTextBySections(text, fallbackChunkSize = 3000) {
    // Try to detect sections using regex patterns for common section headers
    const sectionPatterns = [
        /\n\s*(?:ABSTRACT|Abstract|abstract)\s*[:.\n]/,
        /\n\s*(?:INTRODUCTION|Introduction|introduction)\s*[:.\n]/,
        /\n\s*(?:METHODS?|Methods?|METHODOLOGY|Methodology)\s*[:.\n]/,
        /\n\s*(?:RESULTS?|Results?)\s*[:.\n]/,
        /\n\s*(?:DISCUSSION|Discussion)\s*[:.\n]/,
        /\n\s*(?:CONCLUSION|Conclusion)s?\s*[:.\n]/,
        /\n\s*(?:REFERENCES|References|BIBLIOGRAPHY|Bibliography)\s*[:.\n]/,
        /\n\s*(?:\d+\.|\d+\s+)[A-Z][^.!?]*[:.\n]/g, // Numbered sections
    ];

    // Find potential section breaks
    let sectionBreaks = [];

    // Collect all section breaks
    sectionPatterns.forEach((pattern) => {
        let match;
        if (pattern.global) {
            while ((match = pattern.exec(text)) !== null) {
                sectionBreaks.push(match.index);
            }
        } else {
            match = text.match(pattern);
            if (match) sectionBreaks.push(match.index);
        }
    });

    // Add start and end positions
    sectionBreaks.push(0);
    sectionBreaks.push(text.length);

    // Sort and deduplicate section breaks
    sectionBreaks = [...new Set(sectionBreaks)].sort((a, b) => a - b);

    // Extract chunks based on section breaks
    const chunks = [];

    console.log(
        `Found ${sectionBreaks.length - 1} potential sections in the document`
    );

    for (let i = 0; i < sectionBreaks.length - 1; i++) {
        const start = sectionBreaks[i];
        const end = sectionBreaks[i + 1];
        const section = text.substring(start, end).trim();

        // Skip empty or too small sections
        if (section.length < 50) continue;

        // IMPORTANT: For very large sections, always split into smaller chunks
        if (section.length > fallbackChunkSize) {
            const subChunks = chunkTextBySize(section, fallbackChunkSize);
            chunks.push(...subChunks);
            console.log(
                `Split large section (${section.length} chars) into ${subChunks.length} chunks`
            );
        } else {
            chunks.push(section);
        }
    }

    // CRITICAL: If we got no chunks or just one huge chunk, force chunking by size
    if (chunks.length <= 1) {
        console.log(
            `Section detection produced ${chunks.length} chunks. Falling back to size-based chunking.`
        );
        return chunkTextBySize(text, fallbackChunkSize);
    }

    console.log(
        `Successfully created ${chunks.length} chunks by section detection`
    );
    return chunks;
}

function chunkTextBySize(text, chunkSize = 3000) {
    // Try to split at paragraph breaks for more natural chunks
    const paragraphs = text.split(/\n\s*\n/);
    const chunks = [];
    let currentChunk = "";

    for (const paragraph of paragraphs) {
        // If adding this paragraph would exceed the chunk size and we already have content
        if (
            currentChunk.length + paragraph.length > chunkSize &&
            currentChunk.length > 0
        ) {
            chunks.push(currentChunk.trim());
            currentChunk = paragraph;
        } else {
            currentChunk += (currentChunk ? "\n\n" : "") + paragraph;
        }
    }

    // Don't forget the last chunk
    if (currentChunk) {
        chunks.push(currentChunk.trim());
    }

    // Fallback: If we still have no chunks or just one huge chunk, use mechanical approach
    if (chunks.length <= 1 && text.length > chunkSize) {
        console.log("Falling back to mechanical chunking by character count");
        return Array.from(
            { length: Math.ceil(text.length / chunkSize) },
            (_, i) => text.slice(i * chunkSize, (i + 1) * chunkSize).trim()
        );
    }

    console.log(
        `Created ${chunks.length} chunks by paragraph-aware size splitting`
    );
    return chunks;
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

// Processing with hierarchical structure
async function processSinglePaper(file, user, metadata) {
    let paper;

    try {
        // Read file from disk safely
        const absolutePath = path.resolve(file.path);
        const buffer = await fs.readFile(absolutePath);

        // Extract and validate text
        const text = await extractTextFromPDF(buffer);

        // Ensure creating multiple chunks
        const chunks = chunkTextBySections(text);

        console.log(
            `Created ${chunks.length} chunks from PDF. Chunk sizes: ${chunks.map((c) => c.length).join(", ")}`
        );

        // Validate that chunking worked - if not, force rechunking
        if (chunks.length === 1 && text.length > 5000) {
            console.log(
                "Warning: Only one chunk created. Forcing size-based chunking."
            );
            chunks = chunkTextBySize(text, 3000);
        }

        // Create paper and placeholder KB
        const knowledgeBase = await KnowledgeBase.create({
            paper: null, // update later
            aggregatedSummary: "Analysis in progress...",
            aggregatedKeywords: [],
            chunks: chunks.map((text) => ({
                text,
                summary: "", // Will be filled in later
                keywords: [],
            })),
            hierarchicalSummary: {
                overview: "Processing in progress...",
                sections: [],
            },
        });

        const createdPaper = await Paper.create({
            title: metadata.title || path.parse(file.originalname).name,
            authors: metadata.authors || "",
            abstract: metadata.abstract || "",
            content:
                text.substring(0, 5000) + (text.length > 5000 ? "..." : ""), // Only store a preview in the paper
            user: user._id,
            fileSize: file.size,
            processingStatus: "analyzing",
            knowledgeBase: knowledgeBase._id, // Link to KB immediately
        });

        paper = createdPaper;

        // Update KB with paper ref
        await KnowledgeBase.findByIdAndUpdate(knowledgeBase._id, {
            paper: paper._id,
        });

        // Update progress to 20%
        await Paper.updateOne(
            { _id: paper._id },
            { $set: { processingProgress: 20 } }
        );

        // Process with Gemini - make sure to pass ALL chunks
        const { aggregatedSummary, keywordsArray, hierarchicalSummary } =
            await processChunksWithGemini(chunks, user, paper);

        // Final updates with hierarchical summary
        await Promise.all([
            Paper.findByIdAndUpdate(paper._id, {
                summary: aggregatedSummary,
                keywords: keywordsArray,
                processingStatus: "completed",
                processingProgress: 100,
            }),
            KnowledgeBase.findByIdAndUpdate(knowledgeBase._id, {
                aggregatedSummary,
                aggregatedKeywords: keywordsArray,
                hierarchicalSummary,
            }),
        ]);

        // Return paper with populated KB
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

// Processing function with hierarchical organization
async function processChunksWithGemini(chunks, user, paper) {
    // IMPORTANT: Process chunks in smaller batches
    const batchSize = 2; // Process 2 chunks at a time
    const chunkResults = [];
    let progress = 20;
    const progressStep = 50 / chunks.length; // 50% progress dedicated to chunk analysis

    console.log(`Processing ${chunks.length} chunks with Gemini...`);

    // Process chunks in batches
    for (let i = 0; i < chunks.length; i += batchSize) {
        // Get current batch of chunks
        const batch = chunks.slice(i, Math.min(i + batchSize, chunks.length));

        console.log(
            `Processing batch ${Math.floor(i / batchSize) + 1}, chunks ${i + 1}-${i + batch.length} of ${chunks.length}`
        );

        // Process this batch
        const batchResults = await geminiService.analyzePaperChunks(
            batch,
            i > 0 ? chunkResults[i - 1]?.summary : null,
            user.tier
        );

        // Store results for each chunk in this batch
        for (let j = 0; j < batch.length; j++) {
            const chunkIndex = i + j;
            if (batchResults.summaries[j]) {
                chunkResults[chunkIndex] = {
                    text: chunks[chunkIndex],
                    summary: batchResults.summaries[j].summary || "",
                    keywords: batchResults.summaries[j].keywords || [],
                };

                // Update each chunk in the knowledge base as we process them
                await KnowledgeBase.updateOne(
                    { paper: paper._id, "chunks.text": chunks[chunkIndex] },
                    {
                        $set: {
                            "chunks.$.summary":
                                batchResults.summaries[j].summary || "",
                            "chunks.$.keywords":
                                batchResults.summaries[j].keywords || [],
                        },
                    }
                );
            }
        }

        // Update processing progress
        progress += progressStep * batch.length;
        await Paper.updateOne(
            { _id: paper._id },
            { $set: { processingProgress: Math.min(70, Math.round(progress)) } }
        );

        // Add a small delay between batches to avoid rate limiting
        if (i + batchSize < chunks.length) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }

    // Update progress to 70%
    await Paper.updateOne(
        { _id: paper._id },
        { $set: { processingProgress: 70 } }
    );

    // Collect all summaries and keywords
    const allSummaries = chunkResults
        .map((r) => r.summary)
        .filter(Boolean)
        .join("\n\n");
    const allKeywords = Array.from(
        new Set(chunkResults.flatMap((r) => r.keywords).filter(Boolean))
    );

    console.log(
        `Generated ${allSummaries.length} chars of summary content from all chunks`
    );

    // Generate hierarchical structure with improved error handling
    let hierarchicalSummary;
    try {
        const hierarchicalResponse =
            await geminiService.generateHierarchicalSummary(allSummaries);
        hierarchicalSummary = hierarchicalResponse;
    } catch (err) {
        console.error("Failed to generate hierarchical summary:", err);
        // Fallback to simpler structure
        hierarchicalSummary = {
            overview:
                allSummaries.length > 1000
                    ? allSummaries.substring(0, 1000) + "..."
                    : allSummaries,
            sections: [],
        };
    }

    // Update progress to 90%
    await Paper.updateOne(
        { _id: paper._id },
        { $set: { processingProgress: 90 } }
    );

    // Create final aggregate summary
    let aggregatedSummary;
    try {
        aggregatedSummary = await geminiService.refineSummary(
            hierarchicalSummary.overview || allSummaries
        );
    } catch (err) {
        console.error("Failed to refine summary:", err);
        aggregatedSummary =
            hierarchicalSummary.overview ||
            (allSummaries.length > 500
                ? allSummaries.substring(0, 500) + "..."
                : allSummaries);
    }

    return {
        aggregatedSummary,
        keywordsArray: allKeywords.slice(0, 20), // Limit to top 20 keywords
        hierarchicalSummary,
    };
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
        chunksProcessed: chunkCount || paper.knowledgeBase?.chunks?.length || 0,
        createdAt: paper.createdAt,
    };
}

export const getPapers = asyncHandler(async (req, res) => {
    const papers = await Paper.find({ user: req.user.id })
        .populate({
            path: "knowledgeBase",
            select: "aggregatedSummary aggregatedKeywords hierarchicalSummary",
        })
        .select(
            "title authors abstract createdAt keywords knowledgeBase summary processingStatus processingProgress"
        )
        .lean();

    res.json(
        papers.map((paper) => ({
            ...paper,
            // Flatten the knowledgeBase data
            summary:
                paper.knowledgeBase?.aggregatedSummary || paper.summary || "",
            keywords: paper.knowledgeBase?.aggregatedKeywords || paper.keywords,
            hierarchicalSummary: paper.knowledgeBase?.hierarchicalSummary,
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
            hierarchicalSummary: {
                overview: "",
                sections: [],
            },
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

// Library Functions
// Toggle paper favorite status
export const toggleFavorite = async (req, res) => {
    try {
        const { id } = req.params;

        const paper = await Paper.findOne({ _id: id, user: req.user.id });
        if (!paper) {
            return res.status(404).json({ message: "Paper not found" });
        }

        if (!paper.metadata) paper.metadata = {};
        const isFavorite = !paper.metadata.isFavorite;
        paper.metadata.isFavorite = isFavorite;
        await paper.save();

        // Log activity
        await logActivity(
            req.user.id,
            isFavorite ? "favorited_paper" : "unfavorited_paper",
            paper._id
        );

        res.json({ isFavorite });
    } catch (error) {
        res.status(500).json({
            message: "Error toggling favorite status",
            error: error.message,
        });
    }
};

// Add annotation to paper
export const addAnnotation = async (req, res) => {
    try {
        const { id } = req.params;
        const { content, page, contextSnippet } = req.body;

        if (!content) {
            return res
                .status(400)
                .json({ message: "Annotation content is required" });
        }

        const paper = await Paper.findOne({ _id: id, user: req.user.id });
        if (!paper) {
            return res.status(404).json({ message: "Paper not found" });
        }

        const annotation = {
            content,
            page: page || 1,
            contextSnippet: contextSnippet || "",
            createdBy: req.user.id,
            createdAt: new Date(),
        };

        paper.annotations.push(annotation);
        await paper.save();

        // Log activity
        await logActivity(req.user.id, "added_annotation", paper._id, null, {
            page,
        });

        res.status(201).json(annotation);
    } catch (error) {
        res.status(500).json({
            message: "Error adding annotation",
            error: error.message,
        });
    }
};

// Get annotations for a paper
export const getAnnotations = async (req, res) => {
    try {
        const { id } = req.params;
        const { page } = req.query;

        const paper = await Paper.findOne({ _id: id, user: req.user.id });
        if (!paper) {
            return res.status(404).json({ message: "Paper not found" });
        }

        let annotations = paper.annotations;

        // Filter by page if specified
        if (page) {
            annotations = annotations.filter((a) => a.page === parseInt(page));
        }

        res.json(annotations);
    } catch (error) {
        res.status(500).json({
            message: "Error getting annotations",
            error: error.message,
        });
    }
};

// Delete annotation
export const deleteAnnotation = async (req, res) => {
    try {
        const { id, annotationId } = req.params;

        const paper = await Paper.findOne({ _id: id, user: req.user.id });
        if (!paper) {
            return res.status(404).json({ message: "Paper not found" });
        }

        const annotationIndex = paper.annotations.findIndex(
            (a) => a._id.toString() === annotationId
        );

        if (annotationIndex === -1) {
            return res.status(404).json({ message: "Annotation not found" });
        }

        // Remove the annotation
        paper.annotations.splice(annotationIndex, 1);
        await paper.save();

        // Log activity
        await logActivity(req.user.id, "removed_annotation", paper._id);

        res.json({ message: "Annotation deleted" });
    } catch (error) {
        res.status(500).json({
            message: "Error deleting annotation",
            error: error.message,
        });
    }
};

// Update paper metadata
export const updatePaperMetadata = async (req, res) => {
    try {
        const { id } = req.params;
        const { title, authors, abstract, keywords } = req.body;

        const paper = await Paper.findOne({ _id: id, user: req.user.id });
        if (!paper) {
            return res.status(404).json({ message: "Paper not found" });
        }

        // Update fields if provided
        if (title) paper.title = title;
        if (authors) paper.authors = authors;
        if (abstract) paper.abstract = abstract;
        if (keywords) paper.keywords = keywords;

        await paper.save();

        // Log activity
        await logActivity(req.user.id, "edited_paper_metadata", paper._id);

        res.json(paper);
    } catch (error) {
        res.status(500).json({
            message: "Error updating paper metadata",
            error: error.message,
        });
    }
};

// Delete paper
// export const deletePaper = async (req, res) => {
//     try {
//         const { id } = req.params;

//         const paper = await Paper.findOne({ _id: id, user: req.user.id });
//         if (!paper) {
//             return res.status(404).json({ message: "Paper not found" });
//         }

//         const session = await mongoose.startSession();
//         session.startTransaction();

//         try {
//             // Delete associated knowledge base
//             if (paper.knowledgeBase) {
//                 await KnowledgeBase.findByIdAndDelete(paper.knowledgeBase, { session });
//             }

//             // Delete the paper
//             await Paper.findByIdAndDelete(id, { session });

//             // Delete the file if it exists
//             if (paper.metadata && paper.metadata.fileName) {
//                 const filePath = `${process.env.UPLOADS_PATH || './uploads'}/${id}`;
//                 if (fs.existsSync(filePath)) {
//                     fs.unlinkSync(filePath);
//                 }
//             }

//             await session.commitTransaction();
//             session.endSession();

//             // Log activity
//             await logActivity(req.user.id, "deleted_paper", null, null, {
//                 paperTitle: paper.title,
//                 paperId: paper._id.toString()
//             });

//             res.json({ message: "Paper deleted successfully" });
//         } catch (error) {
//             await session.abortTransaction();
//             session.endSession();
//             throw error;
//         }
//     } catch (error) {
//         res.status(500).json({ message: "Error deleting paper", error: error.message });
//     }
// };

// Get citations for a paper
export const getPaperCitations = async (req, res) => {
    try {
        const { id } = req.params;

        const paper = await Paper.findOne({ _id: id, user: req.user.id });
        if (!paper) {
            return res.status(404).json({ message: "Paper not found" });
        }

        res.json(paper.citations || []);
    } catch (error) {
        res.status(500).json({
            message: "Error getting citations",
            error: error.message,
        });
    }
};

// Add citation to paper
export const addCitation = async (req, res) => {
    try {
        const { id } = req.params;
        const { title, authors, source, year, doi } = req.body;

        if (!title) {
            return res
                .status(400)
                .json({ message: "Citation title is required" });
        }

        const paper = await Paper.findOne({ _id: id, user: req.user.id });
        if (!paper) {
            return res.status(404).json({ message: "Paper not found" });
        }

        const citation = {
            title,
            authors: Array.isArray(authors)
                ? authors
                : authors
                  ? [authors]
                  : [],
            source: source || "",
            year: year || null,
            doi: doi || "",
        };

        if (!paper.citations) paper.citations = [];
        paper.citations.push(citation);
        await paper.save();

        res.status(201).json(citation);
    } catch (error) {
        res.status(500).json({
            message: "Error adding citation",
            error: error.message,
        });
    }
};

// Delete citation
export const deleteCitation = async (req, res) => {
    try {
        const { id, citationId } = req.params;

        const paper = await Paper.findOne({ _id: id, user: req.user.id });
        if (!paper) {
            return res.status(404).json({ message: "Paper not found" });
        }

        const citationIndex = paper.citations.findIndex(
            (c) => c._id.toString() === citationId
        );

        if (citationIndex === -1) {
            return res.status(404).json({ message: "Citation not found" });
        }

        paper.citations.splice(citationIndex, 1);
        await paper.save();

        res.json({ message: "Citation deleted" });
    } catch (error) {
        res.status(500).json({
            message: "Error deleting citation",
            error: error.message,
        });
    }
};
