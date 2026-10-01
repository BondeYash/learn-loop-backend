import Lesson from "../models/Lesson.js";
import Progress from "../models/Progress.js";

// Completion is relative to the current curriculum, which an instructor can edit.
export async function currentProgress(enrollments) {
  if (!enrollments.length) return new Map();
  const courseIds = [...new Set(enrollments.map((entry) => String(entry.course._id || entry.course)))];
  const studentIds = [...new Set(enrollments.map((entry) => String(entry.student._id || entry.student)))];
  const [lessons, records] = await Promise.all([
    Lesson.find({ course: { $in: courseIds } }).select("_id course").lean(),
    Progress.find({ student: { $in: studentIds }, course: { $in: courseIds } }).lean(),
  ]);
  const lessonsByCourse = new Map(courseIds.map((id) => [id, new Set()]));
  for (const lesson of lessons) lessonsByCourse.get(String(lesson.course)).add(String(lesson._id));
  const saved = new Map(records.map((record) => [`${record.student}:${record.course}`, record]));
  return new Map(enrollments.map((entry) => {
    const course = String(entry.course._id || entry.course);
    const student = String(entry.student._id || entry.student);
    const key = `${student}:${course}`;
    const record = saved.get(key);
    const current = lessonsByCourse.get(course);
    const completedLessons = (record?.completedLessons || []).filter((id) => current.has(String(id)));
    const percentage = current.size ? Math.round(completedLessons.length / current.size * 100) : 0;
    return [key, { ...record, completedLessons, percentage }];
  }));
}
export function withCurrentCompletion(entry, progress) {
  const complete = progress.percentage === 100;
  return { ...entry, status: complete ? "completed" : "active", completedAt: complete ? entry.completedAt : undefined };
}
