import ReadingList from "../models/readingList.model.js";
import Paper from "../models/paper.model.js";
import { logActivity } from "./activity.controller.js";

// Get all user's reading lists
export const getLists = async (req, res) => {
    try {
        const lists = await ReadingList.find({ user: req.user.id })
            .populate({
                path: "papers",
                select: "title authors abstract",
                match: { user: req.user.id }, // Only user's papers
            })
            .sort({ updatedAt: -1 });
        res.json(lists);
    } catch (error) {
        res.status(500).json({
            message: "Error fetching reading lists",
            error: error.message,
        });
    }
};

// Create a new reading list
export const createList = async (req, res) => {
    try {
        const {
            name,
            description = "",
            isPublic = false,
            tags = [],
        } = req.body;

        const list = await ReadingList.create({
            user: req.user.id,
            name,
            description,
            isPublic,
            papers: [],
            tags,
        });

        await logActivity(req.user.id, "created_reading_list", null);
        res.status(201).json(list);
    } catch (error) {
        res.status(500).json({
            message: "Error creating reading list",
            error: error.message,
        });
    }
};

// Add paper to reading list
export const addToList = async (req, res) => {
    try {
        const { listId, paperIds } = req.body;

        // Validate input
        if (!Array.isArray(paperIds)) {
            return res
                .status(400)
                .json({ message: "paperIds must be an array" });
        }

        const list = await ReadingList.findOne({
            _id: listId,
            $or: [
                { user: req.user.id },
                {
                    "collaborators.user": req.user.id,
                    "collaborators.role": "editor",
                },
            ],
        }).populate("papers");

        if (!list) {
            return res.status(404).json({ message: "Reading list not found" });
        }

        // Check paper ownership and get paper details
        const papers = await Paper.find({
            _id: { $in: paperIds },
            user: req.user.id,
        });

        if (papers.length !== paperIds.length) {
            return res
                .status(403)
                .json({ message: "Unauthorized access to some papers" });
        }

        // Add only new papers
        const existingPapers = new Set(
            list.papers.map((p) => p._id.toString())
        );
        const newPapers = papers.filter(
            (paper) => !existingPapers.has(paper._id.toString())
        );

        if (newPapers.length > 0) {
            list.papers.push(...newPapers.map((p) => p._id));
            list.updatedAt = new Date();
            await list.save();

            // Log activity with paper details
            await logActivity(
                req.user.id,
                "added_to_reading_list",
                null,
                list._id,
                {
                    listName: list.name,
                    addedPapers: newPapers.map((p) => ({
                        id: p._id,
                        title: p.title,
                    })),
                    totalPapers: list.papers.length,
                }
            );
        }

        // Populate and return the updated list
        await list.populate("papers", "title authors abstract keywords");
        res.json(list);
    } catch (error) {
        res.status(500).json({
            message: "Error adding papers to reading list",
            error: error.message,
        });
    }
};

// Remove paper from reading list
export const removeFromList = async (req, res) => {
    try {
        const { listId } = req.params;
        const { paperIds } = req.body;

        // Validate input
        if (!Array.isArray(paperIds)) {
            return res
                .status(400)
                .json({ message: "paperIds must be an array" });
        }

        const list = await ReadingList.findOne({
            _id: listId,
            $or: [
                { user: req.user.id },
                {
                    "collaborators.user": req.user.id,
                    "collaborators.role": "editor",
                },
            ],
        }).populate("papers", "title");

        if (!list) {
            return res.status(404).json({ message: "Reading list not found" });
        }

        // Get paper details before removal for activity logging
        const papersToRemove = list.papers.filter((paper) =>
            paperIds.includes(paper._id.toString())
        );

        if (papersToRemove.length > 0) {
            // Remove papers and their notes
            list.papers = list.papers.filter(
                (paper) => !paperIds.includes(paper._id.toString())
            );
            list.paperNotes = list.paperNotes.filter(
                (note) => !paperIds.includes(note.paper.toString())
            );
            list.updatedAt = new Date();
            await list.save();

            // Log activity with details
            await logActivity(
                req.user.id,
                "removed_from_reading_list",
                null,
                list._id,
                {
                    listName: list.name,
                    removedPapers: papersToRemove.map((p) => ({
                        id: p._id,
                        title: p.title,
                    })),
                    remainingPapers: list.papers.length,
                }
            );
        }

        // Populate and return the updated list
        await list.populate("papers", "title authors abstract keywords");
        res.json(list);
    } catch (error) {
        res.status(500).json({
            message: "Error removing paper from reading list",
            error: error.message,
        });
    }
};

// Get public reading lists
export const getPublicLists = async (req, res) => {
    try {
        const publicLists = await ReadingList.find({ isPublic: true })
            .populate("user", "name")
            .populate("papers", "title authors abstract")
            .sort({ updatedAt: -1 })
            .limit(20);
        res.json(publicLists);
    } catch (error) {
        res.status(500).json({
            message: "Error fetching public reading lists",
            error: error.message,
        });
    }
};

// Update reading list details
export const updateList = async (req, res) => {
    try {
        const { id } = req.params;
        const { name, description, isPublic, tags } = req.body;

        const list = await ReadingList.findOneAndUpdate(
            { _id: id, user: req.user.id },
            { name, description, isPublic, tags },
            { new: true }
        );

        if (!list)
            return res.status(404).json({ message: "Reading list not found" });

        await logActivity(req.user.id, "updated_reading_list", null);
        res.json(list);
    } catch (error) {
        res.status(500).json({
            message: "Error updating reading list",
            error: error.message,
        });
    }
};

// Delete reading list
export const deleteList = async (req, res) => {
    try {
        const { id } = req.params;

        const list = await ReadingList.findOneAndDelete({
            _id: id,
            user: req.user.id,
        });
        if (!list)
            return res.status(404).json({ message: "Reading list not found" });

        await logActivity(req.user.id, "deleted_reading_list", null);
        res.json({ message: "Reading list deleted successfully" });
    } catch (error) {
        res.status(500).json({
            message: "Error deleting reading list",
            error: error.message,
        });
    }
};

// Add collaborator to reading list
export const addCollaborator = async (req, res) => {
    try {
        const { listId, userId, role = "viewer" } = req.body;

        const list = await ReadingList.findOne({
            _id: listId,
            user: req.user.id, // Only owner can add collaborators
        });

        // Validate user exists
        const userExists = await User.exists({ _id: userId });
        if (!userExists) {
            return res.status(404).json({ message: "User not found" });
        }

        // Prevent duplicate collaborators
        const existingIndex = list.collaborators.findIndex(
            (c) => c.user.toString() === userId
        );

        if (existingIndex > -1) {
            list.collaborators[existingIndex].role = role;
        } else {
            list.collaborators.push({ user: userId, role });
        }

        await list.save();
        res.json(await list.populate("collaborators.user", "name email"));
    } catch (error) {
        res.status(500).json({
            message: "Error adding collaborator",
            error: error.message,
        });
    }
};
