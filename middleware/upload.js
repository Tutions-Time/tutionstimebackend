const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Configure multer storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    let basePath = path.join(__dirname, '..', 'uploads');
    let uploadPath = basePath;

    // Determine subfolder dynamically
    if (file.fieldname === 'photo') {
      uploadPath = path.join(basePath, 'photos');
    } 
    else if (file.fieldname === 'certificate') {
      // Separate PDFs vs images for certificates
      if (file.mimetype === 'application/pdf') {
        uploadPath = path.join(basePath, 'certificates', 'pdfs');
      } else {
        uploadPath = path.join(basePath, 'certificates', 'images');
      }
    } 
    else if (file.fieldname === 'demoVideo') {
      uploadPath = path.join(basePath, 'videos');
    }

    // ✅ Ensure directory exists
    fs.mkdirSync(uploadPath, { recursive: true });

    cb(null, uploadPath);
  },

  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `${file.fieldname}-${uniqueSuffix}${path.extname(file.originalname)}`);
  }
});

// File filter for validation
const fileFilter = (req, file, cb) => {
  const { fieldname, mimetype } = file;

  if (fieldname === 'photo') {
    if (!mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed for photos!'), false);
    }
  } 
  else if (fieldname === 'certificate') {
    if (!mimetype.startsWith('image/') && mimetype !== 'application/pdf') {
      return cb(new Error('Only image and PDF files are allowed for certificates!'), false);
    }
  } 
  else if (fieldname === 'demoVideo') {
    if (!mimetype.startsWith('video/')) {
      return cb(new Error('Only video files are allowed for demo videos!'), false);
    }
  }

  cb(null, true);
};

// Configure multer
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
  },
});

module.exports = upload;
