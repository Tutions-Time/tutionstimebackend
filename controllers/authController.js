const User = require("../models/User");
const otpService = require("../services/otpService");
const tokenService = require("../services/tokenService");
const walletService = require("../services/payments/walletService");
const bcrypt = require("bcryptjs");
const StudentProfile = require("../models/StudentProfile");
const TutorProfile = require("../models/TutorProfile");
const {
  isStudentProfileComplete,
  isTutorProfileComplete,
} = require("../utils/profileValidation");
const { logActivity } = require("../services/loggerService");
const { createAdminNotification } = require("../services/adminNotification");

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Admin credentials (Move to environment variables in production)
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD =
  "$2b$10$TCUXGHzI/sxObzQLY7zRBePZqLVYpOE.6hZ/1nlVWAHy5PGxw2DP2"; // "admin123"

// Admin login
const adminLogin = async (req, res) => {
  try {
    const { username, password } = req.body;

    // Validate input
    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: "Username and password are required",
      });
    }

    // Check username
    if (username !== ADMIN_USERNAME) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }

    // Verify password
    const isValid = await bcrypt.compare(password, ADMIN_PASSWORD);
    if (!isValid) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }

    // Generate tokens
    const adminUser = {
      id: "admin",
      role: "admin",
      isProfileComplete: true,
    };

    const accessToken = tokenService.generateAccessToken(
      adminUser.id,
      adminUser.role,
    );
    const refreshToken = tokenService.generateRefreshToken(adminUser.id);

    // Log admin login
    await logActivity(req, "ADMIN_LOGIN", { userId: "admin" });

    res.status(200).json({
      success: true,
      message: "Login successful",
      user: adminUser,
      tokens: {
        accessToken,
        refreshToken,
        expiresIn: 3600, // 1 hour in seconds
      },
    });
  } catch (error) {
    console.error("Admin Login Error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// Send OTP for login or signup
const sendOTP = async (req, res) => {
  try {
    const { email, purpose } = req.body;

    if (!email || !purpose || !["login", "signup"].includes(purpose)) {
      return res.status(400).json({
        success: false,
        message: "Email and valid purpose are required",
      });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    if (!EMAIL_REGEX.test(normalizedEmail)) {
      return res.status(400).json({
        success: false,
        message: "Please provide a valid email address",
      });
    }

    // Generate and store OTP
    const { otp, requestId, expiresAt } = await otpService.storeOTP(
      normalizedEmail,
      purpose,
    );

    // Send OTP via email (non-blocking for login/signup flow)
    const sent = await otpService.sendOTP(normalizedEmail, otp);
    if (!sent) {
      console.error(
        "Send OTP Error: failed to send email (OTP flow continues)",
        {
          email: normalizedEmail,
          purpose,
          requestId,
          time: new Date().toISOString(),
        },
      );
    }

    res.status(200).json({
      success: true,
      message: "OTP generated successfully",
      emailSent: !!sent,
      requestId,
      resendIn: 30,
      expiresIn: Math.floor((expiresAt - Date.now()) / 1000),
    });
  } catch (error) {
    console.error("Send OTP Error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// Verify OTP and authenticate user
const verifyOTP = async (req, res) => {
  try {
    const { email, otp, requestId, role, name, phone } = req.body;

    if (!email || !otp || !requestId) {
      return res.status(400).json({
        success: false,
        message: "Email, OTP, and requestId are required",
      });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    if (!EMAIL_REGEX.test(normalizedEmail)) {
      return res.status(400).json({
        success: false,
        message: "Please provide a valid email address",
      });
    }

    const verification = await otpService.verifyOTP(
      requestId,
      otp,
      normalizedEmail,
    );

    if (!verification.valid) {
      return res.status(400).json({
        success: false,
        message: verification.message,
      });
    }

    let user;

    // For signup, create a new user if not exists
    if (verification.purpose === "signup") {
      if (!role || !["student", "tutor"].includes(role)) {
        return res.status(400).json({
          success: false,
          message: "Valid role is required for signup",
        });
      }
      // Validate required extra fields for signup
      const trimmedName = String(name || "").trim();
      const trimmedPhone = String(phone || "").trim();
      if (!trimmedName || !trimmedPhone) {
        return res.status(400).json({
          success: false,
          message: "Name and WhatsApp number are required",
        });
      }
      if (!/^[0-9]{10}$/.test(trimmedPhone)) {
        return res.status(400).json({
          success: false,
          message: "Please provide a valid 10-digit WhatsApp number",
        });
      }

      try {
        const creationResult = await User.findOneAndUpdate(
          { email: normalizedEmail },
          {
            $setOnInsert: {
              email: normalizedEmail,
              role,
              isProfileComplete: false,
              status: "active",
            },
          },
          {
            upsert: true,
            new: true,
            rawResult: true,
            setDefaultsOnInsert: true,
          },
        );

        user = creationResult.value;
        // Update phone on the user (duplicates allowed)
        if (user) {
          if (String(user.phone || "") !== trimmedPhone) {
            user.phone = trimmedPhone;
            try {
              await user.save();
            } catch (e) {
              if (e && e.code === 11000) {
                user.phone = undefined;
                try {
                  await user.save();
                } catch (_) {}
              } else {
                throw e;
              }
            }
          }
        }

        // Notify Admin for new signup
        if (creationResult.lastErrorObject?.updatedExisting === false) {
          try {
            const meta =
              role === "tutor"
                ? {
                    userId: user._id,
                    tutorId: user._id,
                    email: normalizedEmail,
                    role,
                  }
                : {
                    userId: user._id,
                    studentId: user._id,
                    email: normalizedEmail,
                    role,
                  };
            await createAdminNotification(
              "New User Signup",
              `A new ${role} signed up with email: ${normalizedEmail}`,
              meta,
            );
          } catch (e) {
            console.warn("New signup admin notification failed:", e.message);
          }
        }
        // Create minimal profile with provided name (same location as complete profile)
        try {
          if (role === "student") {
            await StudentProfile.findOneAndUpdate(
              { userId: user._id },
              { $set: { name: trimmedName, email: normalizedEmail } },
              { new: true, upsert: true },
            );
          } else if (role === "tutor") {
            await TutorProfile.findOneAndUpdate(
              { userId: user._id },
              { $set: { name: trimmedName, email: normalizedEmail } },
              { new: true, upsert: true },
            );
          }
        } catch (e) {
          console.warn("Minimal profile upsert failed:", e.message);
        }
      } catch (error) {
        if (error.code === 11000 && error.keyValue?.email === normalizedEmail) {
          user = await User.findOne({ email: normalizedEmail });
        } else {
          console.error("User creation error:", {
            email: normalizedEmail,
            role,
            error: error.message,
          });
          throw error;
        }
      }

      if (!user) {
        return res.status(500).json({
          success: false,
          message: "Unable to create or retrieve user",
        });
      }

      await walletService.ensureWallet(user._id, user.role);

    } else {
      // For login, find existing user
      user = await User.findOne({ email: normalizedEmail });

      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }
    }

    if (user.isDeleted) {
      return res.status(403).json({
        success: false,
        message:
          "Your account has been deleted. Please contact support to restore it.",
      });
    }

    if (user.status === "inactive" || user.status === "suspended") {
      return res.status(403).json({
        success: false,
        message: "Your account is blocked. Please contact support.",
      });
    }

    // Generate tokens
    const accessToken = tokenService.generateAccessToken(user._id, user.role);
    const refreshToken = tokenService.generateRefreshToken(user._id);

    // Save refresh token to user
    await tokenService.saveRefreshToken(user._id, refreshToken);

    // Log login/signup activity
    await logActivity(
      req,
      verification.purpose === "signup" ? "USER_SIGNUP" : "USER_LOGIN",
      { userId: user._id },
    );

    res.status(200).json({
      success: true,
      message: "OTP verified successfully",
      user: {
        id: user._id,
        email: user.email,
        phone: user.phone,
        role: user.role,
        isProfileComplete: user.isProfileComplete,
      },
      tokens: {
        accessToken,
        refreshToken,
        expiresIn: 3600, // 1 hour in seconds
      },
    });
  } catch (error) {
    console.error("Verify OTP Error:", error);

    // Handle specific error types
    if (error.code === 11000) {
      const duplicateField = Object.keys(error.keyValue || {})[0];
      let message = "Duplicate key error occurred during signup";
      if (duplicateField === "email") {
        message = "User with this email already exists";
      } else if (duplicateField === "userId") {
        message = "A wallet already exists for this user";
      }

      return res.status(400).json({
        success: false,
        message,
      });
    }

    if (error.message.includes("Valid email address is required")) {
      return res.status(400).json({
        success: false,
        message: "Please provide a valid email address",
      });
    }

    res.status(500).json({
      success: false,
      message: "An error occurred during signup",
      details:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

// Get current user
const getCurrentUser = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    if (user.role === "student") {
      const profile = await StudentProfile.findOne({ userId: user._id }).lean();
      const isComplete = profile ? isStudentProfileComplete(profile) : false;
      if (user.isProfileComplete !== isComplete) {
        user.isProfileComplete = isComplete;
        await user.save();
      }
    } else if (user.role === "tutor") {
      const profile = await TutorProfile.findOne({ userId: user._id }).lean();
      const isComplete = profile ? isTutorProfileComplete(profile) : false;
      if (user.isProfileComplete !== isComplete) {
        user.isProfileComplete = isComplete;
        await user.save();
      }
    }

    res.status(200).json({
      success: true,
      user: {
        id: user._id,
        email: user.email,
        phone: user.phone,
        role: user.role,
        isProfileComplete: user.isProfileComplete,
      },
    });
  } catch (error) {
    console.error("Get Current User Error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

// Logout user
const logout = async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({
        success: false,
        message: "Refresh token is required",
      });
    }

    // Remove refresh token
    await tokenService.removeRefreshToken(req.user.id, refreshToken);

    res.status(200).json({
      success: true,
      message: "Logged out successfully",
    });
  } catch (error) {
    console.error("Logout Error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

// Refresh access token
const refreshToken = async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({
        success: false,
        message: "Refresh token is required",
      });
    }

    // Verify refresh token
    const decoded = tokenService.verifyRefreshToken(refreshToken);
    if (!decoded) {
      return res.status(401).json({
        success: false,
        message: "Invalid refresh token",
      });
    }

    // Check if refresh token exists in database
    const user = await User.findById(decoded.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Generate new tokens
    const accessToken = tokenService.generateAccessToken(user._id, user.role);
    const newRefreshToken = tokenService.generateRefreshToken(user._id);

    // Replace old refresh token
    await tokenService.replaceRefreshToken(
      user._id,
      refreshToken,
      newRefreshToken,
    );

    res.status(200).json({
      success: true,
      tokens: {
        accessToken,
        refreshToken: newRefreshToken,
        expiresIn: 3600,
      },
    });
  } catch (error) {
    console.error("Refresh Token Error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

module.exports = {
  sendOTP,
  verifyOTP,
  adminLogin,
  getCurrentUser,
  logout,
  refreshToken,
};
