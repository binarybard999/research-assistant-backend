import pdfParse from "pdf-parse";
import fs from "fs";
import path from "path";
import Paper from "../models/paper.model.js";
import KnowledgeBase from "../models/knowledgeBase.model.js";
import geminiService from "../services/gemini.service.js";
import asyncHandler from "../utils/asyncHandler.js";

async function extractTextFromPDF(buffer) {
    const data = await pdfParse(buffer);
    return data.text; // Extracted text from PDF
}

function normalizeText(text) {
    // Remove extra spaces, newlines, and tabs
    return text
        .replace(/\s+/g, ' ')     // Replace multiple whitespace characters with a single space
        .replace(/\n+/g, ' ')     // Replace newlines with spaces
        .replace(/\t+/g, ' ')     // Replace tabs with spaces
        .trim();                  // Remove leading and trailing whitespace
}

// Function to remove file from filesystem
function removeFile(filePath) {
    try {
        if (filePath && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`File removed: ${filePath}`);
        }
    } catch (err) {
        console.error(`Error removing file ${filePath}:`, err);
    }
}

export const uploadPaper = asyncHandler(async (req, res, next) => {
    // Store the file path if it exists
    const filePath = req.file?.path || null;

    try {
        const { title, authors, abstract } = req.body;
        if (!req.file) {
            return res.status(400).json({ message: "No file uploaded" });
        }

        // Use buffer if available, otherwise fallback to file path
        const dataBuffer = req.file.buffer || fs.readFileSync(filePath);

        // Extract text from the PDF using pdf-parse
        const rawExtractedText = await extractTextFromPDF(dataBuffer);

        // Normalize the text by removing extra spaces
        const extractedText = normalizeText(rawExtractedText);

        // Store the original text for debugging/comparison if needed
        const originalLength = rawExtractedText.length;
        const normalizedLength = extractedText.length;
        console.log(`Original text length: ${originalLength}, Normalized text length: ${normalizedLength}`);
        console.log(`Space reduction: ${(originalLength - normalizedLength) / originalLength * 100}%`);

        // Define chunk size (e.g., 3000 characters per chunk)
        const chunkSize = 5000;
        const chunks = [];
        for (let i = 0; i < extractedText.length; i += chunkSize) {
            chunks.push(extractedText.substring(i, i + chunkSize));
        }

        console.log(`Total chunks after normalization: ${chunks.length}`);

        // Initialize aggregators for the Knowledge Base
        let aggregatedSummary = "";
        let aggregatedKeywords = new Set();
        let aggregatedExplanations = "";

        // Process each chunk with the Gemini API
        let chunkCount = 0;
        const totalChunks = chunks.length;

        for (const chunk of chunks) {
            chunkCount++;
            console.log(`Processing chunk ${chunkCount}/${totalChunks}`);

            try {
                // Send just the paper chunk - the prompt formatting is handled inside the service
                const analysis = await geminiService.analyzePaper(chunk);

                // Now we can safely access properties since analysis should be a JSON object
                if (analysis.summary) {
                    aggregatedSummary += analysis.summary + "\n\n";
                }

                if (analysis.explanation) {
                    aggregatedExplanations += analysis.explanation + "\n\n";
                }

                if (Array.isArray(analysis.keywords)) {
                    analysis.keywords.forEach((kw) => aggregatedKeywords.add(kw.trim()));
                }
            } catch (chunkError) {
                console.error(`Error processing chunk ${chunkCount}:`, chunkError);
                // Continue with next chunk instead of failing the entire process
            }
        }

        // Convert aggregated keywords from Set to Array
        const keywordsArray = Array.from(aggregatedKeywords);

        // Create and save a new Paper document
        const paper = new Paper({
            title,
            authors,
            abstract,
            content: extractedText, // Save the normalized text
            summary: aggregatedSummary.trim(),
            keywords: keywordsArray,
            user: req.user.id,
        });
        await paper.save();

        // Create and save the Knowledge Base entry
        const knowledge = new KnowledgeBase({
            paper: paper._id,
            aggregatedSummary: aggregatedSummary.trim(),
            aggregatedKeywords: keywordsArray,
            aggregatedExplanations: aggregatedExplanations.trim(),
        });
        await knowledge.save();

        // Remove the file after successful processing
        if (filePath) {
            removeFile(filePath);
        }

        res.status(201).json({
            success: true,
            paper: {
                id: paper._id,
                title: paper.title,
                keywords: paper.keywords.slice(0, 10), // Return just first 10 keywords for response
                originalTextLength: originalLength,
                normalizedTextLength: normalizedLength,
                chunksProcessed: totalChunks
            }
        });
    } catch (err) {
        console.error("Error in uploadPaper:", err);

        // Remove the file if there was an error
        if (filePath) {
            removeFile(filePath);
        }

        next(err);
    }
});

export const getPapers = asyncHandler(async (req, res, next) => {
    try {
        const papers = await Paper.find({ user: req.user.id });
        res.json(papers);
    } catch (err) {
        next(err);
    }
});

export const getPaperById = asyncHandler(async (req, res, next) => {
    try {
        const paper = await Paper.findById(req.params.id);
        if (!paper) return res.status(404).json({ message: "Paper not found" });
        res.json(paper);
    } catch (err) {
        next(err);
    }
});