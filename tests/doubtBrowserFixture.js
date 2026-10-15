// Disposable real-API browser fixture. Only R2 and Gemini are replaced; no
// credentials or network requests to production providers are used.
import crypto from "node:crypto";
import readline from "node:readline";
import mongoose from "mongoose";
import app from "../app.js";
import User from "../models/User.js";
import Session from "../models/Session.js";
import Course from "../models/Course.js";
import Category from "../models/Category.js";
import Module from "../models/Module.js";
import Lesson from "../models/Lesson.js";
import Enrollment from "../models/Enrollment.js";
import AuditEvent from "../models/AuditEvent.js";
import { CourseQuestion } from "../models/LearningSupport.js";
import { doubtModels, DoubtDocument, DoubtTurn, DoubtSettings } from "../models/DoubtDost.js";
import { processDoubtJob } from "../services/doubtWorker.js";
import ApiError from "../utils/ApiError.js";

await mongoose.connect(`mongodb://127.0.0.1:${process.env.TEST_MONGO_PORT || 27018}/lms_doubt_browser_${crypto.randomBytes(6).toString("hex")}`);
await Promise.all([User, Session, Course, Category, Module, Lesson, Enrollment, AuditEvent, CourseQuestion, ...doubtModels].map(model => model.init()));
const objects = new Map(), remotes = new Map(), operations = new Map();
let answerCount = 0, failNext = false, working = false;
const storage = { upload: async (doc, bytes) => objects.set(doc.objectKey, bytes), read: async doc => objects.get(doc.objectKey), remove: async doc => objects.delete(doc.objectKey), link: async doc => ({ url: `https://doubt-source.invalid/${doc._id}.pdf`, expiresAt: Date.now() + 300000 }) };
const provider = {
  createStore: async course => `fileSearchStores/${course}`,
  findDocument: async (store, id) => [...remotes.values()].find(doc => doc.name.startsWith(store + "/") && doc.displayName === String(id)),
  upload: async (store, doc) => { const remote = { name: `${store}/documents/${doc._id}`, displayName: String(doc._id), state: "ACTIVE" }; remotes.set(remote.name, remote); const name = `${store}/upload/operations/${doc._id}`; operations.set(name, remote); return { name, done: false }; },
  operation: async name => ({ done: true, response: { documentName: operations.get(name).name } }),
  document: async name => remotes.get(name), removeDocument: async name => remotes.delete(name), removeStore: async () => {},
  answer: async ({ documents, store, question, language }) => {
    answerCount++;
    if (failNext) { failNext = false; throw new ApiError(503, "Synthetic AI interruption. Your question was not answered."); }
    if (question.toLowerCase().includes("unknown")) return { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "UNSUPPORTED CONTENT SHOULD NEVER BE SHOWN" }] } }] };
    const doc = documents[0], text = language === "hi" ? "RAM अस्थायी मेमोरी है। यह इस कोर्स के नोट्स का एक उदाहरण है।" : language === "en" ? "RAM is temporary memory. This explanation comes from the synthetic course notes." : "RAM temporary memory hoti hai. Yeh explanation aapke course ke synthetic notes par based hai.";
    return { candidates: [{ finishReason: "STOP", content: { parts: [{ text }] }, groundingMetadata: { groundingChunks: [{ retrievedContext: { title: String(doc._id), fileSearchStore: store, pageNumber: 1, text: "RAM stores information temporarily while the computer is working.", customMetadata: [{ key: "document_id", stringValue: String(doc._id) }] } }], groundingSupports: [{ groundingChunkIndices: [0] }] } }], usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 120 } };
  },
};
app.locals.doubtStorage = storage; app.locals.doubtProvider = provider;
const users = {};
for (const role of ["admin", "instructor", "student"]) {
  const password = crypto.randomBytes(12).toString("hex"), email = `${role}@doubt-fixture.invalid`;
  const user = await User.create({ name: `Synthetic ${role}`, role, email, password }); users[role] = { id: String(user._id), email, password };
}
const category = await Category.create({ name: "Synthetic computers" });
const course = await Course.create({ title: "Synthetic CCC doubt course", description: "Synthetic course for isolated browser verification", category: category._id, instructor: users.instructor.id, isPublished: true, price: 199 });
const module = await Module.create({ course: course._id, title: "Computer basics", order: 0 });
await Lesson.create({ course: course._id, module: module._id, title: "Synthetic memory lesson", contentType: "text", content: "Synthetic local lesson.", order: 0 });
await Enrollment.create({ course: course._id, student: users.student.id, assignedBy: users.instructor.id, paymentWaivedAt: new Date(), paymentWaivedBy: users.instructor.id });
const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
const timer = setInterval(async () => {
  if (working) return; working = true;
  try { await DoubtDocument.updateMany({ status: { $in: ["queued", "indexing", "removing"] }, leaseUntil: null }, { nextAttemptAt: null }); await processDoubtJob({ provider, storage, configured: true }); }
  catch (e) { console.error(e.message); } finally { working = false; }
}, 120); timer.unref();
console.log(JSON.stringify({ courseId: String(course._id), apiOrigin: `http://127.0.0.1:${server.address().port}`, users }));
const commands = readline.createInterface({ input: process.stdin });
commands.on("line", async line => {
  const value = JSON.parse(line); let result = {};
  if (value.action === "fail-next") { failNext = true; result = { set: true }; }
  if (value.action === "stats") result = { documents: await DoubtDocument.countDocuments(), published: await DoubtDocument.countDocuments({ published: true }), turns: await DoubtTurn.countDocuments(), questions: await CourseQuestion.countDocuments(), answers: answerCount };
  if (value.action === "disabled") { await DoubtSettings.findOneAndUpdate({ _id: "global" }, { enabled: false }, { upsert: true }); result = { disabled: true }; }
  console.log(JSON.stringify(result));
});
let closing = false;
const close = async () => { if (closing) return; closing = true; clearInterval(timer); commands.close(); await new Promise(resolve => server.close(resolve)); while (working) await new Promise(resolve => setTimeout(resolve, 20)); await mongoose.connection.dropDatabase(); await mongoose.disconnect(); process.exit(0); };
process.on("SIGTERM", close); process.on("SIGINT", close);
