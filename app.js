import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import mongoSanitize from "express-mongo-sanitize";
import xss from "xss-clean";
import { apiLimiter, authLimiter } from "./middleware/requestLimits.js";
import { resolveSession } from "./middleware/auth.js";

import { errorHandler, notFound } from "./middleware/errorHandler.js";
import videoRoutes from "./routes/videoRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import courseRoutes from "./routes/courseRoutes.js";
import categoryRoutes from "./routes/categoryRoutes.js";
import learningRoutes from "./routes/learningRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import { auditAdminMutations } from "./middleware/adminAudit.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import { stripeWebhook } from "./controllers/paymentController.js";

const app = express();
const clientOrigin = process.env.CLIENT_URL || "http://localhost:5173";
const allowedOrigins = new Set([clientOrigin]);
if (process.env.NODE_ENV !== "production") {
  const local = new URL(clientOrigin);
  if (["localhost", "127.0.0.1"].includes(local.hostname)) {
    local.hostname = local.hostname === "localhost" ? "127.0.0.1" : "localhost";
    allowedOrigins.add(local.origin);
  }
}

// ---- Security middleware ----
app.use(helmet());
app.use(
  cors({
    origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)),
    credentials: true,
  })
);


// ---- Rate limiting ----
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "private, no-store");
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && ((req.headers.origin && !allowedOrigins.has(req.headers.origin)) || req.headers["sec-fetch-site"] === "cross-site")) return res.status(403).json({ success: false, message: "Request origin is not allowed" });
  next();
});
// Exact endpoint only: Stripe signs the untouched bytes. This runs before JSON,
// cookie/session parsing and sanitizers, and authenticates with Stripe's signature.
app.post("/api/payments/webhook", express.raw({ type: "application/json", limit: "256kb" }), stripeWebhook);
// ---- Body parsing & logging ----
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());
app.use("/api", resolveSession);
app.use("/api", apiLimiter);
app.use("/api/auth", authLimiter);
app.use(mongoSanitize());
app.use(xss());
if (process.env.NODE_ENV === "development") {
  app.use(morgan("dev"));
}

// ---- Health check ----
app.get("/api/health", (req, res) => {
  res.status(200).json({ success: true, message: "LMS API is running", data: { timestamp: new Date().toISOString() } });
});

// ---- API routes ----
app.use("/api", auditAdminMutations);
app.use("/api/admin", adminRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api", videoRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/courses", courseRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api", learningRoutes);

// ---- 404 + centralized error handling ----
app.use(notFound);
app.use(errorHandler);

export default app;
