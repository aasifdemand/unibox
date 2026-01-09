import { Router } from "express";
import { protect } from "../middlewares/auth.middleware.js";
import {
  activateCampaign,
  createCampaign,
  pauseCampaign,
  resumeCampaign,
} from "../controllers/campaign.controller.js";

const router = Router();

router.post("/create",protect,createCampaign)

router.post("/:id/activate", protect, activateCampaign);
router.post("/:id/pause", protect, pauseCampaign);
router.post("/:id/resume", protect, resumeCampaign);

export default router;
