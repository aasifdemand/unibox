import getElasticsearchClient from "../config/elasticsearch.js";

// ─── Index Definitions ───────────────────────────────────────────────────────
// Prefixed with "unibox_" to avoid conflicts with other apps on the shared ES cluster

export const INDICES = {
  MESSAGES:  "unibox_mailbox_messages",
  EMAILS:    "unibox_campaign_emails",
  CONTACTS:  "unibox_contacts",
  LEADS:     "unibox_leads",
  CAMPAIGNS: "unibox_campaigns",
};

// ─── Mappings ─────────────────────────────────────────────────────────────────

const SETTINGS = { number_of_shards: 1, number_of_replicas: 0 };

const MESSAGE_MAPPING = {
  settings: SETTINGS,
  mappings: {
    properties: {
      id:                { type: "keyword" },
      userId:            { type: "keyword" },
      senderId:          { type: "keyword" },
      senderType:        { type: "keyword" },
      folderId:          { type: "keyword" },
      providerMessageId: { type: "keyword" },
      providerThreadId:  { type: "keyword" },
      subject:           { type: "text", analyzer: "english" },
      from:              { type: "text", fields: { keyword: { type: "keyword" } } },
      to:                { type: "text", fields: { keyword: { type: "keyword" } } },
      snippet:           { type: "text", analyzer: "english" },
      isRead:            { type: "boolean" },
      hasAttachments:    { type: "boolean" },
      date:              { type: "date" },
      createdAt:         { type: "date" },
    },
  },
};

const EMAIL_MAPPING = {
  settings: SETTINGS,
  mappings: {
    properties: {
      id:             { type: "keyword" },
      userId:         { type: "keyword" },
      campaignId:     { type: "keyword" },
      senderId:       { type: "keyword" },
      senderType:     { type: "keyword" },
      recipientEmail: { type: "keyword" },
      subject:        { type: "text", analyzer: "english" },
      textBody:       { type: "text", analyzer: "english" },
      status:         { type: "keyword" },
      sentAt:         { type: "date" },
      openedAt:       { type: "date" },
      clickedAt:      { type: "date" },
      repliedAt:      { type: "date" },
      createdAt:      { type: "date" },
    },
  },
};

const CONTACT_MAPPING = {
  settings: SETTINGS,
  mappings: {
    properties: {
      id:              { type: "keyword" },
      userId:          { type: "keyword" },
      batchId:         { type: "keyword" },
      rawEmail:        { type: "keyword" },
      normalizedEmail: { type: "keyword" },
      domain:          { type: "keyword" },
      name:            { type: "text", fields: { keyword: { type: "keyword" } } },
      status:          { type: "keyword" },
      // metadata fields flattened at index time for easy search
      company:         { type: "text", fields: { keyword: { type: "keyword" } } },
      phone:           { type: "keyword" },
      title:           { type: "text" },
      createdAt:       { type: "date" },
    },
  },
};

const LEAD_MAPPING = {
  settings: SETTINGS,
  mappings: {
    properties: {
      id:             { type: "keyword" },
      userId:         { type: "keyword" },
      contactId:      { type: "keyword" },
      stageId:        { type: "keyword" },
      stageName:      { type: "keyword" },
      value:          { type: "float" },
      // denormalised from contact for fast search
      email:          { type: "keyword" },
      name:           { type: "text", fields: { keyword: { type: "keyword" } } },
      company:        { type: "text", fields: { keyword: { type: "keyword" } } },
      lastActivityAt: { type: "date" },
      createdAt:      { type: "date" },
    },
  },
};

const CAMPAIGN_MAPPING = {
  settings: SETTINGS,
  mappings: {
    properties: {
      id:        { type: "keyword" },
      userId:    { type: "keyword" },
      name:      { type: "text", analyzer: "english", fields: { keyword: { type: "keyword" } } },
      subject:   { type: "text", analyzer: "english" },
      textBody:  { type: "text", analyzer: "english" },
      status:    { type: "keyword" },
      createdAt: { type: "date" },
      updatedAt: { type: "date" },
    },
  },
};

// ─── Ensure Indices Exist ─────────────────────────────────────────────────────

export async function initIndices() {
  const es = getElasticsearchClient();
  if (!es) return;

  const indices = [
    { name: INDICES.MESSAGES,  body: MESSAGE_MAPPING  },
    { name: INDICES.EMAILS,    body: EMAIL_MAPPING    },
    { name: INDICES.CONTACTS,  body: CONTACT_MAPPING  },
    { name: INDICES.LEADS,     body: LEAD_MAPPING     },
    { name: INDICES.CAMPAIGNS, body: CAMPAIGN_MAPPING },
  ];

  try {
    for (const { name, body } of indices) {
      const { body: exists } = await es.indices.exists({ index: name });
      if (!exists) {
        await es.indices.create({ index: name, body });
        console.log(`✅ ES index created: ${name}`);
      } else {
        console.log(`✔️  ES index already exists: ${name}`);
      }
    }
  } catch (err) {
    if (err.name === "ProductNotSupportedSecurityError") {
      console.warn(
        "⚠️  ES security error — the cluster may require credentials.\n" +
        "   → Set ELASTICSEARCH_USERNAME + ELASTICSEARCH_PASSWORD in .env\n" +
        "   → Or run: curl http://localhost:9201 to check if it returns 401"
      );
    } else {
      console.error("❌ ES initIndices failed:", err.message);
    }
  }
}

// ─── Generic Upsert / Delete ──────────────────────────────────────────────────

export async function upsertDocument(index, id, doc) {
  const es = getElasticsearchClient();
  if (!es) return;
  try {
    await es.index({ index, id, body: doc, refresh: true });
  } catch (err) {
    console.error(`❌ ES upsert failed [${index}/${id}]:`, err.message);
  }
}

export async function deleteDocument(index, id) {
  const es = getElasticsearchClient();
  if (!es) return;
  try {
    await es.delete({ index, id, refresh: true });
  } catch (err) {
    if (err.meta?.statusCode !== 404) {
      console.error(`❌ ES delete failed [${index}/${id}]:`, err.message);
    }
  }
}

// ─── Search Messages ──────────────────────────────────────────────────────────

export async function searchMessages({ userId, query, senderId, isRead, hasAttachments, from = 0, size = 20 } = {}) {
  const es = getElasticsearchClient();
  if (!es) return { hits: [], total: 0 };

  const must = [{ term: { userId } }];
  if (query) must.push({ multi_match: { query, fields: ["subject^3", "snippet^2", "from", "to"], fuzziness: "AUTO", type: "best_fields" } });

  const filter = [];
  if (senderId)            filter.push({ term: { senderId } });
  if (isRead !== undefined) filter.push({ term: { isRead } });
  if (hasAttachments !== undefined) filter.push({ term: { hasAttachments } });

  try {
    const { body: result } = await es.search({
      index: INDICES.MESSAGES, from, size,
      body: { query: { bool: { must, filter } }, sort: [{ date: { order: "desc" } }], highlight: { fields: { subject: {}, snippet: {} } } },
    });
    return { hits: result.hits.hits.map((h) => ({ ...h._source, _highlights: h.highlight })), total: result.hits.total.value };
  } catch (err) {
    console.error("❌ ES search failed [messages]:", err.message);
    return { hits: [], total: 0 };
  }
}

// ─── Search Campaign Emails ───────────────────────────────────────────────────

export async function searchEmails({ userId, query, campaignId, status, from = 0, size = 20 } = {}) {
  const es = getElasticsearchClient();
  if (!es) return { hits: [], total: 0 };

  const must = [{ term: { userId } }];
  if (query) must.push({ multi_match: { query, fields: ["subject^3", "textBody^2", "recipientEmail"], fuzziness: "AUTO", type: "best_fields" } });

  const filter = [];
  if (campaignId) filter.push({ term: { campaignId } });
  if (status)     filter.push({ term: { status } });

  try {
    const { body: result } = await es.search({
      index: INDICES.EMAILS, from, size,
      body: { query: { bool: { must, filter } }, sort: [{ sentAt: { order: "desc" } }] },
    });
    return { hits: result.hits.hits.map((h) => h._source), total: result.hits.total.value };
  } catch (err) {
    console.error("❌ ES search failed [emails]:", err.message);
    return { hits: [], total: 0 };
  }
}

// ─── Search Contacts ──────────────────────────────────────────────────────────

export async function searchContacts({ userId, query, status, from = 0, size = 20 } = {}) {
  const es = getElasticsearchClient();
  if (!es) return { hits: [], total: 0 };

  const must = [{ term: { userId } }];
  if (query) must.push({ multi_match: { query, fields: ["name^3", "normalizedEmail^2", "company", "domain", "title"], fuzziness: "AUTO", type: "best_fields" } });

  const filter = [];
  if (status) filter.push({ term: { status } });

  try {
    const { body: result } = await es.search({
      index: INDICES.CONTACTS, from, size,
      body: { query: { bool: { must, filter } }, sort: [{ createdAt: { order: "desc" } }] },
    });
    return { hits: result.hits.hits.map((h) => h._source), total: result.hits.total.value };
  } catch (err) {
    console.error("❌ ES search failed [contacts]:", err.message);
    return { hits: [], total: 0 };
  }
}

// ─── Search Leads ─────────────────────────────────────────────────────────────

export async function searchLeads({ userId, query, stageId, from = 0, size = 20 } = {}) {
  const es = getElasticsearchClient();
  if (!es) return { hits: [], total: 0 };

  const must = [{ term: { userId } }];
  if (query) must.push({ multi_match: { query, fields: ["name^3", "email^2", "company", "stageName"], fuzziness: "AUTO", type: "best_fields" } });

  const filter = [];
  if (stageId) filter.push({ term: { stageId } });

  try {
    const { body: result } = await es.search({
      index: INDICES.LEADS, from, size,
      body: { query: { bool: { must, filter } }, sort: [{ lastActivityAt: { order: "desc" } }] },
    });
    return { hits: result.hits.hits.map((h) => h._source), total: result.hits.total.value };
  } catch (err) {
    console.error("❌ ES search failed [leads]:", err.message);
    return { hits: [], total: 0 };
  }
}

// ─── Search Campaigns ─────────────────────────────────────────────────────────

export async function searchCampaigns({ userId, query, status, from = 0, size = 20 } = {}) {
  const es = getElasticsearchClient();
  if (!es) return { hits: [], total: 0 };

  const must = [{ term: { userId } }];
  if (query) must.push({ multi_match: { query, fields: ["name^3", "subject^2", "textBody"], fuzziness: "AUTO", type: "best_fields" } });

  const filter = [];
  if (status) filter.push({ term: { status } });

  try {
    const { body: result } = await es.search({
      index: INDICES.CAMPAIGNS, from, size,
      body: { query: { bool: { must, filter } }, sort: [{ updatedAt: { order: "desc" } }] },
    });
    return { hits: result.hits.hits.map((h) => h._source), total: result.hits.total.value };
  } catch (err) {
    console.error("❌ ES search failed [campaigns]:", err.message);
    return { hits: [], total: 0 };
  }
}
