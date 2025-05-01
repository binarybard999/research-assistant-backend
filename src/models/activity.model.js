import mongoose from "mongoose";

const ActivitySchema = new mongoose.Schema(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
        action: {
            type: String,
            required: true,
            enum: [
                // Paper-related actions
                "uploaded_paper",
                "deleted_paper",
                "edited_paper_metadata",
                "viewed_paper",
                "favorited_paper",
                "unfavorited_paper",
                "added_annotation",
                "removed_annotation",

                // Reading list actions
                "created_reading_list",
                "updated_reading_list",
                "deleted_reading_list",
                "added_to_reading_list",
                "removed_from_reading_list",
                "added_collaborator_to_reading_list",

                // Knowledge base actions
                "summarized_paper",
                "generated_keywords",
                "created_hierarchical_summary",

                // Chat actions
                "started_chat",
                "exported_chat",

                // Export actions
                "exported_bundle",

                // User actions
                "updated_profile",
                "upgraded_subscription",
            ],
        },
        paper: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Paper",
        },
        readingList: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "ReadingList",
        },
        details: {
            type: mongoose.Schema.Types.Mixed,
            default: {},
        },
        importance: {
            type: String,
            enum: ["low", "medium", "high"],
            default: "medium",
        },
    },
    { timestamps: true }
);

// Add indexes for better performance
ActivitySchema.index({ user: 1, createdAt: -1 });
ActivitySchema.index({ paper: 1 });
ActivitySchema.index({ action: 1 });

export default mongoose.model("Activity", ActivitySchema);
