const express = require('express');
const router = express.Router();
const subjectController = require('../controllers/subjectController');
const auth = require('../middleware/auth');
const isAdmin = require('../middleware/isAdmin');

// Public route - Get all active subjects
router.get('/', subjectController.getAllSubjects);

// Admin routes - Create, update, delete subjects
router.post('/', auth.authenticate, isAdmin, subjectController.createSubject);
router.put('/:id', auth.authenticate, isAdmin, subjectController.updateSubject);
router.delete('/:id', auth.authenticate, isAdmin, subjectController.deleteSubject);

module.exports = router;