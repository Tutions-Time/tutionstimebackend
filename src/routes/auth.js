const express = require('express');
const User = require('../models/User');
const { sendOtp, verifyOtp } = require('../services/otp');
const { signToken } = require('../utils/jwt');

const router = express.Router();

// POST /auth/send-otp { mobileNumber }
router.post('/send-otp', async (req, res) => {
  try {
    const { mobileNumber } = req.body;
    if (!mobileNumber) return res.status(400).json({ error: 'mobileNumber is required' });
    await sendOtp(mobileNumber);
    res.json({ message: 'OTP sent' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to send OTP' });
  }
});

// POST /auth/verify-otp { mobileNumber, code, name?, role?, password? }
router.post('/verify-otp', async (req, res) => {
  try {
    const { mobileNumber, code, name, role, password } = req.body;
    if (!mobileNumber || !code) return res.status(400).json({ error: 'mobileNumber and code are required' });

    const result = await verifyOtp(mobileNumber, code);
    if (result.status !== 'approved') return res.status(401).json({ error: 'Invalid or expired OTP' });

    let user = await User.findOne({ mobileNumber }).select('+password');
    if (!user) {
      user = await User.create({
        name: name || 'User',
        mobileNumber,
        role: ['student', 'tutor', 'admin', 'super_admin'].includes(role) ? role : 'student',
        isVerified: true,
        ...(password ? { password } : {}),
      });
    } else {
      if (!user.isVerified) {
        user.isVerified = true;
      }
      if (password) {
        user.password = password;
      }
      await user.save();
    }

    const token = signToken({ sub: user._id.toString(), role: user.role });
    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        mobileNumber: user.mobileNumber,
        role: user.role,
        isVerified: user.isVerified,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to verify OTP' });
  }
});

// POST /auth/login { mobileNumber, password }
router.post('/login', async (req, res) => {
  try {
    const { mobileNumber, password } = req.body;
    if (!mobileNumber || !password) return res.status(400).json({ error: 'mobileNumber and password are required' });

    const user = await User.findOne({ mobileNumber }).select('+password');
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (!user.isVerified) return res.status(403).json({ error: 'User not verified. Complete OTP registration first.' });

    const valid = await user.comparePassword(password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = signToken({ sub: user._id.toString(), role: user.role });
    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        mobileNumber: user.mobileNumber,
        role: user.role,
        isVerified: user.isVerified,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to login' });
  }
});

// POST /auth/forgot-password/send-otp { mobileNumber }
router.post('/forgot-password/send-otp', async (req, res) => {
  try {
    const { mobileNumber } = req.body;
    if (!mobileNumber) return res.status(400).json({ error: 'mobileNumber is required' });
    await sendOtp(mobileNumber);
    res.json({ message: 'OTP sent for password reset' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to send reset OTP' });
  }
});

// POST /auth/forgot-password/reset { mobileNumber, code, newPassword }
router.post('/forgot-password/reset', async (req, res) => {
  try {
    const { mobileNumber, code, newPassword } = req.body;
    if (!mobileNumber || !code || !newPassword) {
      return res.status(400).json({ error: 'mobileNumber, code and newPassword are required' });
    }

    const result = await verifyOtp(mobileNumber, code);
    if (result.status !== 'approved') return res.status(401).json({ error: 'Invalid or expired OTP' });

    const user = await User.findOne({ mobileNumber }).select('+password');
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.password = newPassword;
    await user.save();

    res.json({ message: 'Password reset successful' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to reset password' });
  }
});

module.exports = router;