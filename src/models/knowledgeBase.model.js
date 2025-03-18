import mongoose from "mongoose";

const KnowledgeBaseSchema = new mongoose.Schema(
    {
        paper: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Paper",
            required: true,
        },
        aggregatedSummary: { type: String },
        aggregatedKeywords: { type: [String] },
        aggregatedExplanations: { type: String },
    },
    { timestamps: true }
);

export default mongoose.model("KnowledgeBase", KnowledgeBaseSchema);
