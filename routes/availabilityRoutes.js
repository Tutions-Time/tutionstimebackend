const router = require('express').Router();
const { authenticate, checkRole } = require('../middleware/auth');
const ctrl = require('../controllers/availabilityController');

router.post('/me', authenticate, checkRole(['tutor']), ctrl.setSlots);
router.get('/:tutorId', ctrl.getTutorSlots);

module.exports = router;
