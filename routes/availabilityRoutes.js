const router = require('express').Router();
const { authenticate, checkRole } = require('../middleware/auth');
const ctrl = require('../controllers/availabilityController');

// Tutor sets or updates available slots
router.post('/me', authenticate, checkRole(['tutor']), ctrl.setSlots);

// Tutor views their own slots
router.get('/me', authenticate, checkRole(['tutor']), ctrl.getMySlots);

// Students fetch tutor’s available slots (demo or regular)
router.get('/:tutorId', ctrl.getTutorSlots);

router.delete('/:slotId', authenticate, checkRole(['tutor']), ctrl.deleteSlot);


module.exports = router;
