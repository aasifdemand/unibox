import { Integration } from "../models/index.js";
import fetch from "node-fetch";

const APP_URL = process.env.APP_URL || "http://localhost:8080";


// Map of config environments per provider
const PROVIDERS = {
  hubspot: {
    client_id: process.env.HUBSPOT_CLIENT_ID,
    client_secret: process.env.HUBSPOT_CLIENT_SECRET,
    authUrl: "https://app.hubspot.com/oauth/authorize",
    tokenUrl: "https://api.hubapi.com/oauth/v1/token",
    scope: "crm.objects.contacts.read crm.objects.contacts.write",
  },
  salesforce: {
    client_id: process.env.SALESFORCE_CLIENT_ID,
    client_secret: process.env.SALESFORCE_CLIENT_SECRET,
    authUrl: "https://login.salesforce.com/services/oauth2/authorize",
    tokenUrl: "https://login.salesforce.com/services/oauth2/token",
    scope: "api refresh_token offline_access",
  }
};

const getCallbackUrl = (service) => `${APP_URL}/api/v1/integrations/oauth/${service}/callback`;

/**
 * Generates the OAuth redirect URL for a provider and embeds the userId in the state parameter
 */
export const getOAuthUrl = (service, userId) => {
  const config = PROVIDERS[service];
  if (!config) throw new Error(`Integration provider '${service}' not supported.`);
  if (!config.client_id) throw new Error(`${service.toUpperCase()} Client ID is not configured on the server.`);

  const redirectUri = encodeURIComponent(getCallbackUrl(service));
  const scopes = encodeURIComponent(config.scope);

  // We pass userId in state so the callback knows which user this token applies to
  const state = userId;

  if (service === "hubspot") {
    return `${config.authUrl}?client_id=${config.client_id}&redirect_uri=${redirectUri}&scope=${scopes}&state=${state}`;
  }

  if (service === "salesforce") {
    return `${config.authUrl}?response_type=code&client_id=${config.client_id}&redirect_uri=${redirectUri}&scope=${scopes}&state=${state}`;
  }

  throw new Error(`Auth URL generation not implemented for ${service}`);
};

/**
 * Exchanges the authorization code for an access token and stores it in the database
 */
export const handleOAuthCallback = async (service, code, userId) => {
  const config = PROVIDERS[service];
  if (!config) throw new Error(`Integration provider '${service}' not found.`);

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.client_id,
    client_secret: config.client_secret,
    redirect_uri: getCallbackUrl(service),
    code: code, // from HubSpot redirect
  });

  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error(`[${service}] Token Exchange Error:`, data);
    throw new Error(data.message || data.error_description || "Failed to exchange OAuth token");
  }

  const credentials = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in || 1800, // Handle missing expires_in safely
    updatedAt: Date.now(),
  };

  if (service === "salesforce" && data.instance_url) {
    credentials.instanceUrl = data.instance_url;
  }

  // Upsert the integration row for this user
  const [integration, created] = await Integration.findOrCreate({
    where: { userId, service },
    defaults: {
      userId,
      service,
      type: "crm",
      authType: "oauth",
      status: "connected",
      credentials,
    },
  });

  if (!created) {
    await integration.update({ status: "connected", authType: "oauth", credentials });
  }

  return integration;
};

/**
 * Reads from DB, checks if token is expired, and uses refresh_token if needed.
 */
export const getValidOAuthToken = async (userId, service) => {
  const integration = await Integration.findOne({ where: { userId, service, status: "connected" } });

  if (!integration || !integration.credentials || integration.authType !== "oauth") {
    return null;
  }

  const config = PROVIDERS[service];
  const { credentials } = integration;
  const { accessToken, refreshToken, expiresIn, updatedAt } = credentials;

  // Add 5 min buffer to expiration check
  const isExpired = Date.now() - updatedAt >= (expiresIn - 300) * 1000;

  if (isExpired && refreshToken) {
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.client_id,
      client_secret: config.client_secret,
      refresh_token: refreshToken,
    });

    if (service === "hubspot") {
      // HubSpot sometimes strictly requires redirect_uri even for refresh tokens
      params.append("redirect_uri", getCallbackUrl(service));
    }

    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (response.ok) {
      const data = await response.json();
      const newCredentials = {
        ...credentials,
        accessToken: data.access_token,
        refreshToken: data.refresh_token || refreshToken, // fallback if provider doesn't rotate refreshToken
        expiresIn: data.expires_in || 1800,
        updatedAt: Date.now(),
      };
      await integration.update({ credentials: newCredentials });
      return newCredentials.accessToken;
    } else {
      // Token unrecoverable, require re-auth
      await integration.update({ status: "disconnected" });
      throw new Error(`Failed to refresh token for ${service}. User must reauthorize.`);
    }
  }

  return accessToken;
};
