const express = require('express');
const router = express.Router();
const walletController = require('../controllers/walletController');
const auth = require('../middleware/auth');

// All wallet routes require authentication
router.use(auth.authenticate);

// Get wallet balance
router.get('/balance', walletController.getWalletBalance);

// Add funds to wallet
router.post('/add-funds', walletController.addFunds);

// Get transaction history
router.get('/transactions', walletController.getTransactions);

module.exports = router;