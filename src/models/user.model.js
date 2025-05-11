import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

const UserSchema = new mongoose.Schema(
    {
        name: { type: String, required: true },
        email: { type: String, required: true, unique: true },
        password: { type: String, required: true },
        refreshToken: { type: String },
        profilePicture: {
            type: String,
            default: function () {
                const encodedName = encodeURIComponent(this.name || "User");
                return `https://ui-avatars.com/api/?name=${encodedName}&background=0D8ABC&color=fff&bold=true&size=128`;
            },
        },

        bio: { type: String, maxLength: 500 },
        institution: { type: String },
        title: { type: String },
        socialLinks: {
            googleScholar: { type: String },
            researchGate: { type: String },
            orcid: { type: String },
            twitter: { type: String },
            linkedin: { type: String },
        },
        researchInterests: [{ type: String }],
        tier: {
            type: String,
            enum: ["free", "pro", "enterprise"],
            default: "free",
        },
        uploadLimits: {
            concurrentPapers: { type: Number, default: 3 },
            monthlyUploads: { type: Number, default: 10 },
        },
        usage: {
            currentMonthUploads: { type: Number, default: 0 },
            totalChats: { type: Number, default: 0 },
        },
        settings: {
            theme: {
                type: String,
                enum: ["light", "dark", "system"],
                default: "system",
            },
            emailNotifications: {
                paperUploads: { type: Boolean, default: true },
                recommendations: { type: Boolean, default: true },
                paperSummaries: { type: Boolean, default: true },
            },
            defaultChatOptions: {
                includeContext: { type: Boolean, default: true },
                followupQuestions: { type: Boolean, default: true },
            },
            displayPreferences: {
                papersPerPage: { type: Number, default: 10 },
                listView: { type: Boolean, default: false }, // false = grid view
            },
        },
    },
    { timestamps: true }
);

// Hash password before saving
UserSchema.pre("save", async function (next) {
    if (!this.isModified("password")) return next();
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
});

// Method to check if password is correct
UserSchema.methods.isPasswordCorrect = async function (password) {
    return await bcrypt.compare(password, this.password);
};

// Method to generate access token
UserSchema.methods.generateAccessToken = function () {
    return jwt.sign(
        {
            user: {
                id: this._id,
                email: this.email,
                name: this.name,
            },
        },
        process.env.JWT_SECRET,
        { expiresIn: process.env.ACCESS_TOKEN_EXPIRY || "15m" }
    );
};

// Method to generate refresh token
UserSchema.methods.generateRefreshToken = function () {
    return jwt.sign(
        { user: { id: this._id } },
        process.env.REFRESH_TOKEN_SECRET,
        { expiresIn: process.env.REFRESH_TOKEN_EXPIRY || "7d" }
    );
};

export default mongoose.model("User", UserSchema);
