import express from "express";
import { protect } from "../middlewares/auth.middleware.js";
import { searchMessagesHandler, searchEmailsHandler } from "../controllers/search.controller.js";

const router = express.Router();

// All search routes require authentication
router.use(protect);

/**
 * @route  GET /api/v1/search/messages
 * @desc   Full-text search across all connected mailbox messages for the authenticated user
 * @query  q - search query
 * @query  senderId - filter by sender account
 * @query  isRead - filter by read status (true/false)
 * @query  hasAttachments - filter by attachments (true/false)
 * @query  page - page number (default: 1)
 * @query  limit - results per page (default: 20)
 */
router.get("/messages", searchMessagesHandler);

/**
 * @route  GET /api/v1/search/emails
 * @desc   Full-text search across campaign emails for the authenticated user
 * @query  q - search query
 * @query  campaignId - filter to a specific campaign
 * @query  status - filter by email status (sent, opened, clicked, etc.)
 * @query  page - page number (default: 1)
 * @query  limit - results per page (default: 20)
 */
router.get("/emails", searchEmailsHandler);

export default router;
