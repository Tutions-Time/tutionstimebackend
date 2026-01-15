const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const ctrl = require('../controllers/notificationController');

router.use(authenticate);

router.get('/', ctrl.listMine);
router.patch('/:id/read', ctrl.markRead);
router.patch('/read-all', ctrl.markAllRead);
router.delete('/:id', ctrl.deleteNotification);
router.delete('/', ctrl.deleteAll);
router.get('/preferences', ctrl.getPreferences);
router.put('/preferences', ctrl.updatePreferences);

module.exports = router;

