import multer from "multer";
import ApiError from "../utils/ApiError.js";
const imageTypes = ["image/jpeg", "image/png", "image/webp"];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0, parts: 1 }, fileFilter: (req, file, callback) => callback(imageTypes.includes(file.mimetype) ? null : new ApiError(400, "Thumbnail must be a JPEG, PNG, or WebP image"), imageTypes.includes(file.mimetype)) }).single("thumbnail");
let active = 0;
export const uploadThumbnail = (req, res, next) => {
  if (active >= 2) return next(new ApiError(503, "Image uploads are busy. Please retry shortly."));
  active++;
  let released = false;
  const release = () => { if (!released) { released = true; active--; } };
  req.releaseThumbnailUpload = release;
  // A disconnected client must not free a running decoder/storage slot.
  const releaseIfIdle = () => { if (!req.thumbnailProcessing) release(); };
  res.once("finish", releaseIfIdle); res.once("close", releaseIfIdle);
  upload(req, res, (error) => {
    if (error) release();
    next(error instanceof multer.MulterError ? new ApiError(error.code === "LIMIT_FILE_SIZE" ? 413 : 400, error.code === "LIMIT_FILE_SIZE" ? "Choose an image up to 5 MB." : "Upload one thumbnail image without extra fields.") : error);
  });
};
