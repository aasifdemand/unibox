import passport from "passport";
import { Strategy as LinkedInStrategy } from "passport-linkedin-oauth2";
import User from "../models/user.model.js";
import { Op } from "sequelize";

passport.use(
    new LinkedInStrategy({
        clientID: process.env.LINKEDIN_CLIENT_ID,
        clientSecret: process.env.LINKEDIN_CLIENT_SECRET,
        callbackURL: process.env.LINKEDIN_CALLBACK_URL,
    },
        async (accessToken, refreshToken, profile, done) => {
            try {
                const email = profile.emails[0].value;
                const name = profile.displayName;
                const linkedinId = profile.id;

                // Check if user exists with this email AND has a linkedinId
                let user = await User.findOne({
                    where: {
                        email,
                        linkedinId: { [Op.not]: null },
                    },
                });

                if (!user) {
                    // Check if email exists but with password (local user)
                    const existingLocalUser = await User.findOne({
                        where: {
                            email,
                            password: { [Op.not]: "LINKEDIN_AUTH" },
                        },
                    });

                    if (existingLocalUser) {
                        // This email is used by a local account - don't allow LinkedIn login
                        return done(null, false, {
                            message:
                                "This email is registered with password. Please login with your password.",
                        });
                    }

                    // Create new LinkedIn user
                    user = await User.create({
                        name,
                        email,
                        password: "LINKEDIN_AUTH",
                        role: "user",
                        linkedinId,
                        isVerified: true, // LinkedIn accounts are auto-verified
                        lastLoginAt: new Date(),
                    });
                } else {
                    // Update existing LinkedIn user
                    user.lastLoginAt = new Date();
                    await user.save();
                }

                return done(null, user);
            } catch (error) {
                return done(error, null);
            }
        },
    ),
);

export default passport;
