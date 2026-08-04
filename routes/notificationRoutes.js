const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const ctrl = require('../controllers/notificationController');
const suspensionController = require('../controllers/suspensionController');

router.use(authenticate);

router.get('/', ctrl.listMine);
router.get('/suspensions/:id', suspensionController.getMySuspensionAppeal);
router.post('/suspensions/:id/reply', suspensionController.replyToSuspensionAppeal);
router.patch('/read-all', ctrl.markAllRead);
router.patch('/:id/read', ctrl.markRead);
router.delete('/:id', ctrl.deleteNotification);
router.delete('/', ctrl.deleteAll);
router.get('/preferences', ctrl.getPreferences);
router.put('/preferences', ctrl.updatePreferences);

module.exports = router;



