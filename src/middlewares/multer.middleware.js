import multer from "multer";
import path from "path";
import fs from "fs/promises";

const fileFilter = (req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new ApiError(400, "Only PDF files are allowed"), false);
};

// Configure Multer to use diskStorage and save files to "./public/temp"
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const userDir = `./public/temp/${req.user?._id || "anonymous"}`;
        await fs.mkdir(userDir, { recursive: true });
        cb(null, userDir);
    },
    filename: (req, file, cb) => {
        // Create a unique filename with the original extension (default to .pdf if missing)
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        const ext = path.extname(file.originalname) || ".pdf";
        cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
    },
});

export const chatUpload = multer({
    storage,
    limits: { fileSize: 25 * 1024 * 1024 },
});

export const paperUpload = multer({
    storage,
    fileFilter,
    limits: { fileSize: 50 * 1024 * 1024 },
});
