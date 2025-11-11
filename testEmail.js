require('dotenv').config();
const nodemailer = require('nodemailer');

async function testEmail() {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: true,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  try {
    const info = await transporter.sendMail({
      from: process.env.FROM_EMAIL,
      to: "gagansodlan123@gmail.com",
      subject: "Test Email from TuitionTime",
      text: "If you see this, your mail config works!",
    });
    console.log("✅ Test Email sent:", info.messageId);
  } catch (err) {
    console.error("❌ Test email failed:", err);
  }
}

testEmail();
