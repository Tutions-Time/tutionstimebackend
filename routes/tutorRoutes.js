const express = require('express');
const router = express.Router();
const tutorSearchController = require('../controllers/tutorSearchController');
const {authenticate} = require('../middleware/auth'); // optional, for personalized AI

// ✅ Hybrid route — serves both search and AI recommendations
router.get('/search', authenticate, tutorSearchController.searchTutors);

module.exports = router;
