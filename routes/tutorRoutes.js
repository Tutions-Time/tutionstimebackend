const express = require('express');
const router = express.Router();
const tutorSearchController = require('../controllers/tutorSearchController');
const {authenticate} = require('../middleware/auth'); 

// ✅ Hybrid route — serves both search and AI recommendations
router.get('/search', authenticate, tutorSearchController.searchTutors);

router.get('/:id', tutorSearchController.getTutorById);

module.exports = router;
