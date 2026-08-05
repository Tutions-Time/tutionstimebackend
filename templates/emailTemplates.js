// ==============================
// ✉️  tuitionstime Email Templates (Styled & Branded)
// ==============================

const BRAND_COLOR = "#FFD54F";
const TEXT_COLOR = "#222";
const LOGO_URL = "https://tuitionstime.com/logo.png"; // ⬅️ replace with your actual logo URL
const INSTAGRAM_URL = "https://instagram.com/tuitionstime";
const LINKEDIN_URL = "https://www.linkedin.com/company/tuitionstime/";
const WEBSITE_URL = "https://tuitionstime.com/dashboard";

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const textToHtml = (value) =>
  escapeHtml(value)
    .split(/\n{2,}/)
    .map(
      (paragraph) =>
        `<p style="font-size:16px;line-height:1.6;color:#333;margin:0 0 16px;">${paragraph.replace(/\n/g, "<br/>")}</p>`,
    )
    .join("");

const emailWrapper = (title, body, buttonLabel = null, buttonLink = null) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
</head>
<body style="margin:0; padding:0; background:#f6f8fb; font-family:'Inter',Arial,sans-serif;">
  <table align="center" cellpadding="0" cellspacing="0" width="100%" style="max-width:600px;margin:30px auto;background:#fff;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.06);overflow:hidden;">
    <!-- Header -->
    <tr>
      <td align="center" bgcolor="${BRAND_COLOR}" style="padding:25px 20px;">
        <img src="${LOGO_URL}" alt="tuitionstime" style="height:50px;margin-bottom:5px;" />
        <h2 style="margin:0;font-size:22px;color:${TEXT_COLOR};">${title}</h2>
      </td>
    </tr>

    <!-- Body -->
    <tr>
      <td style="padding:40px 30px;">
        ${body}
        ${
          buttonLabel && buttonLink
            ? `
              <div style="text-align:center;margin-top:30px;">
                <a href="${buttonLink}" style="display:inline-block;background:${BRAND_COLOR};color:${TEXT_COLOR};
                  font-weight:600;text-decoration:none;padding:12px 24px;border-radius:8px;
                  box-shadow:0 2px 6px rgba(0,0,0,0.1);"> ${buttonLabel} </a>
              </div>
            `
            : ""
        }
      </td>
    </tr>

    <!-- Footer -->
    <tr>
      <td align="center" style="padding:25px;background:#fafafa;border-top:1px solid #eee;">
        <p style="margin:0;color:#999;font-size:13px;">© 2025 <strong>tuitionstime</strong>. All rights reserved.</p>
        <p style="margin:6px 0;">
          <a href="${INSTAGRAM_URL}" style="color:#999;text-decoration:none;margin:0 6px;">Instagram</a> • 
          <a href="${LINKEDIN_URL}" style="color:#999;text-decoration:none;margin:0 6px;">LinkedIn</a> • 
          <a href="${WEBSITE_URL}" style="color:#999;text-decoration:none;margin:0 6px;">Website</a>
        </p>
      </td>
    </tr>
  </table>
</body>
</html>
`;

const detailRows = (items = []) => {
  const rows = items
    .filter((item) => item && item.value !== undefined && item.value !== null && String(item.value).trim() !== "")
    .map(
      ({ label, value }) => `
        <tr>
          <td style="padding:10px 0;color:#777;font-size:14px;border-bottom:1px solid #f0f0f0;">${escapeHtml(label)}</td>
          <td style="padding:10px 0;color:#222;font-size:14px;font-weight:600;text-align:right;border-bottom:1px solid #f0f0f0;">${escapeHtml(value)}</td>
        </tr>
      `
    )
    .join("");

  if (!rows) return "";
  return `
    <table cellpadding="0" cellspacing="0" width="100%" style="margin:22px 0;border-collapse:collapse;">
      ${rows}
    </table>
  `;
};

const noteBox = (message) =>
  message
    ? `<div style="background:#fff8d8;border:1px solid #f1d15a;border-radius:10px;padding:14px 16px;color:#4a3a00;font-size:14px;line-height:1.6;margin:18px 0;">${escapeHtml(message)}</div>`
    : "";

// ==============================
// 📨 STUDENT-SIDE EMAILS
// ==============================

exports.bookingConfirmedHTML = ({ tutorName, studentName, subject, date, time, link, role = "student" }) =>
  emailWrapper(
    "Demo Class Confirmed",
    `
      <p style="font-size:16px;line-height:1.6;color:#333;margin:0 0 16px;">
        Your demo class is confirmed. ${role === "tutor" ? `You will meet <strong>${escapeHtml(studentName || "the student")}</strong>.` : `You will meet <strong>${escapeHtml(tutorName || "your tutor")}</strong>.`}
      </p>
      ${detailRows([
        { label: "Subject", value: subject },
        { label: "Date", value: date },
        { label: "Time", value: time },
      ])}
      ${noteBox("Please join from the button below during the allowed class window.")}
    `,
    role === "tutor" ? "Start Demo" : "Join Demo",
    link
  );

exports.bookingCancelledHTML = ({ tutorName, subject, reason }) =>
  emailWrapper(
    "Demo Cancelled",
    `
      <p style="font-size:16px;line-height:1.6;color:#333;margin:0 0 16px;">
        Your demo with <strong>${escapeHtml(tutorName)}</strong> for <strong>${escapeHtml(subject)}</strong> has been cancelled.
      </p>
      ${detailRows([{ label: "Reason", value: reason }])}
      <p style="color:#555;">You can request another demo anytime from your tuitionstime dashboard.</p>
    `,
    "Book Another Demo",
    WEBSITE_URL
  );

exports.bookingExpiredHTML = ({
  headline = "Demo Request Expired",
  message,
  ctaLabel = "Open Dashboard",
  ctaLink = WEBSITE_URL,
}) =>
  emailWrapper(
    headline,
    `
      <p style="font-size:16px;line-height:1.6;color:#333;margin:0 0 16px;">
        ${message}
      </p>
      ${noteBox("You can review the latest status from your tuitionstime dashboard.")}
    `,
    ctaLabel,
    ctaLink
  );

exports.genericEmailHTML = ({
  title = "tuitionstime Update",
  message = "",
  html = "",
  ctaLabel = null,
  ctaLink = null,
}) =>
  emailWrapper(
    escapeHtml(title),
    html || textToHtml(message),
    ctaLabel,
    ctaLink
  );

exports.otpEmailHTML = ({ otp, purpose = "continue" }) =>
  emailWrapper(
    "Your tuitionstime OTP",
    `
      <p style="font-size:16px;line-height:1.6;color:#333;margin:0 0 16px;">
        Use this one-time password to ${escapeHtml(purpose)}.
      </p>
      <div style="text-align:center;margin:28px 0;">
        <span style="display:inline-block;letter-spacing:8px;font-size:32px;font-weight:800;color:${TEXT_COLOR};background:#fff8d8;border:1px solid #f1d15a;border-radius:10px;padding:14px 20px;">
          ${escapeHtml(otp)}
        </span>
      </div>
      <p style="font-size:14px;line-height:1.6;color:#666;margin:0;">
        This code expires in 5 minutes. If you did not request this, you can safely ignore this email.
      </p>
    `
  );

exports.suspensionNoticeHTML = ({ name, role, reason, explanation, replyLink }) =>
  emailWrapper(
    "Account Suspended",
    `
      <p style="font-size:16px;line-height:1.6;color:#333;margin:0 0 16px;">
        Hi <strong>${escapeHtml(name || "there")}</strong>, your ${escapeHtml(role || "account")} account has been suspended by the tuitionstime admin team.
      </p>
      ${detailRows([
        { label: "Reason", value: reason },
        { label: "Admin message", value: explanation },
      ])}
      ${noteBox("If you believe this needs review, please reply with your explanation from the button below.")}
      <p style="font-size:15px;line-height:1.6;color:#555;margin:18px 0 0;">
        Your reply will be shared with the admin team for review.
      </p>
    `,
    "Reply to Admin",
    replyLink
  );

exports.kycRejectedHTML = ({ name, reason, uploadLink }) =>
  emailWrapper(
    "KYC Documents Rejected",
    `
      <p style="font-size:16px;line-height:1.6;color:#333;margin:0 0 16px;">
        Hi <strong>${escapeHtml(name || "there")}</strong>, your KYC documents were rejected by the tuitionstime admin team.
      </p>
      ${detailRows([{ label: "Reason", value: reason }])}
      ${noteBox("You can reupload your documents and submit them for review again. Reuploads are allowed until your documents are approved.")}
    `,
    "Reupload Documents",
    uploadLink
  );

exports.kycApprovedHTML = ({ name, uploadLink }) =>
  emailWrapper(
    "KYC Documents Approved",
    `
      <p style="font-size:16px;line-height:1.6;color:#333;margin:0 0 16px;">
        Hi <strong>${escapeHtml(name || "there")}</strong>, your KYC documents have been approved.
      </p>
      ${noteBox("Your approved documents are now locked and cannot be changed from the tutor dashboard.")}
    `,
    "Open Verification",
    uploadLink
  );

exports.studentWelcomeHTML = ({ name }) =>
  emailWrapper(
    "Welcome to tuitionstime",
    `
      <p style="font-size:16px;line-height:1.6;color:#333;margin:0 0 16px;">
        Hi <strong>${escapeHtml(name || "there")}</strong>, welcome to tuitionstime.
      </p>
      <p style="font-size:16px;line-height:1.6;color:#333;margin:0 0 16px;">
        Your student profile is complete, and you are ready to explore tutors, request demo classes, and find learning support that fits your goals.
      </p>
      ${detailRows([
        { label: "Next step", value: "Search tutors and book a demo" },
        { label: "Dashboard", value: "Student dashboard" },
      ])}
      ${noteBox("Keep your learning preferences updated so we can show you better tutor matches.")}
      <p style="font-size:15px;line-height:1.6;color:#555;margin:18px 0 0;">
        We are glad to have you here and look forward to helping you learn with confidence.
      </p>
    `,
    "Open Dashboard",
    WEBSITE_URL
  );

// ==============================
// TUTOR-SIDE EMAILS
// ==============================

exports.tutorWelcomeHTML = ({ name }) =>
  emailWrapper(
    "Welcome to tuitionstime",
    `
      <p style="font-size:16px;line-height:1.6;color:#333;margin:0 0 16px;">
        Hi <strong>${escapeHtml(name || "there")}</strong>, welcome to tuitionstime.
      </p>
      <p style="font-size:16px;line-height:1.6;color:#333;margin:0 0 16px;">
        Your tutor profile is complete. Students can now discover your teaching profile, review your subjects, and connect with you for demo and regular classes.
      </p>
      ${detailRows([
        { label: "Next step", value: "Review requests from your dashboard" },
        { label: "Profile tip", value: "Keep availability and rates updated" },
      ])}
      ${noteBox("Our team may review tutor verification details before showing every feature as fully active.")}
      <p style="font-size:15px;line-height:1.6;color:#555;margin:18px 0 0;">
        Thank you for joining tuitionstime. We are excited to help you reach more students.
      </p>
    `,
    "Open Dashboard",
    WEBSITE_URL
  );

exports.tutorDemoRequestHTML = ({ studentName, subject, date, time }) =>
  emailWrapper(
    "New Demo Request",
    `
      <p style="font-size:16px;line-height:1.6;color:#333;margin:0 0 16px;">
        <strong>${escapeHtml(studentName)}</strong> requested a demo class.
      </p>
      ${detailRows([
        { label: "Subject", value: subject },
        { label: "Date", value: date },
        { label: "Time", value: time },
      ])}
      ${noteBox("Please accept or reject this request from your tutor dashboard.")}
    `,
    "View in Dashboard",
    WEBSITE_URL
  );

exports.studentDemoRequestHTML = ({ tutorName, subject, date, time }) =>
  emailWrapper(
    "New Demo Request from Tutor",
    `
      <p style="font-size:16px;line-height:1.6;color:#333;margin:0 0 16px;">
        <strong>${escapeHtml(tutorName)}</strong> invited you for a demo class.
      </p>
      ${detailRows([
        { label: "Subject", value: subject },
        { label: "Date", value: date },
        { label: "Time", value: time },
      ])}
      ${noteBox("Please accept or reject this request from your student dashboard.")}
    `,
    "Review Request",
    WEBSITE_URL
  );
exports.tutorFeedbackReceivedHTML = ({ studentName, subject, rating, feedback }) =>
  emailWrapper(
    "New Feedback Received ⭐",
    `
      <p style="font-size:16px;color:#333;">
        <strong>${studentName}</strong> rated your <strong>${subject}</strong> demo <b>${rating}/5</b>.
      </p>
      <p style="margin-top:10px;border-left:4px solid ${BRAND_COLOR};padding-left:12px;color:#444;font-style:italic;">
        "${feedback || "No written feedback provided."}"
      </p>
      <p style="margin-top:15px;color:#555;">Keep up the great work! 🎓</p>
    `
  );

exports.sessionReminderHTML = ({
  recipientName,
  role = "student",
  subject = "your class",
  date,
  time,
  link,
  classType = "Session",
}) =>
  emailWrapper(
    `${classType} Reminder`,
    `
      <p style="font-size:16px;line-height:1.6;color:#333;margin:0 0 16px;">
        Hi ${escapeHtml(recipientName || "there")}, your ${escapeHtml(subject)} ${escapeHtml(classType.toLowerCase())} starts soon.
      </p>
      ${detailRows([
        { label: "Class", value: classType },
        { label: "Subject", value: subject },
        { label: "Date", value: date },
        { label: "Time", value: time },
      ])}
      ${noteBox("Use the meeting button below when it is time to join.")}
    `,
    role === "tutor" ? "Start Class" : "Join Class",
    link
  );

exports.monthlySummaryHTML = ({ title = "Monthly Summary", rows = [], message = "" }) =>
  emailWrapper(
    title,
    `
      <p style="font-size:16px;line-height:1.6;color:#333;margin:0 0 16px;">
        ${escapeHtml(message || "Here is your latest tuitionstime activity summary.")}
      </p>
      ${detailRows(rows)}
    `,
    "Open Dashboard",
    WEBSITE_URL
  );





