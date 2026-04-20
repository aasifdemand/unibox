import axios from "axios";

export const getValidMicrosoftToken = async (sender) => {
  const now = Date.now();

  // token still valid (5 min buffer)
  if (
    sender.accessToken && // ✅ FIXED: was oauthAccessToken
    sender.expiresAt && // ✅ FIXED: was oauthExpiresAt
    new Date(sender.expiresAt).getTime() > now + 5 * 60 * 1000
  ) {
    return sender.accessToken; // ✅ FIXED: was oauthAccessToken
  }

  try {
    const res = await axios.post(
      `https://login.microsoftonline.com/${process.env.MS_TENANT_ID || "common"}/oauth2/v2.0/token`,
      new URLSearchParams({
        client_id: process.env.MS_CLIENT_ID,
        client_secret: process.env.MS_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: sender.refreshToken,
        scope: "https://graph.microsoft.com/.default",
      }),
    );

    const { access_token, refresh_token, expires_in } = res.data;

    await sender.update({
      accessToken: access_token,
      refreshToken: refresh_token || sender.refreshToken,
      expiresAt: new Date(Date.now() + expires_in * 1000),
      isVerified: true,
      verificationError: null
    });

    return access_token;
  } catch (error) {
    const errorMsg = error.response?.data?.error_description || error.message || "Failed to refresh Microsoft token";
    console.error("❌ Microsoft token refresh error:", {
      id: sender.id,
      email: sender.email,
      error: errorMsg
    });

    await sender.update({
      isVerified: false,
      verificationError: errorMsg
    }).catch(e => console.error("Failed to update sender health:", e));

    return null;
  }
};
