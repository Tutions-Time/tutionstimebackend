const multer = require("multer");
const multerS3 = require("multer-s3");
const s3 = require("../config/s3");
const path = require("path");
const { nanoid } = require("nanoid");

const bucket = process.env.AWS_BUCKET;

// file filter (same as your previous)
const fileFilter = (req, file, cb) => {
  const mime = file.mimetype;

  if (file.fieldname === "photo" && !mime.startsWith("image/"))
    return cb(new Error("Only image allowed for photo"), false);

  if (file.fieldname === "demoVideo" && !mime.startsWith("video/"))
    return cb(new Error("Only video allowed for demoVideo"), false);

  if (file.fieldname === "resume" && mime !== "application/pdf")
    return cb(new Error("Only PDF allowed for resumes"), false);

  cb(null, true);
};

// multer-s3 storage
const uploadS3 = multer({
  storage: multerS3({
    s3,
    bucket,
    contentType: multerS3.AUTO_CONTENT_TYPE,
    acl: "public-read",
    metadata: (req, file, cb) => cb(null, { fieldName: file.fieldname }),
    key: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      const uniqueName = `${file.fieldname}-${Date.now()}-${nanoid()}${ext}`;
      cb(null, uniqueName);
    },
  }),
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 },
});

module.exports = uploadS3;
