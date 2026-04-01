import {
  searchMessages,
  searchEmails,
  searchContacts,
  searchLeads,
  searchCampaigns,
} from "../services/elasticsearch.service.js";
import AppError from "../utils/app-error.js";

// ─── Helper ───────────────────────────────────────────────────────────────────

const paginate = (query) => {
  const page  = Math.max(1, parseInt(query.page  || 1));
  const limit = Math.min(50, Math.max(1, parseInt(query.limit || 20)));
  return { from: (page - 1) * limit, size: limit, page, limit };
};

const respond = (res, result, page, limit) =>
  res.success({
    results: result.hits,
    total:   result.total,
    page,
    limit,
    pages: Math.ceil(result.total / limit),
  });

// ─── GET /api/v1/search/messages ─────────────────────────────────────────────

export async function searchMessagesHandler(req, res, next) {
  try {
    const { q, senderId, isRead, hasAttachments } = req.query;
    const userId = req.user.id;
    if (!q && !senderId) throw new AppError("Provide q or senderId.", 400);

    const { from, size, page, limit } = paginate(req.query);
    const result = await searchMessages({
      userId, query: q, senderId,
      isRead:          isRead          !== undefined ? isRead          === "true" : undefined,
      hasAttachments:  hasAttachments  !== undefined ? hasAttachments  === "true" : undefined,
      from, size,
    });
    respond(res, result, page, limit);
  } catch (err) { next(err); }
}

// ─── GET /api/v1/search/emails ────────────────────────────────────────────────

export async function searchEmailsHandler(req, res, next) {
  try {
    const { q, campaignId, status } = req.query;
    const userId = req.user.id;
    if (!q && !campaignId) throw new AppError("Provide q or campaignId.", 400);

    const { from, size, page, limit } = paginate(req.query);
    const result = await searchEmails({ userId, query: q, campaignId, status, from, size });
    respond(res, result, page, limit);
  } catch (err) { next(err); }
}

// ─── GET /api/v1/search/contacts ─────────────────────────────────────────────

export async function searchContactsHandler(req, res, next) {
  try {
    const { q, status } = req.query;
    const userId = req.user.id;
    if (!q) throw new AppError("Provide a search query (q).", 400);

    const { from, size, page, limit } = paginate(req.query);
    const result = await searchContacts({ userId, query: q, status, from, size });
    respond(res, result, page, limit);
  } catch (err) { next(err); }
}

// ─── GET /api/v1/search/leads ────────────────────────────────────────────────

export async function searchLeadsHandler(req, res, next) {
  try {
    const { q, stageId } = req.query;
    const userId = req.user.id;
    if (!q) throw new AppError("Provide a search query (q).", 400);

    const { from, size, page, limit } = paginate(req.query);
    const result = await searchLeads({ userId, query: q, stageId, from, size });
    respond(res, result, page, limit);
  } catch (err) { next(err); }
}

// ─── GET /api/v1/search/campaigns ────────────────────────────────────────────

export async function searchCampaignsHandler(req, res, next) {
  try {
    const { q, status } = req.query;
    const userId = req.user.id;
    if (!q) throw new AppError("Provide a search query (q).", 400);

    const { from, size, page, limit } = paginate(req.query);
    const result = await searchCampaigns({ userId, query: q, status, from, size });
    respond(res, result, page, limit);
  } catch (err) { next(err); }
}
