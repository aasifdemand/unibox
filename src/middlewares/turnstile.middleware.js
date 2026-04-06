import { verifyTurnstileToken } from '../utils/turnstile.js';

/**
 * Middleware to verify Cloudflare Turnstile token for protected routes.
 * Expects 'cf-turnstile-response' in the request body.
 */
export const validateTurnstile = async (req, res, next) => {
  // Extract token from body
  const token = req.body['cf-turnstile-response'] || req.body.turnstileToken;

  // If in a non-production environment, we might want to skip if key is missing
  // But for now, we follow the secure path.
  console.log('🛡️ Verifying Turnstile token...');

  const isValid = await verifyTurnstileToken(token);

  if (!isValid) {
     console.warn('❌ Turnstile verification failed for request.');
     return res.status(403).json({
       success: false,
       message: 'Security verification failed. Please try again.',
     });
  }

  console.log('✅ Turnstile verification successful.');
  next();
};
