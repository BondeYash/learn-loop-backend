import multer from "multer";
import ApiError from "../utils/ApiError.js";
import { MAX_PDF_BYTES } from "../services/pdfValidation.js";

let active = 0;
export function limitNoteUploads(req, res, next) {
  if (active >= 2) return next(new ApiError(429, "Two PDF uploads are already in progress. Please retry shortly."));
  active++;
  let released = false;
  const release = () => { if (!released) { released = true; active--; } };
  res.once("finish", release); res.once("close", release);
  next();
}
const parse = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PDF_BYTES, files: 1, fields: 1, fieldSize: 100, parts: 2 }, fileFilter: (req, file, callback) => {
  const valid = /\.pdf$/i.test(file.originalname) && ["application/pdf", "application/octet-stream"].includes(file.mimetype);
  callback(valid ? null : new ApiError(400, "Choose a PDF file up to 10 MB."), valid);
} }).single("file");
export function parseNoteUpload(req, res, next) {
  parse(req, res, (error) => next(error instanceof multer.MulterError ? new ApiError(error.code === "LIMIT_FILE_SIZE" ? 413 : 400, "Upload one PDF up to 10 MB at a time.") : error));
}
