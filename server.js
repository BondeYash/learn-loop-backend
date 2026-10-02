import "dotenv/config";

import app from "./app.js";
import connectDB from "./config/db.js";

import { checkObjectStore } from "./services/videoObjectStore.js";
import mongoose from "mongoose";
import Category from "./models/Category.js";
import CourseNote from "./models/CourseNote.js";
import { paymentOrderModel } from "./models/PaymentOrder.js";
import { stripeEventModel } from "./models/StripeEvent.js";
import { validateStripeStartup } from "./services/stripeClient.js";

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  validateStripeStartup();
  await connectDB();
  await checkObjectStore();
  await CourseNote.init();
  await Promise.all([paymentOrderModel().init(), stripeEventModel().init()]);
  await Category.updateOne({ slug: "general" }, { $setOnInsert: { name: "General", slug: "general" } }, { upsert: true });
  let stopWorker = () => {};
  if (process.env.ENABLE_LEGACY_VIDEO_WORKER === "true") {
    const { checkVideoTools, startVideoWorker } = await import("./services/videoWorker.js");
    await checkVideoTools();
    stopWorker = startVideoWorker();
  }

  const server = app.listen(PORT, () => {
    console.log(`LMS server running in ${process.env.NODE_ENV || "development"} mode on port ${PORT}`);
  });

  const shutdown = () => { stopWorker(); server.close(async () => { await mongoose.disconnect(); process.exit(0); }); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Handle unhandled promise rejections gracefully instead of a hard crash
  process.on("unhandledRejection", (err) => {
    console.error(`Unhandled Rejection: ${err.message}`);
    server.close(() => process.exit(1));
  });
};

startServer().catch((error) => { console.error("Startup failed:", error.message); process.exit(1); });
