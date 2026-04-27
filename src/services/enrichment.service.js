import fetch from "node-fetch";
import { Integration } from "../models/index.js";
import { decrypt } from "../utils/encryption.js";

/**
 * Retrieve the raw decrypted API key for a given integration service.
 */
const getApiKey = async (userId, service) => {
  const integration = await Integration.findOne({
    where: { userId, service, status: "connected" },
  });

  if (!integration) return null;

  const cred = integration.credentials;
  if (!cred?.apiKey) return null;

  // Decrypt if it's an encrypted object, otherwise return as-is
  if (typeof cred.apiKey === "object" && cred.apiKey.iv && cred.apiKey.content) {
    return decrypt(cred.apiKey);
  }
  return cred.apiKey;
};

/**
 * Enrich a contact using Apollo.io People Match API
 * Docs: https://apolloio.github.io/apollo-api-docs/?shell#people-enrichment
 */
const enrichWithApollo = async (apiKey, email) => {
  const response = await fetch("https://api.apollo.io/v1/people/match", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "X-Api-Key": apiKey,
    },
    body: JSON.stringify({
      email,
      reveal_personal_emails: false,
    }),
  });

  if (response.status === 429) throw new Error("Apollo rate limit reached. Please wait and try again.");
  if (!response.ok) {
    const text = await response.text();
    let errorMessage = text;
    try {
      const json = JSON.parse(text);
      errorMessage = json.error || json.message || text;
    } catch (e) { /* use raw text */ }
    throw new Error(`Apollo: ${errorMessage}`);
  }

  const data = await response.json();
  const person = data?.person;
  if (!person) return null;

  return {
    source: "apollo",
    name: [person.first_name, person.last_name].filter(Boolean).join(" ") || null,
    jobTitle: person.title || null,
    company: person.organization?.name || null,
    phone: person.phone_numbers?.[0]?.sanitized_number || null,
    city: person.city || null,
    country: person.country || null,
    website: person.linkedin_url || person.organization?.website_url || null,
    linkedin: person.linkedin_url || null,
    seniority: person.seniority || null,
    department: person.departments?.[0] || null,
  };
};

/**
 * Enrich a contact using Leadmagic Email API
 * Docs: https://docs.leadmagic.io/reference/email-enrichment
 */
const enrichWithLeadmagic = async (apiKey, email) => {
  const response = await fetch("https://api.leadmagic.io/email-validate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({ email }),
  });

  if (response.status === 429) throw new Error("Leadmagic rate limit reached. Please wait and try again.");
  if (response.status === 402) throw new Error("Leadmagic: Insufficient credits. Add credits at app.leadmagic.io/billing.");
  if (!response.ok) {
    const text = await response.text();
    let errorMessage = text;
    try {
      const json = JSON.parse(text);
      errorMessage = json.error || json.message || text;
    } catch (e) { /* use raw text */ }
    console.log();

    throw new Error(`Leadmagic: ${errorMessage},`);
  }

  const data = await response.json();
  if (!data || data.error) return null;

  return {
    source: "leadmagic",
    name: [data.first_name, data.last_name].filter(Boolean).join(" ") || null,
    jobTitle: data.job_title || null,
    company: data.company_name || null,
    phone: null,
    city: data.city || null,
    country: data.country || null,
    website: data.linkedin_url || data.company_website || null,
    linkedin: data.linkedin_url || null,
    companySize: data.company_size || null,
    industry: data.industry || null,
  };
};

/**
 * Main enrichment function: tries Apollo first, falls back to Leadmagic.
 * Returns enriched data plus the source used.
 */
export const enrichContact = async (userId, email) => {
  const results = [];
  const errors = [];

  // Try Apollo
  const apolloKey = await getApiKey(userId, "apollo");
  if (apolloKey) {
    try {
      const data = await enrichWithApollo(apolloKey, email);
      if (data) results.push(data);
    } catch (err) {
      errors.push({ provider: "apollo", error: err.message });
      console.warn(`[Enrichment] Apollo failed for ${email}:`, err.message);
    }
  }

  // Try Leadmagic
  const leadmagicKey = await getApiKey(userId, "leadmagic");
  if (leadmagicKey) {
    try {
      const data = await enrichWithLeadmagic(leadmagicKey, email);
      if (data) results.push(data);
    } catch (err) {
      errors.push({ provider: "leadmagic", error: err.message });
      console.warn(`[Enrichment] Leadmagic failed for ${email}:`, err.message);
    }
  }

  if (results.length === 0) {
    const clayKey = await getApiKey(userId, "clay");
    const instantlyKey = await getApiKey(userId, "instantly");

    if (!apolloKey && !leadmagicKey) {
      if (clayKey || instantlyKey) {
        throw new Error(
          `Clay and Instantly are data destinations (push-only) — they don't support contact lookups. Connect Apollo or Leadmagic to enrich contacts.`
        );
      }
      throw new Error("No enrichment providers connected. Please connect Apollo or Leadmagic in Integrations.");
    }
    if (errors.length > 0) {
      throw new Error(errors.map((e) => `${e.provider}: ${e.error}`).join("; "));
    }
    return null; // No data found but no hard error
  }

  // Merge results — first result is primary, fill missing fields from secondary
  const merged = { ...results[0] };
  if (results[1]) {
    Object.keys(results[1]).forEach((key) => {
      if (!merged[key] && results[1][key]) {
        merged[key] = results[1][key];
      }
    });
    merged.sources = results.map((r) => r.source);
  }

  return merged;
};
