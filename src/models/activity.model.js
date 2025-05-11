import mongoose from "mongoose";

const ActivitySchema = new mongoose.Schema(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true
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
                "edited_paper_tags",
                "shared_paper",

                // Reading list actions
                "created_reading_list",
                "updated_reading_list",
                "deleted_reading_list",
                "added_to_reading_list",
                "removed_from_reading_list",
                "added_collaborator_to_reading_list",
                "removed_collaborator_from_reading_list",
                "bulk_added_to_reading_list",
                "bulk_removed_from_reading_list",

                // Knowledge base actions
                "summarized_paper",
                "generated_keywords",
                "created_hierarchical_summary",
                "updated_paper_summary",

                // Chat actions
                "started_chat",
                "exported_chat",
                "saved_chat_discussion",

                // Export actions
                "exported_bundle",
                "exported_citations",
                "exported_reading_list",

                // User actions
                "updated_profile",
                "upgraded_subscription",
                "changed_preferences",
            ],
        },
        paper: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Paper",
        },
        readingList: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "ReadingList",
        },        details: {
            type: mongoose.Schema.Types.Mixed,
            default: {},
            // Define common fields for better querying
            validate: {
                validator: function(details) {
                    if (!details) return true;
                    
                    switch(this.action) {
                        case 'added_to_reading_list':
                        case 'removed_from_reading_list':
                        case 'bulk_added_to_reading_list':
                        case 'bulk_removed_from_reading_list':
                            return details.listName && (details.addedPapers || details.removedPapers);
                        default:
                            return true;
                    }
                },
                message: 'Invalid details for activity type'
            }
        },
        importance: {
            type: String,
            enum: ["low", "medium", "high"],
            default: "medium",
        },
        actionCategory: {
            type: String,
            enum: ["paper", "reading_list", "knowledge_base", "chat", "export", "user"],
            required: true,
            default: function() {
                if (this.action.includes('paper')) return 'paper';
                if (this.action.includes('reading_list')) return 'reading_list';
                if (this.action.includes('chat')) return 'chat';
                if (this.action.includes('export')) return 'export';
                if (this.action.includes('user')) return 'user';
                return 'knowledge_base';
            },
            index: true
        }
    },
    { 
        timestamps: true,
        // Add virtuals to the JSON output
        toJSON: { virtuals: true },
        toObject: { virtuals: true }
    }
);

// Add indexes for better performance
ActivitySchema.index({ user: 1, createdAt: -1 });
ActivitySchema.index({ paper: 1 });
ActivitySchema.index({ action: 1 });

export default mongoose.model("Activity", ActivitySchema);
