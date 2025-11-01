// testEmail.js
require("dotenv").config();
const nodemailer = require("nodemailer");

async function sendTest() {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: true,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  await transporter.sendMail({
    from: process.env.FROM_EMAIL,
    to: "gagansodlan123@gmail.com", // test email
    subject: "✅ Test Email from TuitionTime",
    text: "This is a test email to verify Gmail SMTP is working properly!",
  });

  console.log("✅ Test email sent!");
}

sendTest().catch(console.error);
