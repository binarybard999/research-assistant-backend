import dotenv from "dotenv";
import connectDB from "./config/db.js";
import app from "./app.js";

dotenv.config({
    path: ".env",
});

// Start Server
const startServer = async () => {
    try {
        await connectDB(); // Connect to MongoDB

        const port = process.env.PORT || 8000;
        app.listen(port, () => {
            console.log(`Server running on port ${port}`);
        });
    } catch (error) {
        console.error("Server startup error:", error);
        process.exit(1);
    }
};

startServer();
