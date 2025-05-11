import Activity from "../models/activity.model.js";
import User from "../models/user.model.js";
import Paper from "../models/paper.model.js";
import ReadingList from "../models/readingList.model.js";

// Log an activity
export const logActivity = async (
    userId,
    action,
    paperId = null,
    readingListId = null,
    details = {},
    importance = "medium"
) => {
    try {
        if (!userId || !action) {
            console.error("Invalid activity log attempt");
            return;
        }

        // Prepare activity data
        const activityData = {
            user: userId,
            action,
            details: {
                ...details,
                timestamp: new Date().toISOString()
            },
            importance,
            createdAt: new Date()
        };

        // Add references if provided
        if (paperId) activityData.paper = paperId;
        if (readingListId) activityData.readingList = readingListId;

        // Create activity with metadata
        const activity = await Activity.create(activityData);

        // Update related documents
        if (action === "uploaded_paper") {
            await User.findByIdAndUpdate(userId, {
                $inc: { "usage.currentMonthUploads": 1 },
                $set: { "lastActivity.uploadPaper": new Date() }
            });
        } else if (action === "started_chat") {
            await User.findByIdAndUpdate(userId, {
                $inc: { "usage.totalChats": 1 },
                $set: { "lastActivity.chat": new Date() }
            });
        } else if (action.includes("reading_list")) {
            // Update reading list last activity
            if (readingListId) {
                await ReadingList.findByIdAndUpdate(readingListId, {
                    $set: { lastActivity: new Date() }
                });
            }
        }
    } catch (error) {
        console.error("Error logging activity:", error);
    }
};

// Get user's activity feed
export const getActivity = async (req, res) => {
    try {
        const { 
            limit = 50, 
            skip = 0, 
            paper, 
            action, 
            importance,
            startDate,
            endDate,
            type 
        } = req.query;

        // Build query based on filters
        const query = { user: req.user.id };

        // Basic filters
        if (paper) query.paper = paper;
        if (action) query.action = action;
        if (importance) query.importance = importance;

        // Date range filter
        if (startDate || endDate) {
            query.createdAt = {};
            if (startDate) query.createdAt.$gte = new Date(startDate);
            if (endDate) query.createdAt.$lte = new Date(endDate);
        }

        // Activity type filter
        if (type) {
            if (type === 'reading_list') {
                query.action = { $regex: /reading_list$/ };
            } else if (type === 'paper') {
                query.action = { $regex: /paper$/ };
            }
        }

        const feed = await Activity.find(query)
            .sort({ createdAt: -1 })
            .skip(parseInt(skip))
            .limit(parseInt(limit))
            .populate({
                path: "paper",
                select: "title authors metadata",
                match: { user: req.user.id }
            })
            .populate({
                path: "readingList",
                select: "name isPublic papers",
                match: { 
                    $or: [
                        { user: req.user.id },
                        { isPublic: true },
                        { "collaborators.user": req.user.id }
                    ]
                }
            })
            .lean();

        // Get total count for pagination
        const total = await Activity.countDocuments(query);

        res.json({
            activities: feed,
            total,
            limit: parseInt(limit),
            skip: parseInt(skip),
        });
    } catch (error) {
        res.status(500).json({
            message: "Error fetching activity feed",
            error: error.message,
        });
    }
};

// Clear user's activity history
export const clearActivity = async (req, res) => {
    try {
        await Activity.deleteMany({ user: req.user.id });
        res.json({ message: "Activity history cleared" });
    } catch (error) {
        res.status(500).json({
            message: "Error clearing activity history",
            error: error.message,
        });
    }
};

// Get activity statistics
export const getActivityStats = async (req, res) => {
    try {
        const { startDate, endDate } = req.query;

        const query = { user: req.user.id };

        // Add date filters if provided
        if (startDate && endDate) {
            query.createdAt = {
                $gte: new Date(startDate),
                $lte: new Date(endDate),
            };
        }

        // Group activities by action and count
        const stats = await Activity.aggregate([
            { $match: query },
            {
                $group: {
                    _id: "$action",
                    count: { $sum: 1 },
                },
            },
            { $sort: { count: -1 } },
        ]);

        // Get most active papers
        const paperStats = await Activity.aggregate([
            { $match: { ...query, paper: { $exists: true, $ne: null } } },
            {
                $group: {
                    _id: "$paper",
                    count: { $sum: 1 },
                },
            },
            { $sort: { count: -1 } },
            { $limit: 5 },
        ]);

        // Populate paper details
        const paperIds = paperStats.map((stat) => stat._id);
        const papers = await Paper.find(
            { _id: { $in: paperIds } },
            "title authors"
        );

        const enrichedPaperStats = paperStats.map((stat) => {
            const paper = papers.find(
                (p) => p._id.toString() === stat._id.toString()
            );
            return {
                paper,
                count: stat.count,
            };
        });

        res.json({
            actionStats: stats,
            paperStats: enrichedPaperStats,
        });
    } catch (error) {
        res.status(500).json({
            message: "Error fetching activity statistics",
            error: error.message,
        });
    }
};
