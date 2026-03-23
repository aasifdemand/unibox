import express from "express";
import * as crmController from "../controllers/crm.controller.js";
import { protect } from "../middlewares/auth.middleware.js";

const router = express.Router();

router.get("/pipeline", protect, crmController.getPipeline);
router.get("/reply-categories", protect, crmController.getReplyCategories);
router.post("/leads/move", protect, crmController.moveLead);
router.patch("/leads/:leadId", protect, crmController.updateLead);
router.post("/stages", protect, crmController.addStage);
router.put("/stages/reorder", protect, crmController.reorderStages);
router.delete("/stages/:stageId", protect, crmController.deleteStage);

export default router;
