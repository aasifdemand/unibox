import axios from "axios";
import dotenv from "dotenv";

import Redis from "ioredis";

dotenv.config();

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "phi3:mini"; // Upgrading to phi3:mini for better speed/quality
const redis = new Redis(process.env.REDIS_URL);

/**
 * Extract JSON from a string (handles markdown blocks or preamble).
 */
const extractJson = (text) => {
  if (!text || text.trim() === "") {
    throw new Error("AI returned an empty response.");
  }

  try {
    // Try direct parse first
    return JSON.parse(text);
  } catch (e) {
    console.log(e);

    // Try to find JSON block in markdown
    const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch (inner) {
        console.error("Failed to parse matched JSON block:", inner.message);
      }
    }

    // Try to find anything between [ ] or { }
    const bracketMatch = text.match(/\[[\s\S]*\]/) || text.match(/\{[\s\S]*\}/);
    if (bracketMatch) {
      try {
        return JSON.parse(bracketMatch[0]);
      } catch (inner) {
        console.error("Failed to parse bracketed content:", inner.message);
      }
    }

    console.error("Raw AI Response that failed parsing:", text);
    throw new Error("Could not extract valid JSON from AI response.");
  }
};

/**
 * Call local Ollama API.
 */
const callOllama = async (prompt, jsonMode = false) => {
  try {
    const response = await axios.post(`${OLLAMA_BASE_URL}/api/generate`, {
      model: OLLAMA_MODEL,
      prompt: prompt,
      stream: false,
      format: jsonMode ? "json" : undefined
    }, {
      timeout: 120000 // 120 seconds for slow models
    });
    return response.data.response;
  } catch (error) {
    if (error.code === 'ECONNABORTED') {
      console.error("Ollama Timeout: The model took too long to respond.");
      throw new Error("AI generation timed out. Please try again or use a simpler prompt.");
    }
    console.error("Ollama Error:", error.response?.data || error.message);
    throw error;
  }
};

/**
 * Generate a sequence of emails based on a goal and tone.
 */
export const generateSequence = async (goal, tone = "professional", stepsCount = 3, variables = []) => {
  // Incremented version to v2 to invalidate old incompatible cached sequences
  const cacheKey = `ai:seq:v2:${Buffer.from(`${goal}:${tone}:${stepsCount}`).toString("base64")}`;
  
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      console.log("⚡ AI Cache Hit: Returning cached sequence");
      return JSON.parse(cached);
    }
  } catch (err) {
    console.error("Redis Cache Error:", err.message);
  }

  const varString = variables.length > 0
    ? variables.map(v => `{{${v}}}`).join(", ")
    : "{{first_name}}, {{company}}, {{sender_name}}, {{job_title}}, {{city}}";

  const prompt = `Goal: ${goal}
Tone: ${tone}
Task: Write a ${stepsCount}-step sales sequence about this goal.
Variables: ${varString}
Format: Return ONLY a JSON array of objects with keys "subject" and "body".

Requirements for "body":
- Start with a salutation (e.g. "Hi {{first_name}},").
- Use multiple paragraphs with double newlines (\n\n).
- EVERY SINGLE STEP must end with a professional sign-off and {{sender_name}} (e.g. "Best,\n{{sender_name}}").
- Example: [{"subject":"hi","body":"Hi {{first_name}},\n\nI hope you're well.\n\n[Body...]\n\nBest,\n{{sender_name}}"}]`;

  try {
    console.log(`🚀 Generating sequence (${OLLAMA_MODEL})...`);
    const text = await callOllama(prompt, true);
    const result = extractJson(text);
    
    // Cache for 24 hours
    await redis.set(cacheKey, JSON.stringify(result), "EX", 86400);
    return result;
  } catch (error) {
    console.error("AI Generation Failed:", error.message);
    throw error;
  }
};

/**
 * Classify the intent of a recipient's reply.
 */
export const classifyIntent = async (replyContent) => {
  const prompt = `
    Analyze the following email reply and classify the sender's intent into exactly ONE of these categories:
    - interested: They want to chat, see a demo, or ask for more info.
    - not_interested: They explicitly say no, not interested, or "unsubscribed".
    - out_of_office: Auto-reply or they are away on vacation.
    - wrong_person: They suggest talking to someone else.
    - replied: Neutral reply or something that doesn't fit the above perfectly.

    Reply Content:
    """
    ${replyContent}
    """

    Return ONLY the category name as a plain string.
  `;

  try {
    console.log(`Attempting intent classification with Ollama (${OLLAMA_MODEL})...`);
    const intent = (await callOllama(prompt)).trim().toLowerCase();
    const validIntents = ["interested", "not_interested", "out_of_office", "wrong_person", "replied"];
    return validIntents.includes(intent) ? intent : "replied";
  } catch (error) {
    console.error("AI Intent Classification Failed:", error.message);
    return "replied"; // Safe fallback
  }
};

/**
 * Stream a sequence generation from Ollama.
 */
export const generateSequenceStream = async (goal, tone = "professional", stepsCount = 3, variables = []) => {
  const varString = variables.length > 0
    ? variables.map(v => `{{${v}}}`).join(", ")
    : "{{first_name}}, {{company}}, {{sender_name}}, {{job_title}}, {{city}}";

  const prompt = `Task: Create a ${stepsCount}-step sales email sequence.
Goal: ${goal}
Tone: ${tone}
Variables: ${varString}

Constraints:
- Step 1: Hook & Solution focus.
- Steps 2+: Short (2 sentences) thread follow-ups.
- ALWAYS sign off with {{sender_name}}.
- OUTPUT ONLY JSON ARRAY: [{"subject": "...", "body": "..."}]`;

  try {
    console.log(`Streaming sequence generation with Ollama (${OLLAMA_MODEL}) - Steps: ${stepsCount}...`);
    
    const response = await axios.post(`${OLLAMA_BASE_URL}/api/generate`, {
      model: OLLAMA_MODEL,
      prompt: prompt,
      stream: true,
      format: "json"
    }, {
      responseType: 'stream',
      timeout: 120000
    });

    return response.data; // This is a readable stream of Ollama response chunks
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      console.error("Ollama Connection Refused: Ensure Ollama is running on", OLLAMA_BASE_URL);
      throw new Error("Ollama service is not running. Please start it to use AI features.");
    }
    console.error("AI Streaming Generation Failed:", error.message);
    throw error;
  }
};
