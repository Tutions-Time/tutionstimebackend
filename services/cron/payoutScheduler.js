const cron = require("node-cron");
const Payment = require("../../models/Payment");
const RegularClass = require("../../models/RegularClass");
const walletService = require("../payments/walletService");
const { createAdminNotification } = require("../adminNotification");


async function runPayoutRelease() {
  const now = new Date();
  const subs = await Payment.find({
    type: "subscription",
    status: "paid",
    releaseAt: { $lte: now },
    $or: [{ payoutGenerated: { $exists: false } }, { payoutGenerated: false }],
  }).lean();

  const notes = await Payment.find({
    type: "note",
    status: "paid",
    releaseAt: { $lte: now },
    $or: [{ payoutGenerated: { $exists: false } }, { payoutGenerated: false }],
  }).lean();

  const groups = await Payment.find({
    type: "group",
    status: "paid",
    releaseAt: { $lte: now },
    $or: [{ payoutGenerated: { $exists: false } }, { payoutGenerated: false }],
  }).lean();

  if (!subs.length && !notes.length && !groups.length) return;

  for (const sub of subs) {
    try {
      const amount = sub.amount;
      const commissionPercent = 25;
      const commissionAmount = (amount * commissionPercent) / 100;
      const tutorNetAmount = amount - commissionAmount;

      const payout = await Payment.create({
        regularClassId: sub.regularClassId,
        studentId: sub.studentId,
        tutorId: sub.tutorId,
        type: "payout",
        amount: sub.amount,
        currency: sub.currency,
        commissionPercent,
        commissionAmount,
        tutorNetAmount,
        periodStart: sub.periodStart,
        periodEnd: sub.periodEnd,
        status: "settled",
        notes: "Auto payout released after lock period",
      });

      await walletService.adminDecreaseHold(tutorNetAmount);
      await walletService.adminDebit(tutorNetAmount, "Tutor payout released", { type: "payout", id: payout._id });
      const TutorProfile = require("../../models/TutorProfile");
      const tpSub = await TutorProfile.findById(sub.tutorId).select("userId");
      const tutorUserIdSub = tpSub?.userId || sub.tutorId;
      await walletService.releasePendingToAvailable(tutorUserIdSub, "tutor", tutorNetAmount, "Payout released", { type: "payout", id: payout._id });

      await Payment.updateOne(
        { _id: sub._id },
        { payoutGenerated: true, payoutId: payout._id, fundReleaseStatus: "released", fundReleasedAt: new Date() }
      );

      await RegularClass.updateOne({ _id: sub.regularClassId }, { tutorPaymentStatus: "released" });

      await createAdminNotification(
        "Tutor payout auto-released",
        `Payout ${payout._id} settled for class ${sub.regularClassId}`,
        { payoutId: payout._id, regularClassId: sub.regularClassId, tutorId: sub.tutorId, amount: tutorNetAmount }
      );
    } catch (err) {
      console.error("Auto payout error:", err.message);
    }
  }

  for (const np of notes) {
    try {
      const amount = np.amount;
      const commissionPercent = 25;
      const commissionAmount = (amount * commissionPercent) / 100;
      const tutorNetAmount = amount - commissionAmount;

      const payout = await Payment.create({
        noteId: np.noteId,
        studentId: np.studentId,
        tutorId: np.tutorId,
        type: "payout",
        amount: np.amount,
        currency: np.currency,
        commissionPercent,
        commissionAmount,
        tutorNetAmount,
        status: "settled",
        notes: "Auto payout released for note after lock period",
      });

      await walletService.adminDecreaseHold(tutorNetAmount);
      await walletService.adminDebit(tutorNetAmount, "Tutor payout released for note", { type: "payout", id: payout._id });
      const TutorProfile = require("../../models/TutorProfile");
      const tp = await TutorProfile.findById(np.tutorId).select("userId");
      const tutorUserId = tp?.userId || np.tutorId;
      await walletService.releasePendingToAvailable(tutorUserId, "tutor", tutorNetAmount, "Payout released", { type: "payout", id: payout._id });

      await Payment.updateOne(
        { _id: np._id },
        { payoutGenerated: true, payoutId: payout._id, fundReleaseStatus: "released", fundReleasedAt: new Date() }
      );

      await createAdminNotification(
        "Tutor payout auto-released",
        `Payout ${payout._id} settled for note ${np.noteId}`,
        { payoutId: payout._id, noteId: np.noteId, tutorId: np.tutorId, amount: tutorNetAmount }
      );
    } catch (err) {
      console.error("Auto payout error:", err.message);
    }
  }

  for (const gp of groups) {
    try {
      const amount = gp.amount;
      const commissionPercent = 25;
      const commissionAmount = (amount * commissionPercent) / 100;
      const tutorNetAmount = amount - commissionAmount;

      const payout = await Payment.create({
        groupBatchId: gp.groupBatchId,
        studentId: gp.studentId,
        tutorId: gp.tutorId,
        type: "payout",
        amount: gp.amount,
        currency: gp.currency,
        commissionPercent,
        commissionAmount,
        tutorNetAmount,
        status: "settled",
        notes: "Auto payout released for group batch after lock period",
      });

      await walletService.adminDecreaseHold(tutorNetAmount);
      await walletService.adminDebit(tutorNetAmount, "Tutor payout released for group batch", { type: "payout", id: payout._id });
      const TutorProfile = require("../../models/TutorProfile");
      const tp = await TutorProfile.findById(gp.tutorId).select("userId");
      const tutorUserId = tp?.userId || gp.tutorId;
      await walletService.releasePendingToAvailable(tutorUserId, "tutor", tutorNetAmount, "Payout released", { type: "payout", id: payout._id });

      await Payment.updateOne(
        { _id: gp._id },
        { payoutGenerated: true, payoutId: payout._id, fundReleaseStatus: "released", fundReleasedAt: new Date() }
      );

      await createAdminNotification(
        "Tutor payout auto-released",
        `Payout ${payout._id} settled for group batch ${gp.groupBatchId}`,
        { payoutId: payout._id, groupBatchId: gp.groupBatchId, tutorId: gp.tutorId, amount: tutorNetAmount }
      );
    } catch (err) {
      console.error("Auto payout error:", err.message);
    }
  }
}

exports.start = function startPayoutScheduler() {
  cron.schedule("0 3 * * *", async () => {
    try {
      await runPayoutRelease();
    } catch (err) {
      console.error("Payout scheduler run failed:", err.message);
    }
  });
};

exports.runOnce = runPayoutRelease;
