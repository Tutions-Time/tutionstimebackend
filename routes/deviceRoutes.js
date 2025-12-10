const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const ctrl = require('../controllers/deviceController');

router.use(authenticate);

router.post('/register', ctrl.register);
router.get('/', ctrl.listMine);
router.delete('/:id', ctrl.remove);
router.patch('/:id/enable', ctrl.toggleEnable);

module.exports = router;

