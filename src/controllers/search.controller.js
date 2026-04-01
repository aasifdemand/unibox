import { searchMessages, searchEmails } from "../services/elasticsearch.service.js";
import AppError from "../utils/app-error.js";

// ─── GET /api/v1/search/messages ─────────────────────────────────────────────

export async function searchMessagesHandler(req, res, next) {
  try {
    const { q, senderId, isRead, hasAttachments, page = 1, limit = 20 } = req.query;
    const userId = req.user.id;

    if (!q && !senderId) {
      throw new AppError("Provide at least a search query (q) or senderId filter.", 400);
    }

    const from = (parseInt(page) - 1) * parseInt(limit);
    const size = parseInt(limit);

    const result = await searchMessages({
      userId,
      query: q,
      senderId,
      isRead: isRead !== undefined ? isRead === "true" : undefined,
      hasAttachments: hasAttachments !== undefined ? hasAttachments === "true" : undefined,
      from,
      size,
    });

    return res.success({
      results: result.hits,
      total: result.total,
      page: parseInt(page),
      limit: size,
      pages: Math.ceil(result.total / size),
    });
  } catch (err) {
    next(err);
  }
}

// ─── GET /api/v1/search/emails ────────────────────────────────────────────────

export async function searchEmailsHandler(req, res, next) {
  try {
    const { q, campaignId, status, page = 1, limit = 20 } = req.query;
    const userId = req.user.id;

    if (!q && !campaignId) {
      throw new AppError("Provide at least a search query (q) or campaignId filter.", 400);
    }

    const from = (parseInt(page) - 1) * parseInt(limit);
    const size = parseInt(limit);

    const result = await searchEmails({
      userId,
      query: q,
      campaignId,
      status,
      from,
      size,
    });

    return res.success({
      results: result.hits,
      total: result.total,
      page: parseInt(page),
      limit: size,
      pages: Math.ceil(result.total / size),
    });
  } catch (err) {
    next(err);
  }
}
