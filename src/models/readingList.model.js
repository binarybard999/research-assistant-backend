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
        papers: [{ type: mongoose.Schema.Types.ObjectId, ref: "Paper" }],
        isPublic: { type: Boolean, default: false },
        tags: [String],
        collaborators: [
            {
                user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
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

// Create index for faster querying
ReadingListSchema.index({ user: 1, name: 1 });
ReadingListSchema.index({ isPublic: 1 });

export default mongoose.model("ReadingList", ReadingListSchema);
