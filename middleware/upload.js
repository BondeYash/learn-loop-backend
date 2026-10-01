import multer from "multer";
import ApiError from "../utils/ApiError.js";
const imageTypes = ["image/jpeg", "image/png", "image/webp"];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (req, file, callback) => callback(imageTypes.includes(file.mimetype) ? null : new ApiError(400, "Thumbnail must be a JPEG, PNG, or WebP image"), imageTypes.includes(file.mimetype)) });
export const uploadThumbnail = upload.single("thumbnail");
