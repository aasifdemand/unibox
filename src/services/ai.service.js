import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3";

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
    });
    return response.data.response;
  } catch (error) {
    console.error("Ollama Error:", error.message);
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

  const prompt = `
    You are an expert cold email copywriter. Generate a ${stepsCount}-step email sequence for the following goal: "${goal}".
    Tone: ${tone}
    
    Requirements:
    - Keep emails concise and human-like.
    - Use placeholders ONLY from this list: ${varString}.
    - Do NOT include a manual unsubscribe link; the system handles this automatically.
    - Use Spintax for variety, e.g., {Hi|Hello|Hey} {{first_name}}.
    - Use Smart Tags for context: {{sl_time_of_day}}, {{sl_day_of_week}}.
    
    Sequence Pattern:
    - Step 1: The Hook & Value Prop.
    ${stepsCount > 1 ? `- Steps 2 to ${stepsCount - 1}: Follow-ups with social proof, case studies, or different angles.` : ""}
    ${stepsCount > 1 ? `- Step ${stepsCount} (Final): The Soft Breakup / Final Follow-up.` : ""}
    
    Return the response as a JSON array of ${stepsCount} objects, each with 'subject' and 'body' (in HTML format).
    Example Schema:
    [
      {
        "subject": "Question for {{first_name}}",
        "body": "<p>Hello {{first_name}},...</p>"
      }
    ]
  `;

  try {
    console.log(`Attempting sequence generation with Ollama (${OLLAMA_MODEL}) - Steps: ${stepsCount}...`);
    const text = await callOllama(prompt, true);
    return JSON.parse(text);
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
