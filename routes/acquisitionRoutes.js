import crypto from "node:crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { param } from "express-validator";
import { protect, authorize } from "../middleware/auth.js";
import { validate } from "../validators/authValidators.js";
import { createSource, eraseInterest, getConfig, interests, interestStatus, publicOptions, recordVisit, report, requestInterest, saveConfig, sources, updateSource, withdrawChoice } from "../controllers/acquisitionController.js";
const r = Router(), salt = crypto.randomBytes(32), ids = (...names) => [...names.map((name) => param(name).isMongoId()), validate];
// Process-local salted keys expire with the limiter's window and are never
// persisted. No raw IP, browser fingerprint or referrer enters our records.
const anonymousKey = (req) => crypto.createHash("sha256").update(salt).update(req.ip || "unknown").digest("hex");
const limit = (max, keyGenerator) => rateLimit({ windowMs: 3600000, max, keyGenerator, standardHeaders: true, legacyHeaders: false, message: { message: "Too many requests. Please try again later." } });
const visitLimit = limit(30, anonymousKey), interestLimit = limit(5, anonymousKey), writes = limit(60, (req) => String(req.user._id));
const owner = [protect, authorize("instructor", "admin")];
r.get("/public/courses/:courseId/acquisition", ...ids("courseId"), publicOptions);
r.post("/public/courses/:courseId/visits", visitLimit, ...ids("courseId"), recordVisit);
r.post("/public/courses/:courseId/interest", interestLimit, ...ids("courseId"), requestInterest);
r.delete("/courses/:courseId/acquisition/choice", protect, authorize("student"), writes, ...ids("courseId"), withdrawChoice);
r.get("/courses/:courseId/acquisition/config", ...owner, ...ids("courseId"), getConfig);
r.put("/courses/:courseId/acquisition/config", ...owner, writes, ...ids("courseId"), saveConfig);
r.get("/courses/:courseId/acquisition/sources", ...owner, ...ids("courseId"), sources);
r.post("/courses/:courseId/acquisition/sources", ...owner, writes, ...ids("courseId"), createSource);
r.put("/courses/:courseId/acquisition/sources/:id", ...owner, writes, ...ids("courseId", "id"), updateSource);
r.get("/courses/:courseId/acquisition/report", ...owner, ...ids("courseId"), report);
r.get("/courses/:courseId/acquisition/interest", ...owner, ...ids("courseId"), interests);
r.put("/courses/:courseId/acquisition/interest/:id", ...owner, writes, ...ids("courseId", "id"), interestStatus);
r.delete("/courses/:courseId/acquisition/interest/:id", ...owner, writes, ...ids("courseId", "id"), eraseInterest);
export default r;
