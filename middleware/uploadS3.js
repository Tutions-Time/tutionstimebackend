// middleware/uploadS3.js
const multer = require("multer");
const multerS3 = require("multer-s3");
const s3 = require("../config/s3");
const path = require("path");
const { nanoid } = require("nanoid");

const uploadS3 = multer({
  storage: multerS3({
    s3,
    bucket: process.env.AWS_BUCKET,
    contentType: multerS3.AUTO_CONTENT_TYPE,
    metadata: (req, file, cb) => cb(null, { fieldName: file.fieldname }),
    key: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      // optional: add sessionId in key if available
      const sessionId = req.params?.id || "general";
      const name = `sessions/${sessionId}/${file.fieldname}-${Date.now()}-${nanoid()}${ext}`;
      cb(null, name);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

module.exports = uploadS3;
