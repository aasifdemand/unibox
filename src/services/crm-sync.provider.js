import { Integration } from "../models/index.js";
import { getValidOAuthToken } from "./integration.service.js";
import fetch from "node-fetch";
import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL);
const SYNC_DEBOUNCE_SEC = 300; // 5 minutes

/**
 * Pushes a contact to HubSpot using the user's stored Private App Token.
 */
const syncToHubSpot = async (apiKey, email, event, properties) => {
  try {
    // 1. Check if contact exists
    const searchRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }] })
    });
    
    const searchData = await searchRes.json();
    let contactId = searchData.results && searchData.results.length > 0 ? searchData.results[0].id : null;

    if (!contactId) {
      // 2. Create Contact
      const createRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ properties: { email, ...properties } })
      });
      if (createRes.ok) {
         const createData = await createRes.json();
         contactId = createData.id;
      } else {
         console.error("HubSpot Create Error:", await createRes.text());
      }
    } else {
      // 3. Update Contact
      if (Object.keys(properties).length > 0) {
        await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`, {
          method: "PATCH",
          headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ properties })
        });
      }
    }
    return { success: true };
  } catch (error) {
    console.error("HubSpot Sync Exception:", error.message);
    return { success: false, error: error.message };
  }
};

/**
 * Pushes a contact to Salesforce using the user's stored OAuth Token.
 */
const syncToSalesforce = async (token, instanceUrl, email, event, properties) => {
  try {
    const query = `SELECT Id FROM Contact WHERE Email = '${email}'`;
    const searchRes = await fetch(`${instanceUrl}/services/data/v58.0/query/?q=${encodeURIComponent(query)}`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${token}` }
    });
    
    const searchData = await searchRes.json();
    let contactId = searchData.records && searchData.records.length > 0 ? searchData.records[0].Id : null;

    // Map Unibox generic properties to Salesforce fields
    const sfProperties = {
       Description: `Unibox Last Event: ${event}\n${JSON.stringify(properties)}`
    };

    if (!contactId) {
      // Create Contact (Salesforce requires LastName)
      const createRes = await fetch(`${instanceUrl}/services/data/v58.0/sobjects/Contact`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ 
           Email: email, 
           LastName: email.split('@')[0] || "Unknown", 
           ...sfProperties 
        })
      });
      if (!createRes.ok) console.error("Salesforce Create Error:", await createRes.text());
    } else {
      // Update Contact
      const updateRes = await fetch(`${instanceUrl}/services/data/v58.0/sobjects/Contact/${contactId}`, {
         method: "PATCH",
         headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
         body: JSON.stringify(sfProperties)
      });
      if (!updateRes.ok) console.error("Salesforce Update Error:", await updateRes.text());
    }
    return { success: true };
  } catch (error) {
    console.error("Salesforce Sync Exception:", error.message);
    return { success: false, error: error.message };
  }
};

/**
 * Pushes the lead to ALL CRMs connected by this user.
 */
export const syncLeadToAllCRMs = async (userId, email, event, customPayload = {}) => {
  try {
    const activeIntegrations = await Integration.findAll({
      where: { userId, status: "connected" }
    });

    if (activeIntegrations.length === 0) return;

    // Define properties to send
    const properties = {
       lifecyclestage: 'lead',
       unibox_last_event: event,
       ...customPayload
    };

// Process all connections in parallel
    const promises = activeIntegrations.map(async (int) => {
       try {
         // --- DEBOUNCE LOGIC ---
         const debounceKey = `sync_debounce:${userId}:${int.id}:${email}`;
         const isDebounced = await redis.get(debounceKey);
         if (isDebounced) {
           console.log(`⏳ Sync to ${int.service} debounced for ${email}`);
           return;
         }
         // -----------------------

         // Get valid OAuth token (handles refreshing automatically)
         const token = await getValidOAuthToken(userId, int.service);
         if (!token) throw new Error("Could not retrieve valid OAuth token.");

         let result = { success: false };
         if (int.service === "hubspot") {
            result = await syncToHubSpot(token, email, event, properties);
         } else if (int.service === "salesforce" && int.credentials.instanceUrl) {
            result = await syncToSalesforce(token, int.credentials.instanceUrl, email, event, properties);
         }
         
         if (result.success) {
            await int.update({ 
               lastSyncAt: new Date(), 
               syncStatus: "healthy",
               lastError: null
            });
            // Set debounce after successful sync
            await redis.set(debounceKey, "1", "EX", SYNC_DEBOUNCE_SEC);
         } else {
            await int.update({ 
               syncStatus: "error",
               lastError: result.error || "Unknown synchronization error"
            });
         }
       } catch (err) {
         console.error(`Error syncing to ${int.service} for user ${userId}:`, err.message);
         await int.update({ 
           syncStatus: "error",
           lastError: err.message
         });
       }
    });

    await Promise.allSettled(promises);
  } catch (error) {
    console.error("syncLeadToAllCRMs failure:", error.message);
  }
};
