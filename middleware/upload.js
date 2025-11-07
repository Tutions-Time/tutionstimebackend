const multer = require("multer");
const path = require("path");
const fs = require("fs");

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const basePath = path.join(__dirname, "..", "uploads");
    let uploadPath = basePath;

    switch (file.fieldname) {
      case "photo":
        uploadPath = path.join(basePath, "photos");
        break;
      case "certificate":
        uploadPath = file.mimetype === "application/pdf"
          ? path.join(basePath, "certificates", "pdfs")
          : path.join(basePath, "certificates", "images");
        break;
      case "demoVideo":
        uploadPath = path.join(basePath, "videos");
        break;
      case "aadhaar":
      case "pan":
      case "bankProof":
        uploadPath = path.join(basePath, "kyc");
        break;
    }

    fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },

  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, `${file.fieldname}-${uniqueSuffix}${path.extname(file.originalname)}`);
  },
});

const fileFilter = (req, file, cb) => {
  const { fieldname, mimetype } = file;

  if (fieldname === "photo" && !mimetype.startsWith("image/"))
    return cb(new Error("Only image files are allowed for photos!"), false);

  if (fieldname === "certificate" && !mimetype.startsWith("image/") && mimetype !== "application/pdf")
    return cb(new Error("Only image or PDF files allowed for certificates!"), false);

  if (fieldname === "demoVideo" && !mimetype.startsWith("video/"))
    return cb(new Error("Only video files are allowed for demo videos!"), false);

  if (["aadhaar", "pan", "bankProof"].includes(fieldname)) {
    if (!mimetype.startsWith("image/") && mimetype !== "application/pdf")
      return cb(new Error("Only image or PDF files allowed for KYC documents!"), false);
  }

  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 },
});

module.exports = upload;
