const Payment = require("../../models/Payment");
const RegularClass = require("../../models/RegularClass");
const Session = require("../../models/Session");
const TutorProfile = require("../../models/TutorProfile");
const walletService = require("./walletService");
const { createAdminNotification } = require("../adminNotification");
const { ensureContactAndFundAccount, createPayout } = require("./payoutProvider");

const SUBSCRIPTION_PAYOUT_DELAY_DAYS = Number(
  process.env.TUTOR_SUBSCRIPTION_PAYOUT_DELAY_DAYS || 2,
);

function addDays(baseDate, days) {
  return new Date(new Date(baseDate).getTime() + days * 24 * 60 * 60 * 1000);
}

function buildSubscriptionSessionFilter(payment, regularClass) {
  const filter = {
    regularClassId: regularClass._id,
    status: { $ne: "cancelled" },
  };

  const lowerBounds = [];
  if (payment.paidAt) lowerBounds.push(new Date(payment.paidAt));
  if (payment.periodStart) lowerBounds.push(new Date(payment.periodStart));
  if (lowerBounds.length) {
    const maxLower = lowerBounds.reduce((acc, dt) =>
      !acc || dt.getTime() > acc.getTime() ? dt : acc,
    null);
    if (maxLower) {
      filter.startDateTime = { ...(filter.startDateTime || {}), $gte: maxLower };
    }
  }

  return filter;
}

async function computeSubscriptionReleaseDate(payment, regularClass) {
  const filter = buildSubscriptionSessionFilter(payment, regularClass);
  const latestSession = await Session.findOne(filter)
    .sort({ startDateTime: -1, _id: -1 })
    .select("startDateTime")
    .lean();

  if (!latestSession?.startDateTime) {
    return null;
  }

  if (regularClass.planType === "hourly") {
    const requiredClasses = Math.max(0, Number(regularClass.classCount || 0));
    if (!requiredClasses) return null;

    const scheduledCount = await Session.countDocuments(filter);
    if (scheduledCount < requiredClasses) {
      return null;
    }
  } else if (regularClass.planType !== "monthly") {
    return null;
  }

  return addDays(latestSession.startDateTime, SUBSCRIPTION_PAYOUT_DELAY_DAYS);
}

async function saveReleaseState(payment, releaseDate) {
  payment.releaseAt = releaseDate || null;
  payment.fundReleaseDate = releaseDate || null;
  payment.fundReleaseStatus = releaseDate ? "pending" : "pending";
  if (!releaseDate) {
    payment.fundReleasedAt = null;
  }
  await payment.save();
  return payment;
}

async function recalculateSubscriptionRelease(paymentOrId) {
  const payment =
    typeof paymentOrId === "object" && paymentOrId?._id
      ? paymentOrId
      : await Payment.findById(paymentOrId);
  if (!payment || payment.type !== "subscription" || !payment.regularClassId) {
    return null;
  }

  if (payment.status !== "paid" || payment.payoutGenerated) {
    return payment;
  }

  const regularClass = await RegularClass.findById(payment.regularClassId).lean();
  if (!regularClass) {
    return await saveReleaseState(payment, null);
  }

  const releaseDate = await computeSubscriptionReleaseDate(payment, regularClass);
  return await saveReleaseState(payment, releaseDate);
}

async function recalculateSubscriptionReleaseForClass(regularClassId) {
  const payment = await Payment.findOne({
    regularClassId,
    type: "subscription",
    status: "paid",
    payoutGenerated: false,
  }).sort({ updatedAt: -1, createdAt: -1 });

  if (!payment) return null;
  return recalculateSubscriptionRelease(payment);
}

async function executeSubscriptionAutoPayout(paymentDoc) {
  const payment =
    typeof paymentDoc === "object" && paymentDoc?._id
      ? paymentDoc
      : await Payment.findById(paymentDoc);
  if (!payment || payment.type !== "subscription" || payment.payoutGenerated) {
    return null;
  }

  const regularClass = await RegularClass.findById(payment.regularClassId);
  const tutorProfile = await TutorProfile.findById(payment.tutorId);
  if (!regularClass || !tutorProfile) {
    throw new Error("Regular class or tutor profile not found for auto payout");
  }

  const tutorUserId = tutorProfile.userId || payment.tutorId;
  const tutorNetAmount =
    Number(payment.tutorNetAmount || 0) ||
    Math.max(
      0,
      Number(payment.amount || 0) - Number(payment.commissionAmount || 0),
    );
  const payoutMethod = tutorProfile.upiId?.trim()
    ? "UPI"
    : tutorProfile.bankAccountNumber && tutorProfile.ifsc && tutorProfile.accountHolderName
      ? "Bank"
      : null;

  if (tutorNetAmount <= 0) {
    throw new Error("Invalid tutor payout amount");
  }

  await walletService.releasePendingToAvailable(
    tutorUserId,
    "tutor",
    tutorNetAmount,
    "Subscription payout released",
    { type: "booking", id: payment.regularClassId },
  );

  const payout = await Payment.create({
    regularClassId: payment.regularClassId,
    studentId: payment.studentId,
    tutorId: payment.tutorId,
    type: "payout",
    amount: tutorNetAmount,
    currency: payment.currency || "INR",
    commissionPercent: 0,
    commissionAmount: 0,
    tutorNetAmount,
    status: "created",
    notes: payoutMethod
      ? `Auto payout to tutor ${payoutMethod}`
      : "Auto payout released to wallet only",
  });

  if (!payoutMethod) {
    await walletService.adminDecreaseHold(tutorNetAmount);
    await walletService.adminDebit(tutorNetAmount, "Tutor payout released to wallet", {
      type: "payout",
      id: payout._id,
    });

    payment.payoutGenerated = true;
    payment.payoutId = payout._id;
    payment.fundReleaseStatus = "released";
    payment.fundReleasedAt = new Date();
    await payment.save();

    regularClass.tutorPaymentStatus = "released";
    await regularClass.save();

    await createAdminNotification(
      "Tutor payout released to wallet",
      `UPI/bank not configured, payout ${payout._id} released to tutor wallet`,
      {
        payoutId: payout._id,
        regularClassId: payment.regularClassId,
        tutorId: payment.tutorId,
        amount: tutorNetAmount,
      },
    );

    return payout;
  }

  const hasProviderKeys =
    process.env.RAZORPAYX_KEY_ID &&
    process.env.RAZORPAYX_KEY_SECRET &&
    process.env.RAZORPAYX_ACCOUNT_NUMBER;

  if (!hasProviderKeys) {
    await walletService.adminDecreaseHold(tutorNetAmount);
    await walletService.adminDebit(tutorNetAmount, "Tutor payout released to wallet", {
      type: "payout",
      id: payout._id,
    });

    payment.payoutGenerated = true;
    payment.payoutId = payout._id;
    payment.fundReleaseStatus = "released";
    payment.fundReleasedAt = new Date();
    await payment.save();

    regularClass.tutorPaymentStatus = "released";
    await regularClass.save();

    await createAdminNotification(
      "Tutor payout fallback to wallet",
      `RazorpayX not configured, payout ${payout._id} released to wallet instead of ${payoutMethod}`,
      {
        payoutId: payout._id,
        regularClassId: payment.regularClassId,
        tutorId: payment.tutorId,
        amount: tutorNetAmount,
      },
    );

    return payout;
  }

  try {
    const { contactId, fundAccountId, useUPI } = await ensureContactAndFundAccount(
      tutorProfile,
    );
    if (
      tutorProfile.razorpayxContactId !== contactId ||
      tutorProfile.razorpayxFundAccountId !== fundAccountId
    ) {
      tutorProfile.razorpayxContactId = contactId;
      tutorProfile.razorpayxFundAccountId = fundAccountId;
      await tutorProfile.save();
    }

    const providerMode = useUPI ? "UPI" : "IMPS";
    const providerPayout = await createPayout(
      fundAccountId,
      tutorNetAmount,
      providerMode,
      String(payout._id),
    );

    payout.gatewayPaymentId = providerPayout.id;
    payout.notes = `Auto payout to tutor ${providerMode}${tutorProfile.upiId ? ` (${tutorProfile.upiId})` : ""}`;

    await walletService.debitWallet(
      tutorUserId,
      "tutor",
      tutorNetAmount,
      `Auto payout to ${providerMode}${tutorProfile.upiId ? ` ${tutorProfile.upiId}` : ""}`,
      { type: "payout", id: payout._id },
    );
    await walletService.adminDecreaseHold(tutorNetAmount);
    await walletService.adminDebit(tutorNetAmount, "Tutor auto payout", {
      type: "payout",
      id: payout._id,
    });

    if (
      providerPayout.status === "processed" ||
      providerPayout.status === "queued" ||
      providerPayout.status === "pending"
    ) {
      if (providerPayout.status === "processed") {
        payout.status = "settled";
      }

      payment.payoutGenerated = true;
      payment.payoutId = payout._id;
      payment.fundReleaseStatus = "released";
      payment.fundReleasedAt = new Date();
      await payment.save();

      regularClass.tutorPaymentStatus = "released";
      await regularClass.save();

      await payout.save();

      await createAdminNotification(
        "Tutor auto payout initiated",
        `Payout ${payout._id} sent to tutor ${providerMode}`,
        {
          payoutId: payout._id,
          regularClassId: payment.regularClassId,
          tutorId: payment.tutorId,
          amount: tutorNetAmount,
          mode: providerMode,
        },
      );
      return payout;
    }

    throw new Error(`Unexpected payout status: ${providerPayout.status || "unknown"}`);
  } catch (error) {
    payout.status = "failed";
    payout.notes = `Auto payout failed, released to wallet: ${error.message}`;
    await payout.save();

    await walletService.adminDecreaseHold(tutorNetAmount);
    await walletService.adminDebit(tutorNetAmount, "Tutor payout released to wallet", {
      type: "payout",
      id: payout._id,
    });

    payment.payoutGenerated = true;
    payment.payoutId = payout._id;
    payment.fundReleaseStatus = "released";
    payment.fundReleasedAt = new Date();
    await payment.save();

    regularClass.tutorPaymentStatus = "released";
    await regularClass.save();

    await createAdminNotification(
      "Tutor auto payout failed, wallet released",
      `Auto payout failed for class ${payment.regularClassId}; amount released to tutor wallet`,
      {
        payoutId: payout._id,
        regularClassId: payment.regularClassId,
        tutorId: payment.tutorId,
        amount: tutorNetAmount,
      },
    );

    return payout;
  }
}

module.exports = {
  recalculateSubscriptionRelease,
  recalculateSubscriptionReleaseForClass,
  executeSubscriptionAutoPayout,
};
