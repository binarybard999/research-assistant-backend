import mongoose from "mongoose";

const ReadingListSchema = new mongoose.Schema(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
        name: { type: String, required: true },
        description: { type: String, default: "" },
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
        tags: [String],
        collaborators: [
            {
                user: {
                    type: mongoose.Schema.Types.ObjectId,
                    ref: "User",
                    validate: {
                        validator: async function (v) {
                            return await User.exists({ _id: v });
                        },
                        message: (props) =>
                            `User ${props.value} does not exist`,
                    },
                },
                role: {
                    type: String,
                    enum: ["viewer", "editor"],
                    default: "viewer",
                },
            },
        ],
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

// Add pre-save hook for duplicate prevention
ReadingListSchema.pre("save", function (next) {
    // Remove duplicate papers
    this.papers = [...new Set(this.papers.map((p) => p.toString()))];

    // Remove duplicate collaborators
    const seen = new Set();
    this.collaborators = this.collaborators.filter((c) => {
        const key = c.user.toString();
        return seen.has(key) ? false : seen.add(key);
    });

    next();
});

// Create index for faster querying
ReadingListSchema.index({ user: 1, name: 1 });
ReadingListSchema.index({ isPublic: 1 });

export default mongoose.model("ReadingList", ReadingListSchema);
