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
            enum: ["user", "assistant", "system"],
            required: true,
        },
    },
    { timestamps: true }
);

export default mongoose.model("ChatMessage", ChatMessageSchema);
