import mongoose from "mongoose";

const ReadingListSchema = new mongoose.Schema(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true
        },
        name: { 
            type: String, 
            required: true,
            trim: true,
            maxLength: 100
        },
        description: { 
            type: String, 
            default: "",
            trim: true,
            maxLength: 500
        },
        papers: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: "Paper",
                validate: {
                    validator: async function (v) {
                        return await Paper.exists({ _id: v });
                    },
                    message: (props) => `Paper ${props.value} does not exist`,
                },
            },
        ],
        isPublic: { type: Boolean, default: false },
        tags: [{ 
            type: String,
            trim: true,
            maxLength: 50
        }],
        collaborators: [
            {
                user: {
                    type: mongoose.Schema.Types.ObjectId,
                    ref: "User",
                    validate: {
                        validator: async function (v) {
                            return await User.exists({ _id: v });
                        },
                        message: (props) => `User ${props.value} does not exist`,
                    },
                },
                role: {
                    type: String,
                    enum: ["viewer", "editor"],
                    default: "viewer",
                },
                addedAt: { 
                    type: Date, 
                    default: Date.now 
                }
            },
        ],
        // Added fields for better tracking
        paperCount: { 
            type: Number, 
            default: 0,
            min: 0
        },
        lastActivity: { 
            type: Date,
            default: Date.now
        },
        lastPaperAddedAt: {
            type: Date,
            default: Date.now
        },
        views: {
            type: Number,
            default: 0,
            min: 0
        },
        paperNotes: [
            {
                paper: { type: mongoose.Schema.Types.ObjectId, ref: "Paper" },
                note: String,
                addedAt: { type: Date, default: Date.now },
            },
        ],
    },
    { timestamps: true }
);

// Middleware to handle paper operations and maintain list integrity
ReadingListSchema.pre("save", function (next) {
    const currentDate = new Date();

    // Set updatedAt for the list
    this.updatedAt = currentDate;

    // Remove duplicate papers while preserving order
    const seen = new Set();
    this.papers = this.papers.filter(p => {
        const paperId = p.toString();
        return seen.has(paperId) ? false : seen.add(paperId);
    });

    // Remove duplicate collaborators
    const seenCollabs = new Set();
    this.collaborators = this.collaborators.filter((c) => {
        const key = c.user.toString();
        return seenCollabs.has(key) ? false : seenCollabs.add(key);
    });

    // Update metadata
    this.paperCount = this.papers.length;
    if (this.isModified('papers')) {
        this.lastPaperAddedAt = currentDate;
    }

    next();
});

// Create index for faster querying
ReadingListSchema.index({ user: 1, name: 1 });
ReadingListSchema.index({ isPublic: 1 });

export default mongoose.model("ReadingList", ReadingListSchema);
