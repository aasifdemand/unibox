import express from "express";
import { generateSequence } from "../services/ai.service.js";
import { protect } from "../middlewares/auth.middleware.js";

const router = express.Router();

/**
 * Generate a multi-step email sequence.
 */
router.post("/generate-sequence", protect, async (req, res) => {
  try {
    const { goal, tone, stepsCount } = req.body;
    
    if (!goal) {
      return res.status(400).json({ success: false, message: "Goal is required" });
    }

    const sequence = await generateSequence(goal, tone, stepsCount);
    res.json({ success: true, data: sequence });
  } catch (error) {
    console.error("AI Route Error:", error);
    res.status(500).json({ success: false, message: "Failed to generate sequence via AI" });
  }
});

export default router;
