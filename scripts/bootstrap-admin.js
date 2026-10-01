import "dotenv/config";
import mongoose from "mongoose";
import readline from "node:readline/promises";
import { Writable } from "node:stream";
import { bootstrapAdmin } from "../services/bootstrapAdmin.js";

if (process.argv.includes("--help")) {
  console.log("Run node scripts/bootstrap-admin.js from a trusted interactive terminal with MONGO_URI and MONGO_DB_NAME configured. Prompts for name, email and a hidden password. Creates the first admin only; never promotes or overwrites an existing account.");
  process.exit(0);
}
if (!process.stdin.isTTY || !process.stdout.isTTY || process.argv.length !== 2) {
  console.error("Use a trusted interactive terminal. Passwords in arguments, pipes and default credentials are not supported.");
  process.exit(1);
}
if (!process.env.MONGO_URI || !process.env.MONGO_DB_NAME) {
  console.error("Set MONGO_URI and an explicit MONGO_DB_NAME in your protected environment first.");
  process.exit(1);
}
let hidden = false;
const output = new Writable({ write(chunk, encoding, callback) { if (!hidden) process.stdout.write(chunk, encoding); callback(); } });
const prompt = readline.createInterface({ input: process.stdin, output, terminal: true });
prompt.on("SIGINT", () => { process.stdout.write("\nCancelled.\n"); process.exit(130); });
try {
  const name = await prompt.question("Admin name: ");
  const email = await prompt.question("Admin email: ");
  process.stdout.write("Admin password (16+ characters, hidden): "); hidden = true;
  const password = await prompt.question("");
  process.stdout.write("\nConfirm password (hidden): ");
  const confirmation = await prompt.question(""); hidden = false; process.stdout.write("\n");
  if (password !== confirmation) throw new Error("Passwords did not match. No account created.");
  const approval = await prompt.question(`Type the database name (${process.env.MONGO_DB_NAME}) to confirm this destination: `);
  if (approval !== process.env.MONGO_DB_NAME) throw new Error("Cancelled. No account created.");
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.MONGO_DB_NAME, serverSelectionTimeoutMS: 10000 });
  await bootstrapAdmin({ name, email, password });
  console.log("First administrator created. Sign in through the application's normal login page. No password is displayed or stored in logs.");
} catch (error) {
  console.error(error.statusCode ? error.message : "Bootstrap did not complete. Check connectivity and protected operator logs; inspect the account before retrying.");
  process.exitCode = 1;
} finally {
  hidden = false; prompt.close(); await mongoose.disconnect();
}
