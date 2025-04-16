import { RateLimiterMemory } from "rate-limiter-flexible";

const uploadLimiter = new RateLimiterMemory({
    points: 10, // Increased from 5
    duration: 60 * 60, // 1 hour
    blockDuration: 60 * 15, // Block for 15 minutes after limit
});

export const checkUploadLimit = async (req, res, next) => {
    try {
        await uploadLimiter.consume(req.user.id);
        next();
    } catch (err) {
        res.status(429).json({
            message: "Too many uploads. Please try again later.",
        });
    }
};

export const checkChatUploadLimit = async (req, res, next) => {
    try {
        await uploadLimiter.consume(`chat-${req.user.id}`);
        next();
    } catch (err) {
        res.status(429).json({
            message: "Too many chat uploads. Please try again later.",
        });
    }
};
