import { google } from "googleapis";

export const testGmailConnection = async ({ accessToken }) => {
  try {
    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials({ access_token: accessToken });

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    // Test by getting profile
    const response = await gmail.users.getProfile({ userId: "me" });

    return {
      success: true,
      email: response.data.emailAddress,
      message: "Gmail connection successful",
    };
  } catch (error) {
    const message = error.response?.data?.error?.message || error.message;
    throw new Error(`Gmail API Verification Failed: ${message}`);
  }
};
