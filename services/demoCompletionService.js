function determineDemoCompletion(booking, endTime) {
  const hasTutor = Boolean(booking?.tutorJoinedAt);
  const hasStudent = Boolean(booking?.studentJoinedAt);

  if (!hasTutor && !hasStudent) {
    return { updated: false, status: booking?.status || "pending" };
  }

  const now = endTime;
  const prevStatus = booking.status || "";
  const prevAttendance = booking.attendance || "";
  const prevEndTime = booking.actualEndTime;

  let newStatus = prevStatus;
  let newAttendance = prevAttendance;

  if (hasTutor && hasStudent) {
    newStatus = "completed";
    newAttendance = "present";
  } else if (hasTutor && !hasStudent) {
    newStatus = "student-missed";
    newAttendance = "no-show";
  } else if (!hasTutor && hasStudent) {
    newStatus = "tutor-missed";
    newAttendance = "absent";
  }

  booking.status = newStatus;
  booking.attendance = newAttendance;
  if (now) {
    booking.actualEndTime = now;
  }

  const attendanceChanged = newAttendance !== prevAttendance;
  const statusChanged = newStatus !== prevStatus;
  const endTimeChanged =
    !prevEndTime ||
    new Date(prevEndTime).getTime() !== new Date(now).getTime();

  return { updated: statusChanged || attendanceChanged || endTimeChanged, status: newStatus };
}

module.exports = { determineDemoCompletion };
