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
        const { listId, paperIds } = req.body; // Accepts array of paper IDs

        const list = await ReadingList.findOne({
            _id: listId,
            user: req.user.id,
        });

        // Add all papers at once
        const newPapers = paperIds.filter(
            (paperId) => !list.papers.includes(paperId)
        );

        list.papers.push(...newPapers);
        await list.save();

        await logActivity(req.user.id, "added_to_reading_list", null);
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
        const { listId, paperId } = req.params;

        const list = await ReadingList.findOne({
            _id: listId,
            user: req.user.id,
        });
        if (!list)
            return res.status(404).json({ message: "Reading list not found" });

        list.papers = list.papers.filter((id) => id.toString() !== paperId);
        list.paperNotes = list.paperNotes.filter(
            (note) => note.paper.toString() !== paperId
        );

        await list.save();
        await logActivity(req.user.id, "removed_from_reading_list", paperId);
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
            user: req.user.id,
        });
        if (!list)
            return res.status(404).json({ message: "Reading list not found" });

        // Check if user is already a collaborator
        const existingCollaborator = list.collaborators.find(
            (c) => c.user.toString() === userId
        );
        if (existingCollaborator) {
            existingCollaborator.role = role;
        } else {
            list.collaborators.push({ user: userId, role });
        }

        await list.save();
        await logActivity(
            req.user.id,
            "added_collaborator_to_reading_list",
            null
        );
        res.json(list);
    } catch (error) {
        res.status(500).json({
            message: "Error adding collaborator",
            error: error.message,
        });
    }
};
