const multer = require("multer");
const path = require("path");
const fs = require("fs");

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const base = "uploads";
    let subdir = "";

    switch (file.fieldname) {
      case "photo":
        subdir = "photos";
        break;
      case "certificate":
        subdir =
          file.mimetype === "application/pdf"
            ? path.join("certificates", "pdfs")
            : path.join("certificates", "images");
        break;
      case "demoVideo":
        subdir = "videos";
        break;
      case "aadhaar":
      case "pan":
      case "bankProof":
        subdir = "kyc";
        break;
      case "resume":
        subdir = "resumes";
        break;
      default:
        subdir = "misc";
        break;
    }

    const dest = path.join(base, subdir);
    fs.mkdirSync(dest, { recursive: true });
    cb(null, dest);
  },

  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, `${file.fieldname}-${unique}${path.extname(file.originalname)}`);
  },
});

const fileFilter = (req, file, cb) => {
  const { fieldname, mimetype } = file;

  if (fieldname === "photo" && !mimetype.startsWith("image/"))
    return cb(new Error("Only image files are allowed for photos!"), false);

  if (
    fieldname === "certificate" &&
    !mimetype.startsWith("image/") &&
    mimetype !== "application/pdf"
  )
    return cb(
      new Error("Only image or PDF files allowed for certificates!"),
      false
    );

  if (fieldname === "demoVideo" && !mimetype.startsWith("video/"))
    return cb(new Error("Only video files are allowed for demo videos!"), false);

  if (["aadhaar", "pan", "bankProof"].includes(fieldname)) {
    if (!mimetype.startsWith("image/") && mimetype !== "application/pdf")
      return cb(
        new Error("Only image or PDF files allowed for KYC documents!"),
        false
      );
  }

  if (fieldname === "resume" && mimetype !== "application/pdf")
    return cb(new Error("Only PDF files are allowed for resumes!"), false);

  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 },
});

module.exports = upload;
