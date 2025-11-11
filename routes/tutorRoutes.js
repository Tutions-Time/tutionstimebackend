const express = require('express');
const router = express.Router();
const tutorSearchController = require('../controllers/tutorSearchController');
const { authenticate } = require('../middleware/auth');

// ✅ Hybrid route — filters OR AI recommendations
router.get('/search', authenticate, tutorSearchController.searchTutors);

// ✅ Get single tutor profile
router.get('/:id', tutorSearchController.getTutorById);

module.exports = router;
