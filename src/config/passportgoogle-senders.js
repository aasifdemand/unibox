import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { testGmailConnection } from "../utils/gmail-tester.js";

passport.use(
  "google-sender",
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: `${process.env.GOOGLE_CALLBACK_URL_SENDER}`,
      passReqToCallback: true,
    },
    async (req, accessToken, refreshToken, params, profile, done) => {
      try {
        // 1. Verify required scopes
        const grantedScopes = params.scope || "";
        const requiredScopes = [
          "gmail.readonly",
          "gmail.modify",
          "gmail.send"
        ];
        
        const missingScopes = requiredScopes.filter(s => !grantedScopes.includes(s));
        if (missingScopes.length > 0) {
          return done(new Error(`Missing required permissions: ${missingScopes.join(", ")}. Please ensure you check all permission boxes on the consent screen.`));
        }

        // 2. Verify Gmail API is enabled
        await testGmailConnection({ accessToken });

        // IMPORTANT: Google might return refreshToken in params
        const actualRefreshToken = refreshToken || params.refresh_token;

        // Extract user ID from state
        const state = req.query.state || "";
        const userId = state.replace("sender-", "");

        return done(null, {
          userId,
          email: profile.emails[0].value,
          displayName: profile.displayName,
          accessToken,
          refreshToken: actualRefreshToken,
          googleId: profile.id,
          profile: profile._json,
        });
      } catch (err) {
        return done(err);
      }
    },
  ),
);

export default passport;
