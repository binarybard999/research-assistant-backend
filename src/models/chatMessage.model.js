import mongoose from "mongoose";

const ChatMessageSchema = new mongoose.Schema(
    {
        paper: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Paper",
            required: true,
        },
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
        content: {
            type: String,
            required: true,
        },
        role: {
            type: String,
            enum: ["user", "assistant", "system", "tool"],
            required: true,
        },
        functionCall: {
            name: String,
            arguments: mongoose.Schema.Types.Mixed,
            response: mongoose.Schema.Types.Mixed,
        },
        metadata: {
            citationRefs: [String],
            chunkRefs: [String], // For tracking which chunks were used
        },
    },
    { timestamps: true }
);

export default mongoose.model("ChatMessage", ChatMessageSchema);
