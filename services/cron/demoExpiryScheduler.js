const nodeCron = require("node-cron");
const Booking = require("../../models/Booking");
const realtimeEvents = require("../realtimeEventService");

const DEMO_DURATION_MINUTES = Number(
  process.env.DEMO_DURATION_MINUTES || 15
);
const DEMO_EXPIRE_GRACE_MINUTES = Number(
  process.env.DEMO_EXPIRE_GRACE_MINUTES || 5
);

function parseTime(timeStr) {
  if (!timeStr) return null;
  const [hourStr, minuteStr] = timeStr.split(":");
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return { hour, minute };
}

function getBookingEndDatetime(booking) {
  if (!booking?.preferredDate) return null;
  const base = new Date(booking.preferredDate);

  let target = parseTime(booking.preferredEndTime);
  if (!target) {
    target = parseTime(booking.preferredTime);
  }

  if (!target) return null;

  const endDate = new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    target.hour,
    target.minute,
    0,
    0
  );

  if (!booking.preferredEndTime && booking.preferredTime) {
    endDate.setMinutes(endDate.getMinutes() + DEMO_DURATION_MINUTES);
  }

  return endDate;
}

async function runOnce() {
  const now = new Date();
  const threshold = new Date(
    now.getTime() -
      DEMO_EXPIRE_GRACE_MINUTES * 60 * 1000
  );

  const candidates = await Booking.find({
    type: "demo",
    status: { $in: ["pending", "confirmed"] },
    studentJoinedAt: null,
    tutorJoinedAt: null,
  });

  for (const booking of candidates) {
    const endDate = getBookingEndDatetime(booking);
    if (!endDate) continue;
    if (endDate > threshold) continue;

    booking.status = "expired";
    booking.attendance = "absent";
    booking.actualEndTime = endDate;
    await booking.save();

    realtimeEvents.notifyBookingStatusUpdate(booking, {
      title: "Demo expired",
      message: "The scheduled demo was not joined by anyone.",
      body: "We have marked the demo as expired.",
    });
  }
}

function start() {
  nodeCron.schedule("*/5 * * * *", runOnce);
}

module.exports = {
  start,
  runOnce,
};
