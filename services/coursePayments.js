import mongoose from "mongoose";
import { paymentOrderModel } from "../models/PaymentOrder.js";
import { paymentMode } from "./paymentSettings.js";
import { rupeesToMinor } from "./coursePricing.js";
import Enrollment from "../models/Enrollment.js";
import { hasPaymentWaiver } from "./courseAccess.js";

// Payment never filters nominated courses out of student lists. Summaries are
// scoped to this authenticated student and expose no provider IDs or URLs.
export async function withCoursePayments(courses, studentId) {
  if (!courses.length) return courses;
  const mode = paymentMode(), testMode = mode === "test", PaymentOrder = paymentOrderModel(mode);
  const records = await PaymentOrder.aggregate([
    { $match: { student: new mongoose.Types.ObjectId(String(studentId)), course: { $in: courses.map((course) => new mongoose.Types.ObjectId(String(course._id))) }, testMode } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: "$course", status: { $first: "$status" }, orderId: { $first: "$_id" }, paid: { $max: { $eq: ["$status", "paid"] } } } },
  ]);
  const byCourse = new Map(records.map((record) => [String(record._id), record]));
  const enrollments = await Enrollment.find({ student: studentId, course: { $in: courses.map((course) => course._id) }, paymentWaivedAt: { $exists: true } }).select("course assignedBy paymentWaivedAt");
  const waivedCourses = new Set(enrollments.filter(hasPaymentWaiver).map((item) => String(item.course)));
  return courses.map((item) => {
    const course = item.toObject ? item.toObject() : item, record = byCourse.get(String(course._id));
    const paid = Boolean(record?.paid), waived = course.price > 0 && waivedCourses.has(String(course._id)), required = course.price > 0 && !paid && !waived;
    return { ...course, payment: { required, paid, waived, testMode, status: course.price > 0 ? paid ? "paid" : waived ? "waived" : record?.status || "required" : "free", amountMinor: rupeesToMinor(course.price || 0), ...(record ? { orderId: String(record.orderId) } : {}) } };
  });
}
