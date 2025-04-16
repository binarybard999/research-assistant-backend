import mongoose from "mongoose";

const ChunkSchema = new mongoose.Schema({
    text: String,
    summary: String,
    keywords: [String],
    startPage: Number,
    endPage: Number,
    embeddings: [Number], // For semantic search
});

const HierarchicalSectionSchema = new mongoose.Schema({
    title: String,
    summary: String,
});

const KnowledgeBaseSchema = new mongoose.Schema(
    {
        paper: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Paper",
            // required: true,
        },
        aggregatedSummary: String,
        aggregatedKeywords: [String],
        aggregatedExplanations: String,
        chunks: [ChunkSchema],
        hierarchicalSummary: {
            overview: String,
            sections: [HierarchicalSectionSchema],
        },
    },
    { timestamps: true }
);

export default mongoose.model("KnowledgeBase", KnowledgeBaseSchema);
