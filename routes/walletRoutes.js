const express = require('express');
const { authenticate } = require('../middleware/auth');
const ctrl = require('../controllers/walletController');
const router = express.Router();

router.use(authenticate);
router.get('/me', ctrl.getMyWallet);
router.get('/transactions', ctrl.getMyTransactions);

module.exports = router;
