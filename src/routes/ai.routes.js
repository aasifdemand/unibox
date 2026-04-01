import express from "express";
import { generateSequence } from "../services/ai.service.js";
import { protect } from "../middlewares/auth.middleware.js";

const router = express.Router();

/**
 * Generate a multi-step email sequence.
 */
router.post("/generate-sequence", protect, async (req, res) => {
  try {
    const { goal, tone, stepsCount, variables } = req.body;
    
    if (!goal) {
      return res.status(400).json({ success: false, message: "Goal is required" });
    }

    const sequence = await generateSequence(goal, tone, stepsCount, variables);
    res.json({ success: true, data: sequence });
  } catch (error) {
    console.error("AI Route Error:", error);
    res.status(500).json({ success: false, message: "Failed to generate sequence via AI" });
  }
});

/**
 * Stream a multi-step email sequence.
 */
router.get("/generate-sequence-stream", protect, async (req, res) => {
  try {
    const { goal, tone, stepsCount, variables } = req.query;
    const parsedVariables = variables ? JSON.parse(variables) : [];
    
    if (!goal) {
      return res.status(400).json({ success: false, message: "Goal is required" });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    const bodyVariables = Array.isArray(parsedVariables) ? parsedVariables : [];
    const stream = await import("../services/ai.service.js").then(m => 
      m.generateSequenceStream(goal, tone, parseInt(stepsCount) || 3, bodyVariables)
    );

      // Support buffering for split chunks
      let buffer = '';
      stream.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep the partial line

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) {
            res.write(`data: ${trimmed}\n\n`);
          }
        }
      });

      stream.on('end', () => {
        if (buffer.trim()) {
          res.write(`data: ${buffer.trim()}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });

    stream.on("error", (err) => {
      console.error("Stream Error:", err);
      res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
      res.end();
    });

    // Handle client disconnect
    req.on("close", () => {
      if (stream.destroy) stream.destroy();
    });

    } catch (error) {
    console.error("AI Stream Route Error:", error);
    // If we haven't written anything to the client yet, send a JSON error
    if (!res.headersSent) {
      res.status(500).json({ 
        success: false, 
        message: error.code === 'ECONNREFUSED' 
          ? "Ollama service is not running. Please start Ollama to use AI features." 
          : "Failed to initialize AI stream" 
      });
    } else {
      // If we already started the stream, send an SSE error event
      res.write(`event: error\ndata: ${JSON.stringify({ 
        message: error.code === 'ECONNREFUSED' 
          ? "Ollama service is not running. Please start Ollama." 
          : "Stream generation failed" 
      })}\n\n`);
      res.end();
    }
  }
});

export default router;
