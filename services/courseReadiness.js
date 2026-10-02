import Lesson from "../models/Lesson.js";
import CourseNote from "../models/CourseNote.js";
import ApiError from "../utils/ApiError.js";
export async function ensureCourseReady(courseId) {
  const lessons = await Lesson.find({ course: courseId }).populate("video", "status");
  if (lessons.some((lesson) => lesson.contentType === "video" && lesson.video?.status !== "ready") || (!lessons.length && !await CourseNote.exists({ course: courseId, status: "ready" }))) throw new ApiError(409, "Add a lesson or PDF note, and finish all lesson video uploads before sharing with students.");
}
