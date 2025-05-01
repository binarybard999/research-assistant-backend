import archiver from "archiver";
import fs from "fs";
import path from "path";
import Paper from "../models/paper.model.js";
import KnowledgeBase from "../models/knowledgeBase.model.js";
import ReadingList from "../models/readingList.model.js";
import ChatMessage from "../models/chatMessage.model.js";
import Activity from "../models/activity.model.js";
import { logActivity } from "./activity.controller.js";

// Get user's library (all papers)
export const getUserLibrary = async (req, res) => {
    try {
        const {
            sort = "updatedAt",
            order = "desc",
            limit = 20,
            skip = 0,
            search = "",
            tags = [],
            authors = [],
        } = req.query;

        // Build query
        const query = { user: req.user.id };

        // Validate numerical parameters
        if (isNaN(limit) || isNaN(skip)) {
            return res
                .status(400)
                .json({ message: "Invalid pagination values" });
        }

        // Add search functionality
        if (search) {
            query.$or = [
                { title: { $regex: search, $options: "i" } },
                { abstract: { $regex: search, $options: "i" } },
                { authors: { $regex: search, $options: "i" } },
                { keywords: { $in: [new RegExp(search, "i")] } },
            ];
        }

        // Filter by tags/keywords
        if (tags && tags.length > 0) {
            query.keywords = { $in: Array.isArray(tags) ? tags : [tags] };
        }

        // Filter by authors
        if (authors && authors.length > 0) {
            query.authors = {
                $regex: Array.isArray(authors) ? authors.join("|") : authors,
                $options: "i",
            };
        }

        // Get total count for pagination
        const total = await Paper.countDocuments(query);

        // Empty state handling
        if (total === 0) {
            return res.json({
                papers: [],
                total: 0,
                message: "No papers found",
            });
        }

        // Get papers
        const papers = await Paper.find(query)
            .select(
                "title authors abstract keywords summary createdAt updatedAt"
            )
            .sort({ [sort]: order === "asc" ? 1 : -1 })
            .skip(parseInt(skip))
            .limit(parseInt(limit));

        res.json({
            papers,
            total,
            limit: parseInt(limit),
            skip: parseInt(skip),
        });
    } catch (error) {
        res.status(500).json({
            message: "Error fetching library",
            error: error.message,
        });
    }
};

// Get favorite papers
export const getFavoritePapers = async (req, res) => {
    try {
        const { limit = 20, skip = 0 } = req.query;

        const papers = await Paper.find({
            user: req.user.id,
            "metadata.isFavorite": true,
        })
            .select(
                "title authors abstract keywords summary createdAt updatedAt"
            )
            .sort({ updatedAt: -1 })
            .skip(parseInt(skip))
            .limit(parseInt(limit));

        // Get total count for pagination
        const total = await Paper.countDocuments({
            user: req.user.id,
            "metadata.isFavorite": true,
        });

        res.json({
            papers,
            total,
            limit: parseInt(limit),
            skip: parseInt(skip),
        });
    } catch (error) {
        res.status(500).json({
            message: "Error fetching favorite papers",
            error: error.message,
        });
    }
};

// Get full paper details including knowledge base
export const getFullPaperDetails = async (req, res) => {
    try {
        const { id } = req.params;

        // Find the paper and make sure it belongs to the user
        const paper = await Paper.findOne({
            _id: id,
            user: req.user.id,
        }).populate("knowledgeBase");

        if (!paper) {
            return res.status(404).json({ message: "Paper not found" });
        }

        // Log view activity
        await logActivity(req.user.id, "viewed_paper", paper._id);

        // Find reading lists containing this paper
        const readingLists = await ReadingList.find({
            user: req.user.id,
            papers: paper._id,
        }).select("name");

        res.json({
            paper,
            readingLists,
        });
    } catch (error) {
        res.status(500).json({
            message: "Error fetching paper details",
            error: error.message,
        });
    }
};

// Export bundle
export const exportBundle = async (req, res) => {
    try {
        const { id } = req.params;
        const { includeAnnotations = true, includeChat = true } = req.query;

        // Find the paper and make sure it belongs to the user
        const paper = await Paper.findOne({ _id: id, user: req.user.id });
        if (!paper) {
            return res.status(404).json({ message: "Paper not found" });
        }

        // Get knowledge base data
        const kb = await KnowledgeBase.findById(paper.knowledgeBase);

        // Get chat history if requested
        let chatHistory = [];
        if (includeChat) {
            chatHistory = await ChatMessage.find({
                paper: paper._id,
                user: req.user.id,
            }).sort({ createdAt: 1 });
        }

        // Set up response
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${paper.title.replace(/[^a-z0-9]/gi, "_").toLowerCase()}.zip"`
        );
        const archive = archiver("zip");
        archive.pipe(res);

        // Add paper metadata
        const metadata = {
            title: paper.title,
            authors: paper.authors,
            abstract: paper.abstract,
            keywords: paper.keywords,
            summary: paper.summary,
            citations: paper.citations,
        };

        archive.append(JSON.stringify(metadata, null, 2), {
            name: "metadata.json",
        });

        // Add knowledge base data
        if (kb) {
            archive.append(
                JSON.stringify(
                    {
                        aggregatedSummary: kb.aggregatedSummary,
                        aggregatedKeywords: kb.aggregatedKeywords,
                        hierarchicalSummary: kb.hierarchicalSummary,
                    },
                    null,
                    2
                ),
                { name: "knowledge_base.json" }
            );

            // Add chunks as individual files
            if (kb.chunks && kb.chunks.length > 0) {
                const chunksData = JSON.stringify(kb.chunks, null, 2);
                archive.append(chunksData, { name: "chunks.json" });
            }
        }

        // Add annotations if requested
        if (
            includeAnnotations &&
            paper.annotations &&
            paper.annotations.length > 0
        ) {
            const annotationsData = JSON.stringify(paper.annotations, null, 2);
            archive.append(annotationsData, { name: "annotations.json" });
        }

        // Add chat history if requested
        if (includeChat && chatHistory.length > 0) {
            const chatData = JSON.stringify(chatHistory, null, 2);
            archive.append(chatData, { name: "chat_history.json" });
        }

        // Add original file if it exists
        if (paper.metadata && paper.metadata.fileName) {
            const filePath = `${process.env.UPLOADS_PATH || "./uploads"}/${paper._id.toString()}`;
            if (fs.existsSync(filePath)) {
                archive.file(filePath, { name: paper.metadata.fileName });
            }
        }

        await archive.finalize();

        // Log activity
        await logActivity(req.user.id, "exported_bundle", paper._id);
    } catch (error) {
        console.error("Export error:", error);
        res.status(500).json({
            message: "Error exporting bundle",
            error: error.message,
        });
    }
};

// Get recommendations
export const getRecommendations = async (req, res) => {
    try {
        const { id } = req.params;
        const { limit = 5 } = req.query;

        const paper = await Paper.findById(id);
        if (!paper) {
            return res.status(404).json({ message: "Paper not found" });
        }

        const all = await Paper.find({
            user: req.user.id,
            _id: { $ne: paper._id },
        });

        // Enhanced recommendation algorithm
        const recommendations = all
            .map((p) => {
                // Calculate keyword similarity score
                const keywordScore = p.keywords.filter((k) =>
                    paper.keywords.includes(k)
                ).length;

                // Calculate title similarity score (simple word overlap for now)
                const paperTitleWords = paper.title.toLowerCase().split(/\s+/);
                const pTitleWords = p.title.toLowerCase().split(/\s+/);
                const titleOverlap = paperTitleWords.filter(
                    (word) => pTitleWords.includes(word) && word.length > 3
                ).length;

                // Calculate author similarity
                const paperAuthors = paper.authors
                    ? paper.authors.split(",").map((a) => a.trim())
                    : [];
                const pAuthors = p.authors
                    ? p.authors.split(",").map((a) => a.trim())
                    : [];
                const authorOverlap = paperAuthors.filter((author) =>
                    pAuthors.includes(author)
                ).length;

                return {
                    paper: p,
                    keywordScore,
                    titleScore: titleOverlap * 0.5,
                    authorScore: authorOverlap * 2,
                    get totalScore() {
                        return (
                            this.keywordScore +
                            this.titleScore +
                            this.authorScore
                        );
                    },
                };
            })
            .sort((a, b) => b.totalScore - a.totalScore)
            .slice(0, parseInt(limit))
            .map((r) => ({
                paper: {
                    _id: r.paper._id,
                    title: r.paper.title,
                    authors: r.paper.authors,
                    abstract: r.paper.abstract,
                    keywords: r.paper.keywords,
                },
                similarityScore: r.totalScore,
                matchingKeywords: r.paper.keywords.filter((k) =>
                    paper.keywords.includes(k)
                ),
            }));

        res.json(recommendations);
    } catch (error) {
        res.status(500).json({
            message: "Error getting recommendations",
            error: error.message,
        });
    }
};

// Get library statistics
export const getLibraryStats = async (req, res) => {
    try {
        // Get total papers count
        const totalPapers = await Paper.countDocuments({ user: req.user.id });

        // Get papers by month
        const papersByMonth = await Paper.aggregate([
            { $match: { user: req.user.id } },
            {
                $group: {
                    _id: {
                        year: { $year: "$createdAt" },
                        month: { $month: "$createdAt" },
                    },
                    count: { $sum: 1 },
                },
            },
            { $sort: { "_id.year": 1, "_id.month": 1 } },
        ]);

        // Get most common keywords
        const keywords = await Paper.aggregate([
            { $match: { user: req.user.id } },
            { $unwind: "$keywords" },
            { $group: { _id: "$keywords", count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 20 },
        ]);

        // Get authors statistics
        const authors = await Paper.aggregate([
            { $match: { user: req.user.id } },
            { $project: { authorsList: { $split: ["$authors", ","] } } },
            { $unwind: "$authorsList" },
            {
                $group: {
                    _id: { $trim: { input: "$authorsList" } },
                    count: { $sum: 1 },
                },
            },
            { $match: { _id: { $ne: "" } } },
            { $sort: { count: -1 } },
            { $limit: 20 },
        ]);

        res.json({
            totalPapers,
            papersByMonth,
            topKeywords: keywords,
            topAuthors: authors,
        });
    } catch (error) {
        res.status(500).json({
            message: "Error fetching library statistics",
            error: error.message,
        });
    }
};

// Export citations
export const exportCitations = async (req, res) => {
    try {
        const { ids } = req.body;
        const { format = "bibtex" } = req.query;

        // Validate input
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ message: "Paper IDs required" });
        }

        // Validate format
        const validFormats = ["bibtex", "apa", "mla", "chicago"];
        if (!validFormats.includes(format)) {
            return res.status(400).json({ message: "Invalid citation format" });
        }

        // Get papers
        const papers = await Paper.find({
            _id: { $in: ids },
            user: req.user.id,
        }).select("title authors citations");

        let output = "";

        // Generate citations based on format
        if (format === "bibtex") {
            papers.forEach((paper) => {
                const id = paper.title
                    .replace(/\s+/g, "")
                    .replace(/[^a-zA-Z0-9]/g, "");
                const year =
                    (paper.citations && paper.citations[0]?.year) ||
                    new Date().getFullYear();
                const authors = paper.authors.replace(/,/g, " and ");

                output += `@article{${id}${year},\n`;
                output += `  title={${paper.title}},\n`;
                output += `  author={${authors}},\n`;
                if (paper.citations && paper.citations[0]?.year) {
                    output += `  year={${paper.citations[0].year}},\n`;
                }
                if (paper.citations && paper.citations[0]?.source) {
                    output += `  journal={${paper.citations[0].source}},\n`;
                }
                if (paper.citations && paper.citations[0]?.doi) {
                    output += `  doi={${paper.citations[0].doi}},\n`;
                }
                output += `}\n\n`;
            });
        } else {
            // For other formats, implement simplified versions
            papers.forEach((paper) => {
                const year =
                    (paper.citations && paper.citations[0]?.year) ||
                    new Date().getFullYear();
                const source =
                    (paper.citations && paper.citations[0]?.source) || "";

                switch (format) {
                    case "apa":
                        output += `${paper.authors}. (${year}). ${paper.title}. ${source}.\n\n`;
                        break;
                    case "mla":
                        output += `${paper.authors}. "${paper.title}." ${source}, ${year}.\n\n`;
                        break;
                    case "chicago":
                        output += `${paper.authors}. "${paper.title}." ${source} (${year}).\n\n`;
                        break;
                }
            });
        }

        res.setHeader("Content-Type", "text/plain");
        res.setHeader(
            "Content-Disposition",
            `attachment; filename=citations.${format === "bibtex" ? "bib" : "txt"}`
        );
        res.send(output);

        // Log activity
        await logActivity(req.user.id, "exported_citations", null);
    } catch (error) {
        res.status(500).json({
            message: "Error exporting citations",
            error: error.message,
        });
    }
};

// Bulk tag papers
export const bulkTagPapers = async (req, res) => {
    try {
        const { paperIds, tags, operation = "add" } = req.body;

        if (!paperIds || !Array.isArray(paperIds) || paperIds.length === 0) {
            return res.status(400).json({ message: "Paper IDs required" });
        }

        if (!tags || !Array.isArray(tags) || tags.length === 0) {
            return res.status(400).json({ message: "Tags required" });
        }

        let updateOperation;
        if (operation === "add") {
            // Add tags without duplicates
            updateOperation = {
                $addToSet: { keywords: { $each: tags } },
            };
        } else if (operation === "remove") {
            // Remove specified tags
            updateOperation = {
                $pull: { keywords: { $in: tags } },
            };
        } else {
            return res
                .status(400)
                .json({ message: "Invalid operation. Use 'add' or 'remove'" });
        }

        // Update all papers
        const result = await Paper.updateMany(
            { _id: { $in: paperIds }, user: req.user.id },
            updateOperation
        );

        res.json({
            message: `Tags ${operation === "add" ? "added to" : "removed from"} ${result.modifiedCount} papers`,
            modifiedCount: result.modifiedCount,
        });

        // Log activity
        await logActivity(
            req.user.id,
            `${operation === "add" ? "added_tags" : "removed_tags"}`,
            null,
            null,
            { paperCount: result.modifiedCount, tags }
        );
    } catch (error) {
        res.status(500).json({
            message: "Error updating tags",
            error: error.message,
        });
    }
};

// Save reading session
export const saveReadingSession = async (req, res) => {
    try {
        const { paperId, pageNumber, duration, notes } = req.body;

        if (!paperId || !pageNumber) {
            return res
                .status(400)
                .json({ message: "Paper ID and page number required" });
        }

        // Find the paper
        const paper = await Paper.findOne({ _id: paperId, user: req.user.id });
        if (!paper) {
            return res.status(404).json({ message: "Paper not found" });
        }

        // Add to paper's metadata
        if (!paper.metadata) paper.metadata = {};
        if (!paper.metadata.readingSessions)
            paper.metadata.readingSessions = [];

        paper.metadata.readingSessions.push({
            timestamp: new Date(),
            pageNumber,
            duration: duration || 0,
            notes: notes || "",
        });

        // Update last page read
        paper.metadata.lastPageRead = pageNumber;

        await paper.save();

        // Log activity
        await logActivity(req.user.id, "viewed_paper", paperId, null, {
            pageNumber,
        });

        res.json({
            message: "Reading session saved",
            lastPageRead: pageNumber,
            sessionCount: paper.metadata.readingSessions.length,
        });
    } catch (error) {
        res.status(500).json({
            message: "Error saving reading session",
            error: error.message,
        });
    }
};

// Get trending papers from user's library
export const getTrendingPapers = async (req, res) => {
    try {
        // Get papers that have been accessed frequently in the last month
        const oneMonthAgo = new Date();
        oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
        oneMonthAgo.setHours(0, 0, 0, 0); // Include full day

        // First get activity counts for papers
        const paperActivity = await Activity.aggregate([
            {
                $match: {
                    user: req.user.id,
                    paper: { $exists: true, $ne: null },
                    createdAt: { $gte: oneMonthAgo },
                },
            },
            {
                $group: {
                    _id: "$paper",
                    viewCount: { $sum: 1 },
                },
            },
            { $sort: { viewCount: -1 } },
            { $limit: 10 },
        ]);

        if (!paperActivity || paperActivity.length === 0) {
            return res.json([]);
        }

        // Get paper details
        const paperIds = paperActivity.map((p) => p._id);
        const papers = await Paper.find(
            { _id: { $in: paperIds }, user: req.user.id },
            "title authors abstract keywords"
        );

        // Combine activity data with paper details
        const trending = paperActivity
            .map((activity) => {
                const paper = papers.find(
                    (p) => p._id.toString() === activity._id.toString()
                );
                return {
                    paper,
                    viewCount: activity.viewCount,
                };
            })
            .filter((item) => item.paper); // Remove any items where paper wasn't found

        res.json(trending);
    } catch (error) {
        res.status(500).json({
            message: "Error fetching trending papers",
            error: error.message,
        });
    }
};
