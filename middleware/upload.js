const multer = require('multer');
const path = require('path');

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    let uploadPath = 'uploads/';
    
    // Determine subfolder based on file type
    if (file.fieldname === 'photo') {
      uploadPath += 'photos/';
    } else if (file.fieldname === 'certificate') {
      uploadPath += 'certificates/';
    } else if (file.fieldname === 'demoVideo') {
      uploadPath += 'videos/';
    }
    
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    // Create unique filename with original extension
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

// File filter for validation
const fileFilter = (req, file, cb) => {
  if (file.fieldname === 'photo') {
    // Accept only images
    if (!file.mimetype.startsWith('image/')) {
      cb(new Error('Only image files are allowed for photos!'), false);
    }
  }
  else if (file.fieldname === 'certificate') {
    // Accept images and PDFs
    if (!file.mimetype.startsWith('image/') && file.mimetype !== 'application/pdf') {
      cb(new Error('Only image and PDF files are allowed for certificates!'), false);
    }
  }
  else if (file.fieldname === 'demoVideo') {
    // Accept only videos
    if (!file.mimetype.startsWith('video/')) {
      cb(new Error('Only video files are allowed for demo videos!'), false);
    }
  }
  
  cb(null, true);
};

// Configure multer
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max file size
  }
});

module.exports = upload;