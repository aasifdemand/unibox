import { Integration } from "../models/index.js";
import { encrypt } from "../utils/encryption.js";
import { getOAuthUrl, handleOAuthCallback } from "../services/integration.service.js";

/**
 * Get all integrations for the current user.
 * Sensitive data in credentials should be partially masked or removed for the frontend.
 */
export const getIntegrations = async (req, res) => {
  try {
    const userId = req.user.id;
    const integrations = await Integration.findAll({ where: { userId } });

    // Mask sensitive fields in the response
    const sanitized = integrations.map((item) => {
      const data = item.toJSON();
      if (data.authType === "api_key" && data.credentials?.apiKey) {
        data.credentials.apiKey = "****" + data.credentials.apiKey.content.slice(-4);
      }
      return data;
    });

    res.json({ success: true, data: sanitized });
  } catch (error) {
    console.error("Error fetching integrations:", error);
    res.status(500).json({ success: false, message: "Failed to fetch integrations" });
  }
};

/**
 * Connect or update an integration.
 */
export const connectIntegration = async (req, res) => {
  try {
    const userId = req.user.id;
    const { service, type, authType, credentials } = req.body;

    let processedCredentials = { ...credentials };

    // Encrypt API keys if present
    if (authType === "api_key" && credentials.apiKey) {
      processedCredentials.apiKey = encrypt(credentials.apiKey);
    }

    const [integration, created] = await Integration.findOrCreate({
      where: { userId, service },
      defaults: {
        userId,
        service,
        type,
        authType,
        credentials: processedCredentials,
        status: "connected",
      },
    });

    if (!created) {
      await integration.update({
        authType,
        type,
        credentials: processedCredentials,
        status: "connected",
      });
    }

    res.json({ success: true, data: integration, message: `Connected to ${service} successfully` });
  } catch (error) {
    console.error("Error connecting integration:", error);
    res.status(500).json({ success: false, message: "Failed to connect integration" });
  }
};

/**
 * Disconnect an integration.
 */
export const disconnectIntegration = async (req, res) => {
  try {
    const userId = req.user.id;
    const { service } = req.params;

    const integration = await Integration.findOne({ where: { userId, service } });

    if (!integration) {
      return res.status(404).json({ success: false, message: "Integration not found" });
    }

    await integration.destroy();

    res.json({ success: true, message: `Disconnected from ${service} successfully` });
  } catch (error) {
    console.error("Error disconnecting integration:", error);
    res.status(500).json({ success: false, message: "Failed to disconnect integration" });
  }
};

/**
 * Trigger a manual sync for an integration.
 */
export const syncIntegration = async (req, res) => {
  try {
    const userId = req.user.id;
    const { service } = req.params;

    const integration = await Integration.findOne({ where: { userId, service } });

    if (!integration) {
      return res.status(404).json({ success: false, message: "Integration not found" });
    }

    if (integration.status !== "connected") {
      return res.status(400).json({ success: false, message: "Integration is not connected" });
    }

    // Simulate syncing by updating the timestamp
    await integration.update({ lastSyncAt: new Date() });

    res.json({ success: true, message: `Successfully synced ${service}`, data: integration });
  } catch (error) {
    console.error("Error syncing integration:", error);
    res.status(500).json({ success: false, message: "Failed to trigger sync" });
  }
};

/**
 * Handle initiating OAuth flow by returning/redirecting to the provider URL
 */
export const oauthRedirect = async (req, res) => {
  try {
    const { service } = req.params;
    const userId = req.user.id;

    const url = getOAuthUrl(service, userId);
    // Unibox frontend opens this in the same tab or new window, so redirecting is correct
    // But since the frontend uses React, it's better if frontend redirects directly. We will simply redirect.
    res.redirect(url);
  } catch (error) {
    console.error(`OAuth Redirect Error for ${req.params.service}:`, error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Handle the OAuth callback from the provider
 */
export const oauthCallback = async (req, res) => {
  try {
    const { service } = req.params;
    const { code, state, error } = req.query;

    if (error) {
      console.error(`OAuth error from ${service}:`, req.query.error_description || error);
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard/integrations?error=${encodeURIComponent(error)}`);
    }

    if (!code || !state) {
      return res.status(400).json({ success: false, message: "Missing code or state parameter" });
    }

    const userId = state; // The state uniquely identifies the requesting user

    await handleOAuthCallback(service, code, userId);

    // Redirect the user back to the frontend integrations dashboard upon success
    res.redirect(`${process.env.FRONTEND_URL}/dashboard/integrations?success=true`);
  } catch (error) {
    console.error(`OAuth Callback Error for ${req.params.service}:`, error);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard/integrations?error=ConfigurationFailed`);
  }
};
