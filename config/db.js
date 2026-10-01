import mongoose from "mongoose";
import dns from "node:dns";

// Some ISPs/routers block the DNS SRV lookups that mongodb+srv:// URIs
// need, causing "querySrv ECONNREFUSED" even though normal internet
// access works fine. Pointing Node at public DNS resolvers first fixes
// this without requiring any Windows network settings changes.
dns.setServers(["8.8.8.8", "1.1.1.1"]);

/**
 * Connects to MongoDB using the URI from environment variables.
 * Exits the process on failure so the app never runs against a dead DB.
 */
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGO_DB_NAME || "lms" });
    console.log(`MongoDB connected: ${conn.connection.host}`);

    mongoose.connection.on("error", (err) => {
      console.error(`MongoDB connection error: ${err.message}`);
    });

    mongoose.connection.on("disconnected", () => {
      console.warn("MongoDB disconnected");
    });
  } catch (error) {
    console.error(`Failed to connect to MongoDB: ${error.message}`);
    process.exit(1);
  }
};

export default connectDB;