const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const studentSearchController = require('../controllers/studentSearchController.js')
const { authenticate,checkRole } = require('../middleware/auth');
const upload = require('../middleware/upload');

// Get user profile
router.get('/profile', authenticate, userController.getUserProfile);
router.get('/', authenticate,  userController.getAllUsers);


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
    { name: 'resume', maxCount: 1 },
    { name: 'demoVideo', maxCount: 1 }
  ]),
  userController.updateTutorProfile
);

router.post(
  '/tutor-kyc',
  authenticate,
  upload.fields([
    { name: 'aadhaar', maxCount: 2 },
    { name: 'pan', maxCount: 1 },
    { name: 'bankProof', maxCount: 1 },
  ]),
  userController.uploadTutorKyc
);

router.get('/search',authenticate,  checkRole(['tutor']), studentSearchController.searchStudents);




module.exports = router;