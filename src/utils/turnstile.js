import axios from 'axios';

/**
 * Verify a Cloudflare Turnstile token with the Cloudflare API.
 * @param {string} token - The token provided by the client (cf-turnstile-response)
 * @returns {Promise<boolean>} True if verification succeeded, false otherwise.
 */
export const verifyTurnstileToken = async (token) => {
  if (!token) return false;

  const secretKey = process.env.CF_SECRET_KEY;
  if (!secretKey) {
    console.error('CF_SECRET_KEY is missing from environment variables.');
    return true; // Soft fail if key is missing during development
  }

  try {
    const response = await axios.post(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      new URLSearchParams({
        secret: secretKey,
        response: token,
      })
    );

    return !!response.data.success;
  } catch (err) {
    console.error('Cloudflare Turnstile verification failed:', err.message);
    return false;
  }
};
