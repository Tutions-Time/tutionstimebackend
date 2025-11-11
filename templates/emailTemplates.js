// ==============================
// ✉️  TuitionTime Email Templates (Styled & Branded)
// ==============================

const BRAND_COLOR = "#FFD54F";
const TEXT_COLOR = "#222";
const LOGO_URL = "https://tuitiontime.com/logo.png"; // ⬅️ replace with your actual logo URL
const INSTAGRAM_URL = "https://instagram.com/tuitiontime";
const LINKEDIN_URL = "https://linkedin.com/company/tuitiontime";
const WEBSITE_URL = "https://tuitiontime.com/dashboard";

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
        <img src="${LOGO_URL}" alt="TuitionTime" style="height:50px;margin-bottom:5px;" />
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
        <p style="margin:0;color:#999;font-size:13px;">© 2025 <strong>TuitionTime</strong>. All rights reserved.</p>
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

// ==============================
// 📨 STUDENT-SIDE EMAILS
// ==============================

exports.bookingConfirmedHTML = ({ tutorName, subject, date, link }) =>
  emailWrapper(
    "Demo Confirmed!",
    `
      <p style="font-size:16px;color:#333;">
        Your demo with <strong>${tutorName}</strong> for <strong>${subject}</strong> is scheduled on <b>${date}</b>.
      </p>
      <p style="color:#555;">Click below to join your demo at the scheduled time.</p>
    `,
    "Join Demo",
    link
  );

exports.bookingCancelledHTML = ({ tutorName, subject }) =>
  emailWrapper(
    "Demo Cancelled",
    `
      <p style="font-size:16px;color:#333;">
        Your demo with <strong>${tutorName}</strong> for <strong>${subject}</strong> has been cancelled.
      </p>
      <p style="color:#555;">You can request another demo anytime from your TuitionTime dashboard.</p>
    `,
    "Book Another Demo",
    WEBSITE_URL
  );

// ==============================
// 📨 TUTOR-SIDE EMAILS
// ==============================

exports.tutorDemoRequestHTML = ({ studentName, subject, date }) =>
  emailWrapper(
    "New Demo Request",
    `
      <p style="font-size:16px;color:#333;">
        <strong>${studentName}</strong> requested a demo for <strong>${subject}</strong> on <b>${date}</b>.
      </p>
      <p style="margin-top:10px;color:#555;">
        Please log in to your TuitionTime dashboard to confirm or cancel this request.
      </p>
    `,
    "View in Dashboard",
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
