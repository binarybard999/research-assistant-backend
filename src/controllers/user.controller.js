import User from "../models/user.model.js";
import asyncHandler from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import jwt from "jsonwebtoken";

const generateTokensAndSetCookies = async (user, res) => {
    try {
        const accessToken = user.generateAccessToken();
        const refreshToken = user.generateRefreshToken();

        // Save refresh token in DB
        user.refreshToken = refreshToken;
        await user.save({ validateBeforeSave: false });

        // Set cookie options
        const options = {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
        };

        // Set cookies
        res.cookie("accessToken", accessToken, options).cookie(
            "refreshToken",
            refreshToken,
            options
        );

        return { accessToken, refreshToken };
    } catch (error) {
        throw new ApiError(500, "Something went wrong while generating tokens");
    }
};

export const register = asyncHandler(async (req, res, next) => {
    const { name, email, password } = req.body;

    // Validation
    if (!name || !email || !password) {
        throw new ApiError(400, "All fields are required");
    }

    // Check if user exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
        throw new ApiError(409, "User with this email already exists");
    }

    // Create user
    const user = await User.create({
        name,
        email,
        password,
    });

    // Remove password from response
    const createdUser = await User.findById(user._id).select(
        "-password -refreshToken"
    );
    if (!createdUser) {
        throw new ApiError(500, "Something went wrong while registering user");
    }

    // Generate tokens and set cookies
    // const { accessToken, refreshToken } = await generateTokensAndSetCookies(
    //     user,
    //     res
    // );
    const accessToken = user.generateAccessToken();

    const options = {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
    };

    res.cookie("accessToken", accessToken, options);

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                { accessToken },
                "Access token refreshed successfully"
            )
        );

    // Return response
    return res.status(201).json(
        new ApiResponse(
            201,
            {
                user: createdUser,
                accessToken,
                refreshToken,
            },
            "User registered successfully"
        )
    );
});

export const login = asyncHandler(async (req, res, next) => {
    const { email, password } = req.body;

    // Validation
    if (!email || !password) {
        throw new ApiError(400, "Email and password are required");
    }

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
        throw new ApiError(404, "User does not exist");
    }

    // Check password
    const isPasswordValid = await user.isPasswordCorrect(password);
    if (!isPasswordValid) {
        throw new ApiError(401, "Invalid credentials");
    }

    // Generate tokens and set cookies
    const { accessToken, refreshToken } = await generateTokensAndSetCookies(
        user,
        res
    );

    // Get user data without sensitive fields
    const loggedInUser = await User.findById(user._id).select(
        "-password -refreshToken"
    );

    // Return response
    return res.status(200).json(
        new ApiResponse(
            200,
            {
                user: loggedInUser,
                accessToken,
                refreshToken,
            },
            "User logged in successfully"
        )
    );
});

export const logout = asyncHandler(async (req, res) => {
    // Clear refresh token in database
    await User.findByIdAndUpdate(
        req.user._id,
        {
            $unset: { refreshToken: 1 },
        },
        { new: true }
    );

    // Clear cookies
    const options = {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
    };

    // Return response
    return res
        .clearCookie("accessToken", options)
        .clearCookie("refreshToken", options)
        .status(200)
        .json(new ApiResponse(200, {}, "User logged out successfully"));
});

export const refreshAccessToken = asyncHandler(async (req, res) => {
    const incomingRefreshToken =
        req.cookies?.refreshToken || req.body.refreshToken;

    if (!incomingRefreshToken) {
        throw new ApiError(401, "Unauthorized request");
    }

    try {
        // Verify token
        const decodedToken = jwt.verify(
            incomingRefreshToken,
            process.env.REFRESH_TOKEN_SECRET
        );

        // Find user
        const user = await User.findById(decodedToken.user.id);
        if (!user) {
            throw new ApiError(401, "Invalid refresh token");
        }

        // Check if refresh token matches
        if (incomingRefreshToken !== user.refreshToken) {
            throw new ApiError(401, "Refresh token is expired or used");
        }

        // Generate tokens and set cookies
        const { accessToken, refreshToken } = await generateTokensAndSetCookies(
            user,
            res
        );

        // Return response
        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    { accessToken, refreshToken },
                    "Access token refreshed successfully"
                )
            );
    } catch (error) {
        throw new ApiError(401, error?.message || "Invalid refresh token");
    }
});

export const getCurrentUser = asyncHandler(async (req, res) => {
    return res
        .status(200)
        .json(
            new ApiResponse(200, req.user, "Current user fetched successfully")
        );
});

// Send reset email (OTP or link)
export const forgotPassword = asyncHandler(async (req, res) => {
    const { email } = req.body;
    if (!email) throw new ApiError(400, "Email is required");

    const user = await User.findOne({ email });
    if (!user) throw new ApiError(404, "No user found with this email");

    // Generate reset token (or OTP), save to DB with expiry
    // Email to user (skip actual email logic if not needed here)

    return res
        .status(200)
        .json(new ApiResponse(200, {}, "Password reset link sent to email"));
});

// Reset the password
export const resetPassword = asyncHandler(async (req, res) => {
    const { token, newPassword } = req.body;
    // Verify token and expiry, then update password
    // Invalidate previous refreshToken, optionally force logout
});

export const getSettings = asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id).select("settings");
    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                user.settings,
                "User settings retrieved successfully"
            )
        );
});

export const updateSettings = asyncHandler(async (req, res) => {
    const { settings } = req.body;

    if (!settings || typeof settings !== "object") {
        throw new ApiError(400, "Invalid settings object");
    }

    const user = await User.findById(req.user._id);

    // Deep merge existing settings with new settings
    const currentSettings = user.settings ? user.settings.toObject() : {};
    const emailNotifications = currentSettings.emailNotifications || {};
    const defaultChatOptions = currentSettings.defaultChatOptions || {};
    const displayPreferences = currentSettings.displayPreferences || {};

    user.settings = {
        ...currentSettings,
        ...settings,
        emailNotifications: {
            ...emailNotifications,
            ...(settings.emailNotifications || {}),
        },
        defaultChatOptions: {
            ...defaultChatOptions,
            ...(settings.defaultChatOptions || {}),
        },
        displayPreferences: {
            ...displayPreferences,
            ...(settings.displayPreferences || {}),
        },
    };

    await user.save({ validateBeforeSave: false });

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                user.settings,
                "User settings updated successfully"
            )
        );
});

export const updateProfile = asyncHandler(async (req, res) => {
    const {
        name,
        bio,
        institution,
        title,
        socialLinks,
        researchInterests,
        profilePicture,
    } = req.body;

    const updateFields = {};
    if (name) updateFields.name = name;
    if (bio) updateFields.bio = bio;
    if (institution) updateFields.institution = institution;
    if (title) updateFields.title = title;
    if (socialLinks) updateFields.socialLinks = socialLinks;
    if (researchInterests) updateFields.researchInterests = researchInterests;
    if (profilePicture) updateFields.profilePicture = profilePicture;

    const user = await User.findByIdAndUpdate(
        req.user._id,
        { $set: updateFields },
        { new: true }
    ).select("-password -refreshToken");

    if (!user) {
        throw new ApiError(404, "User not found");
    }

    return res
        .status(200)
        .json(new ApiResponse(200, user, "Profile updated successfully"));
});
