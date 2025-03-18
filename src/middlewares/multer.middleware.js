import multer from "multer";
import path from "path";

// Configure Multer to use diskStorage and save files to "./public/temp"
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // Ensure the destination folder exists
        cb(null, "./public/temp");
    },
    filename: (req, file, cb) => {
        // Create a unique filename with the original extension (default to .pdf if missing)
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        const ext = path.extname(file.originalname) || ".pdf";
        cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
    },
});

// Create the Multer middleware instance
const uploadMiddleware = multer({ storage });

export default uploadMiddleware;
