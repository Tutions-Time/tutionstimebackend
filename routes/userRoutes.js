const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const studentSearchController = require('../controllers/studentSearchController');
const { authenticate, checkRole } = require('../middleware/auth');
const uploadS3 = require('../middleware/uploadS3');

router.get('/profile', authenticate, userController.getUserProfile);
router.get('/', authenticate, userController.getAllUsers);

router.post(
  '/student-profile',
  authenticate,
  uploadS3.fields([{ name: 'photo', maxCount: 1 }]),
  userController.updateStudentProfile
);

router.get(
  '/student-profile/:studentUserId',
  authenticate,
  checkRole(['tutor']),
  userController.getStudentProfileForTutor
);

router.post(
  '/tutor-profile',
  authenticate,
  uploadS3.fields([
    { name: 'photo', maxCount: 1 },
    { name: 'resume', maxCount: 1 },
    { name: 'aadhaar', maxCount: 1 },
    { name: 'pan', maxCount: 1 }
  ]),
  userController.updateTutorProfile
);

router.patch(
  '/student-payout-details',
  authenticate,
  checkRole(['student']),
  userController.updateStudentPayoutDetails
);

router.patch(
  '/tutor-payout-details',
  authenticate,
  checkRole(['tutor']),
  userController.updateTutorPayoutDetails
);

router.post(
  '/tutor-kyc',
  authenticate,
  uploadS3.fields([
    { name: 'aadhaar', maxCount: 2 },
    { name: 'pan', maxCount: 1 }
  ]),
  userController.uploadTutorKyc
);

router.get(
  '/search',
  authenticate,
  checkRole(['tutor']),
  studentSearchController.searchStudents
);

module.exports = router;
