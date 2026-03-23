import express from "express";
import * as integrationController from "../controllers/integration.controller.js";
import { protect } from "../middlewares/auth.middleware.js";

const router = express.Router();

/**
 * @swagger
 * /api/v1/integrations:
 *   get:
 *     summary: Get all user integrations
 */
router.get("/", protect, integrationController.getIntegrations);

/**
 * @swagger
 * /api/v1/integrations:
 *   post:
 *     summary: Connect or update an integration
 */
router.post("/", protect, integrationController.connectIntegration);

/**
 * @swagger
 * /api/v1/integrations/{service}:
 *   delete:
 *     summary: Disconnect an integration
 */
router.delete("/:service", protect, integrationController.disconnectIntegration);

/**
 * @swagger
 * /api/v1/integrations/{service}/sync:
 *   post:
 *     summary: Trigger a manual sync for an integration
 */
router.post("/:service/sync", protect, integrationController.syncIntegration);

/**
 * @swagger
 * /api/v1/integrations/oauth/{service}:
 *   get:
 *     summary: Redirects to the OAuth provider (e.g. hubspot)
 */
router.get("/oauth/:service", protect, integrationController.oauthRedirect);

/**
 * @swagger
 * /api/v1/integrations/oauth/{service}/callback:
 *   get:
 *     summary: OAuth callback to exchange authorization code for access tokens
 */
router.get("/oauth/:service/callback", integrationController.oauthCallback);

export default router;
