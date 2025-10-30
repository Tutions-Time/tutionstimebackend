

exports.generateBookingEmailHTML = ({ studentName, tutorName, subject, dateTime, zoomLink, type }) => {
  return `
  <div style="font-family: 'Segoe UI', sans-serif; background-color: #f7f7f7; padding: 30px;">
    <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
      
      <!-- Header -->
      <div style="background-color: #207EA9; color: #ffffff; text-align: center; padding: 20px;">
        <h2 style="margin: 0;">TuitionTime</h2>
        <p style="margin: 5px 0 0;">Your ${type === 'demo' ? 'Demo' : 'Class'} Booking Confirmation</p>
      </div>
      
      <!-- Body -->
      <div style="padding: 25px 30px; color: #333;">
        <p style="font-size: 16px;">Hi <strong>${studentName || 'Student'}</strong>,</p>
        <p style="font-size: 15px;">Your ${type} with <strong>${tutorName || 'your tutor'}</strong> has been successfully scheduled!</p>
        
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #eee;">📘 <strong>Subject:</strong></td>
            <td style="padding: 8px; border-bottom: 1px solid #eee;">${subject}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #eee;">🗓 <strong>Date & Time:</strong></td>
            <td style="padding: 8px; border-bottom: 1px solid #eee;">${dateTime}</td>
          </tr>
        </table>

        <div style="text-align: center; margin: 30px 0;">
          <a href="${zoomLink}" target="_blank" 
            style="display: inline-block; background-color: #207EA9; color: white; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 500;">
            Join Zoom Class
          </a>
        </div>

        <p style="font-size: 14px; color: #555;">Please make sure to join a few minutes before the scheduled time.</p>
        <p style="font-size: 14px; color: #555;">We look forward to helping you learn better 🚀</p>

        <p style="margin-top: 25px; font-size: 13px; color: #999;">— The TuitionTime Team</p>
      </div>
    </div>
  </div>`;
};
