import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import morgan from "morgan"; // For logging requests
import rateLimit from "express-rate-limit"; // Rate limiting

const app = express();

// Configure Rate Limiting
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    message:
        "Too many requests from this IP, please try again after 15 minutes",
});

// Apply rate limiting to all requests
app.use(apiLimiter);

const authLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour window
    max: 5, // start blocking after 5 requests
    message: "Too many login attempts, please try again after an hour",
});

// Middleware
app.use(
    cors({
        origin: process.env.CORS_ORIGIN || "http://localhost:5173",
        credentials: true,
        optionsSuccessStatus: 200,
        methods: ["GET", "POST", "PUT", "DELETE"],
        allowedHeaders: ["Content-Type", "Authorization"],
    })
);

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "16kb" }));
app.use(express.static("public"));
app.use(cookieParser());
app.use(morgan("dev")); // Logs HTTP requests

// Routes Import
import paperRouter from "./routes/paper.routes.js";
import knowledgeBaseRouter from "./routes/knowledgeBase.routes.js";
import userRouter from "./routes/user.routes.js";
import paperChatRoutes from "./routes/paperChat.routes.js";

// Routes Middleware
// Auth limiter to login routes if needed
// app.use("/api/v1/users/login", authLimiter);
app.use("/api/v1/users", userRouter);
app.use("/api/v1/papers", paperRouter);
app.use("/api/v1/knowledge-base", knowledgeBaseRouter);
app.use("/api/v1/paper-chat", paperChatRoutes);

// Root route
app.get("/", (req, res) => {
    res.send("Research Paper Knowledge Assistant API is running");
});

// Error Handling Middleware
app.use((err, req, res, next) => {
    console.error("Error:", err.message);
    res.status(err.statusCode || 500).json({
        success: false,
        message: err.message || "Internal Server Error",
    });
});

export default app;
