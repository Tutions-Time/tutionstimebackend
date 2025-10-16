const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { authenticate } = require('../middleware/auth');
const upload = require('../middleware/upload');

// Get user profile
router.get('/profile', authenticate, userController.getUserProfile);

// Update student profile with photo upload
router.post('/student-profile', 
  authenticate,
  upload.fields([{ name: 'photo', maxCount: 1 }]),
  userController.updateStudentProfile
);

// Update tutor profile with multiple file uploads
router.post('/tutor-profile', 
  authenticate,
  upload.fields([
    { name: 'photo', maxCount: 1 },
    { name: 'certificate', maxCount: 1 },
    { name: 'demoVideo', maxCount: 1 }
  ]),
  userController.updateTutorProfile
);

module.exports = router;