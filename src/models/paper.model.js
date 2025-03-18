import mongoose from "mongoose";

const PaperSchema = new mongoose.Schema(
    {
        title: {
            type: String,
            required: true,
        },
        authors: {
            type: String,
        },
        abstract: {
            type: String,
        },
        content: {
            type: String,
        },
        summary: {
            type: String,
        },
        keywords: {
            type: [String],
        },
        citations: {
            type: [String],
        },
        annotations: {
            type: [String],
        },
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
        },
    },
    { timestamps: true }
);

export default mongoose.model("Paper", PaperSchema);
