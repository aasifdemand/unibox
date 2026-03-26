import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3";

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
  const varString = variables.length > 0
    ? variables.map(v => `{{${v}}}`).join(", ")
    : "{{first_name}}, {{company}}, {{sender_name}}, {{job_title}}, {{city}}";

  const prompt = `You are an expert sales Copywriter specialized in outbound email sequences.
Goal: ${goal}. Tone: ${tone}. Steps: ${stepsCount}. 
Available Variables: ${varString}. 

Task: Create a ${stepsCount}-step email sequence:
1. Step 1 (Hook): Must be high-impact, personalized using variables, and focus on a problem-solution fit.
2. Steps 2+ (Follow-ups): Must be short, concise (2-3 sentences max), and continue the thread of the first email naturally. 

Persona Guidelines:
- Avoid overly formal/robotic salutations, but ALWAYS include a professional sign-off (e.g. Best regards, Cheers, etc.) followed by {{sender_name}}.
- Weave variables into sentences naturally—don't just list them.
- Use {{sl_time_of_day}} and {{sl_day_of_week}} for context.

Output: Return ONLY a JSON array of ${stepsCount} objects: [{"subject": "...", "body": "..."}].
NO commentary. NO markdown. JUST RAW JSON.`;

  try {
    console.log(`Attempting sequence generation with Ollama (${OLLAMA_MODEL}) - Steps: ${stepsCount}...`);
    const text = await callOllama(prompt, true);
    return extractJson(text);
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

  const prompt = `You are an expert sales Copywriter specialized in outbound email sequences.
Goal: ${goal}. Tone: ${tone}. Steps: ${stepsCount}. 
Available Variables: ${varString}. 

Task: Create a ${stepsCount}-step email sequence:
1. Step 1 (Hook): Must be high-impact, personalized using variables, and focus on a problem-solution fit.
2. Steps 2+ (Follow-ups): Must be short, concise (2-3 sentences max), and continue the thread of the first email naturally. 

Persona Guidelines:
- Avoid overly formal/robotic salutations, but ALWAYS include a professional sign-off (e.g. Best regards, Cheers, etc.) followed by {{sender_name}}.
- Weave variables into sentences naturally—don't just list them.
- Use {{sl_time_of_day}} and {{sl_day_of_week}} for context.

Output: Return ONLY a JSON array of ${stepsCount} objects: [{"subject": "...", "body": "..."}].
NO commentary. NO markdown. JUST RAW JSON.`;

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
    console.error("AI Streaming Generation Failed:", error.message);
    throw error;
  }
};
