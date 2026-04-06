import { Router } from "express";
import passport from "../config/passportgoogle-oauth.js";
import passportLinkedin from "../config/passport-linkedin.config.js";
import {
  forgotPassword,
  googleCallback,
  login,
  logout,
  microsoftCallback,
  linkedinCallback,
  resendVerification,
  resetPassword,
  signup,
  verifyAccount,
  refreshToken,
} from "../controllers/auth.controller.js";
import { validateTurnstile } from "../middlewares/turnstile.middleware.js";

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: User Authentication APIs
 */

// =========================
// LOCAL AUTHENTICATION
// =========================

/**
 * @swagger
 * /api/v1/auth/signup:
 *   post:
 *     summary: Register a new user
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, email, password]
 *             properties:
 *               name:
 *                 type: string
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 format: password
 *     responses:
 *       201:
 *         description: Signup successful
 */
router.post("/signup", validateTurnstile, signup);

/**
 * @swagger
 * /api/v1/auth/login:
 *   post:
 *     summary: Login user
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 format: password
 *     responses:
 *       200:
 *         description: Login successful
 */
router.post("/login", validateTurnstile, login);

/**
 * @swagger
 * /api/v1/auth/logout:
 *   post:
 *     summary: Logout the currently authenticated user
 *     tags: [Auth]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Logout successful
 */
router.post("/logout", logout);

/**
 * @swagger
 * /api/v1/auth/refresh-token:
 *   post:
 *     summary: Refresh access token
 *     tags: [Auth]
 *     security: []
 *     responses:
 *       200:
 *         description: Token refreshed successfully
 */
router.post("/refresh-token", refreshToken);

// =========================
// PASSWORD RESET
// =========================

/**
 * @swagger
 * /api/v1/auth/forgot-password:
 *   post:
 *     summary: Send OTP to user's email for password reset
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *     responses:
 *       200:
 *         description: OTP sent successfully
 */
router.post("/forgot-password", validateTurnstile, forgotPassword);

/**
 * @swagger
 * /api/v1/auth/reset-password:
 *   post:
 *     summary: Verify OTP and reset user password
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, otp, newPassword]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               otp:
 *                 type: string
 *               newPassword:
 *                 type: string
 *                 format: password
 *     responses:
 *       200:
 *         description: Password reset successful
 */
router.post("/reset-password", validateTurnstile, resetPassword);

// =========================
// USER OAUTH (NOT FOR SENDERS)
// =========================

/**
 * @swagger
 * /api/v1/auth/google:
 *   get:
 *     summary: Login with Google (User Authentication)
 *     tags: [Auth]
 *     security: []
 *     responses:
 *       302:
 *         description: Redirects to Google OAuth
 */
router.get(
  "/google",
  passport.authenticate("google", {
    scope: ["profile", "email"],
    session: false,
  }),
);

/**
 * @swagger
 * /api/v1/auth/google/callback:
 *   get:
 *     summary: Google OAuth callback (User Authentication)
 *     tags: [Auth]
 *     security: []
 *     responses:
 *       302:
 *         description: Redirects to frontend
 */
router.get(
  "/google/callback",
  passport.authenticate("google", {
    session: false,
    prompt: "select_account",
    failureRedirect: `${process.env.FRONTEND_URL}/auth/login?error=google_auth_failed`, // Fixed path
  }),
  googleCallback,
);

/**
 * @swagger
 * /api/v1/auth/microsoft:
 *   get:
 *     summary: Login with Microsoft (User Authentication)
 *     tags: [Auth]
 *     security: []
 *     responses:
 *       302:
 *         description: Redirects to Microsoft OAuth
 */
router.get("/microsoft", (req, res, next) => {
  passport.authenticate("microsoft", {
    prompt: "select_account",
    scope: ["openid", "profile", "email", "User.Read"],
    session: false,
  })(req, res, next);
});

/**
 * @swagger
 * /api/v1/auth/microsoft/callback:
 *   get:
 *     summary: Microsoft OAuth callback (User Authentication)
 *     tags: [Auth]
 *     security: []
 *     responses:
 *       302:
 *         description: Redirects to frontend
 */
router.get(
  "/microsoft/callback",
  microsoftCallback,
);

/**
 * @swagger
 * /api/v1/auth/linkedin:
 *   get:
 *     summary: Login with LinkedIn (User Authentication)
 *     tags: [Auth]
 *     security: []
 *     responses:
 *       302:
 *         description: Redirects to LinkedIn OAuth
 */
router.get(
  "/linkedin",
  passportLinkedin.authenticate("linkedin", {
    scope: ["openid", "profile", "email"],
    session: false,
  }),
);

/**
 * @swagger
 * /api/v1/auth/linkedin/callback:
 *   get:
 *     summary: LinkedIn OAuth callback (User Authentication)
 *     tags: [Auth]
 *     security: []
 *     responses:
 *       302:
 *         description: Redirects to frontend
 */
router.get(
  "/linkedin/callback",
  passportLinkedin.authenticate("linkedin", {
    session: false,
    failureRedirect: `${process.env.FRONTEND_URL}/auth/login?error=oauth_failed`,
  }),
  linkedinCallback,
);


/**
 * @swagger
 * /api/v1/auth/verify-account:
 *   post:
 *     summary: Verify email with OTP
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, otp]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               otp:
 *                 type: string
 *     responses:
 *       200:
 *         description: Email verified successfully
 */
router.post("/verify-account", verifyAccount);

/**
 * @swagger
 * /api/v1/auth/resend-verification:
 *   post:
 *     summary: Resend verification OTP
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *     responses:
 *       200:
 *         description: OTP resent successfully
 */
router.post("/resend-verification", validateTurnstile, resendVerification);

export default router;
