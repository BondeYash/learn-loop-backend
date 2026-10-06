// Local browser fixture only: hard-coded loopback MongoDB, random disposable DB,
// synthetic users/content, no dotenv/provider startup or production routes.
import crypto from "node:crypto";
import readline from "node:readline";
import mongoose from "mongoose";
import app from "../app.js";
import User from "../models/User.js";
import Course from "../models/Course.js";
import Category from "../models/Category.js";
import Module from "../models/Module.js";
import Lesson from "../models/Lesson.js";
import Enrollment from "../models/Enrollment.js";
import Assessment from "../models/Assessment.js";
import AssessmentAttempt from "../models/AssessmentAttempt.js";
if (process.env.NODE_ENV !== "test" || process.env.CLIENT_URL !== "http://127.0.0.1:5186") throw new Error("This fixture requires the isolated local test environment.");
const port = Number(process.env.TEST_MONGO_PORT || 27018);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid local fixture port.");
await mongoose.connect(`mongodb://127.0.0.1:${port}/lms_mock_browser_${crypto.randomBytes(8).toString("hex")}`, { serverSelectionTimeoutMS: 5000 });
await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
const users = {};
for (const [name, role] of [["owner","instructor"],["student","student"],["second","student"],["other","instructor"],["admin","admin"]]) {
  const password = crypto.randomBytes(18).toString("hex"), email = `${name}@mock-fixture.invalid`;
  const user = await User.create({ name: `Synthetic ${name}`, email, password, role }); users[name] = { id: String(user._id), email, password };
}
const category = await Category.create({ name: "Synthetic mock course" });
const course = await Course.create({ title: "Synthetic instructor mock course", description: "Local fixture; no production questions or accounts", category: category._id, instructor: users.owner.id, isPublished: true, price: 0, visibility: "private" });
const otherCourse = await Course.create({ title: "Synthetic other owner course", description: "Foreign-course authorization fixture", category: category._id, instructor: users.other.id });
const chapter = await Module.create({ course: course._id, title: "Synthetic chapter", order: 0 });
await Lesson.create({ course: course._id, module: chapter._id, title: "Synthetic text lesson", contentType: "text", content: "Owned local learning fixture.", order: 0 });
for (const name of ["student","second"]) await Enrollment.create({ course: course._id, student: users[name].id, assignedBy: users.owner.id });
const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
console.log(JSON.stringify({ apiOrigin: `http://127.0.0.1:${server.address().port}`, courseId: String(course._id), otherCourseId: String(otherCourse._id), users }));
let closing = false;
async function close() { if (closing) return; closing = true; await new Promise((resolve) => server.close(resolve)); await mongoose.connection.dropDatabase(); await mongoose.disconnect(); process.exit(0); }
process.on("SIGTERM", close); process.on("SIGINT", close);
const input = readline.createInterface({ input: process.stdin });
for await (const line of input) {
  try {
    const command = JSON.parse(line);
    if (command.action === "expire" && mongoose.isValidObjectId(command.attemptId)) {
      const result = await AssessmentAttempt.updateOne({ _id: command.attemptId, course: course._id, status: "active" }, { $set: { deadline: new Date(Date.now() + 2500) } });
      console.log(JSON.stringify({ updated: result.modifiedCount }));
    } else if (command.action === "revoke") {
      await Enrollment.updateOne({ course: course._id, student: users.student.id }, { $unset: { assignedBy: 1 } }); console.log(JSON.stringify({ revoked: true }));
    } else if (command.action === "stats") {
      console.log(JSON.stringify({ assessments: await Assessment.countDocuments({ course: course._id }), attempts: await AssessmentAttempt.countDocuments({ course: course._id }), active: await AssessmentAttempt.countDocuments({ course: course._id, status: "active" }) }));
    } else if (command.action === "stop") await close();
    else console.log(JSON.stringify({ error: "Unsupported fixture command" }));
  } catch { console.log(JSON.stringify({ error: "Fixture command failed" })); }
}
await close();
