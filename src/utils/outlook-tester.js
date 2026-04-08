export const testOutlookConnection = async ({ accessToken }) => {
  try {
    // Test Outlook connection using Microsoft Graph API
    const response = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const message = errorData.error?.message || response.statusText;
      throw new Error(`Outlook API Verification Failed: ${message}`);
    }

    const data = await response.json();

    return {
      success: true,
      email: data.mail || data.userPrincipalName,
      message: "Outlook connection successful",
    };
  } catch (error) {
    throw new Error(error.message);
  }
};
