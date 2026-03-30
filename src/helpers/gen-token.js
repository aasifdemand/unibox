import jwt from "jsonwebtoken";

export const genAccessToken = (userId) => {
  try {
    return jwt.sign({ id: userId }, process.env.ACCESS_TOKEN_SECRET || process.env.JWT_SECRET, {
      expiresIn: "15m",
    });
  } catch (error) {
    throw new Error("Access token generation failed: " + error.message);
  }
};

export const genRefreshToken = (userId) => {
  try {
    return jwt.sign({ id: userId }, process.env.REFRESH_TOKEN_SECRET || process.env.JWT_SECRET, {
      expiresIn: "7d",
    });
  } catch (error) {
    throw new Error("Refresh token generation failed: " + error.message);
  }
};