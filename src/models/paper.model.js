import mongoose from "mongoose";

const AnnotationSchema = new mongoose.Schema({
    content: String,
    page: Number,
    contextSnippet: String,
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

const CitationSchema = new mongoose.Schema({
    title: String,
    authors: [String],
    source: String,
    year: Number,
    doi: String,
});

const PaperSchema = new mongoose.Schema(
    {
        title: { type: String, required: true },
        authors: { type: String },
        abstract: { type: String },
        content: { type: String },
        summary: { type: String },
        keywords: [String],
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
        knowledgeBase: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "KnowledgeBase",
        },
        citations: [CitationSchema],
        annotations: [AnnotationSchema],
        metadata: {
            fileName: String,
            mimeType: String,
            sizeInKB: Number,
            isFavorite: { type: Boolean, default: false },
        },
    },
    { timestamps: true }
);

export default mongoose.model("Paper", PaperSchema);
