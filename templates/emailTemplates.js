// ==============================
// 📨 STUDENT-SIDE EMAILS
// ==============================
exports.bookingConfirmedHTML = ({ tutorName, subject, date, link }) => `
  <div style="font-family:Inter,Arial,sans-serif;padding:20px">
    <h2 style="color:#FFD54F">Demo Confirmed!</h2>
    <p>Your demo with <strong>${tutorName}</strong> for <strong>${subject}</strong> is scheduled on <b>${date}</b>.</p>
    <p>
      <a href="${link}" style="display:inline-block;background:#FFD54F;color:#000;
         padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600;">
         Join Demo
      </a>
    </p>
    <p style="color:#555">Powered by TuitionTime</p>
  </div>
`;

exports.bookingCancelledHTML = ({ tutorName, subject }) => `
  <div style="font-family:Inter,Arial,sans-serif;padding:20px">
    <h2 style="color:#d32f2f">Demo Cancelled</h2>
    <p>Your demo with <strong>${tutorName}</strong> for <strong>${subject}</strong> has been cancelled.</p>
    <p style="color:#555">You can request another demo anytime.</p>
  </div>
`;

// ==============================
// 📨 TUTOR-SIDE EMAILS
// ==============================
exports.tutorDemoRequestHTML = ({ studentName, subject, date }) => `
  <div style="font-family:Inter,Arial,sans-serif;padding:20px">
    <h2 style="color:#FFD54F">New Demo Request</h2>
    <p><strong>${studentName}</strong> requested a demo for <strong>${subject}</strong> on <b>${date}</b>.</p>
    <p style="margin-top:10px;color:#555">
      Please log in to your TuitionTime dashboard to confirm or cancel this request.
    </p>
  </div>
`;

exports.tutorFeedbackReceivedHTML = ({ studentName, subject, rating, feedback }) => `
  <div style="font-family:Inter,Arial,sans-serif;padding:20px">
    <h2 style="color:#FFD54F">New Feedback Received ⭐</h2>
    <p><strong>${studentName}</strong> rated your <strong>${subject}</strong> demo as <b>${rating}/5</b>.</p>
    <p style="margin-top:8px;border-left:4px solid #FFD54F;padding-left:10px;color:#444">
      "${feedback || 'No written feedback provided.'}"
    </p>
    <p style="margin-top:10px;color:#555">Keep up the great work! 🎓</p>
  </div>
`;
