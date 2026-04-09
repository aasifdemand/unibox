import express from "express";
import { protect } from "../middlewares/auth.middleware.js";
import {
  searchMessagesHandler,
  searchEmailsHandler,
  searchContactsHandler,
  searchLeadsHandler,
  searchCampaignsHandler,
  syncContactsHandler,
} from "../controllers/search.controller.js";

const router = express.Router();

// All search routes require authentication
router.use(protect);

// GET /api/v1/search/messages   — full-text search across all synced mailbox messages
router.get("/messages",  searchMessagesHandler);

// GET /api/v1/search/emails     — full-text search across campaign emails
router.get("/emails",    searchEmailsHandler);

// GET /api/v1/search/contacts   — full-text search across uploaded contacts/audience
router.get("/contacts",  searchContactsHandler);

// GET /api/v1/search/leads      — full-text search across CRM leads
router.get("/leads",     searchLeadsHandler);

// GET /api/v1/search/campaigns  — full-text search across campaigns (name, subject, body)
router.get("/campaigns", searchCampaignsHandler);

// POST /api/v1/search/sync-contacts — one-time sync of all database contacts to ES
router.post("/sync-contacts", syncContactsHandler);

export default router;
