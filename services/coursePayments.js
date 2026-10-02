import mongoose from "mongoose";
import { paymentOrderModel } from "../models/PaymentOrder.js";
import { stripeMode } from "./stripeMode.js";
import { rupeesToMinor } from "./coursePricing.js";

// Payment never filters nominated courses out of student lists. Summaries are
// scoped to this authenticated student and expose no provider IDs or URLs.
export async function withCoursePayments(courses, studentId) {
  if (!courses.length) return courses;
  const mode = stripeMode(), testMode = mode === "test", PaymentOrder = paymentOrderModel(mode);
  const records = await PaymentOrder.aggregate([
    { $match: { student: new mongoose.Types.ObjectId(String(studentId)), course: { $in: courses.map((course) => new mongoose.Types.ObjectId(String(course._id))) }, testMode } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: "$course", status: { $first: "$status" }, orderId: { $first: "$_id" }, paid: { $max: { $eq: ["$status", "paid"] } } } },
  ]);
  const byCourse = new Map(records.map((record) => [String(record._id), record]));
  return courses.map((item) => {
    const course = item.toObject ? item.toObject() : item, record = byCourse.get(String(course._id));
    const paid = Boolean(record?.paid), required = course.price > 0 && !paid;
    return { ...course, payment: { required, paid, testMode, status: course.price > 0 ? paid ? "paid" : record?.status || "required" : "free", amountMinor: rupeesToMinor(course.price || 0), ...(record ? { orderId: String(record.orderId) } : {}) } };
  });
}
