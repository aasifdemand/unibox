import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config();

// Create the client
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Robust model getter that uses the most stable alias for the user's key.
 */
const getModel = (jsonMode = false) => {
  const modelId = "gemini-flash-latest";
  
  if (jsonMode) {
    return genAI.getGenerativeModel({ 
      model: modelId,
      generationConfig: { responseMimeType: "application/json" }
    });
  }
  
  return genAI.getGenerativeModel({ model: modelId });
};

/**
 * Generate a sequence of emails based on a goal and tone.
 */
export const generateSequence = async (goal, tone = "professional", stepsCount = 3) => {
  const model = getModel(true); // Enable JSON mode
  
  const prompt = `
    You are an expert cold email copywriter. Generate a ${stepsCount}-step email sequence for the following goal: "${goal}".
    Tone: ${tone}
    
    Requirements:
    - Keep emails concise and human-like.
    - Use placeholders like {{first_name}}, {{company}}, {{sender_name}}.
    - Email 1: The Hook & Value Prop.
    - Email 2: Social Proof or Case Study.
    - Email 3: The Soft Breakup / Final Follow-up.
    
    Return the response as a JSON array of objects, each with 'subject' and 'body' (in HTML format).
    Example Schema:
    [
      {
        "subject": "Question for {{first_name}}",
        "body": "<p>Hello {{first_name}},...</p>"
      }
    ]
  `;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    
    // With JSON mode, it should be a pure JSON string
    try {
      return JSON.parse(text);
    } catch (parseError) {
      console.error("JSON Mode Parse Error, trying regex extraction:", parseError);
      const jsonMatch = text.match(/\[.*\]/s);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
      throw parseError;
    }
  } catch (error) {
    console.error("AI Sequence Generation Error:", error);
    
    // Fallback logic for any model-related errors
    if (error.status === 404 || error.status === 429 || error.message.includes("404") || error.message.includes("429")) {
      console.log("Primary model failed or quota exceeded, attempting gemini-pro-latest fallback...");
      try {
        const fallbackModel = genAI.getGenerativeModel({ 
          model: "gemini-pro-latest",
          generationConfig: { responseMimeType: "application/json" }
        });
        const result = await fallbackModel.generateContent(prompt);
        return JSON.parse(result.response.text());
      } catch (e2) {
        console.error("All AI models failed or were blocked by quota.");
        throw error;
      }
    }
    throw error;
  }
};

/**
 * Classify the intent of a recipient's reply.
 */
export const classifyIntent = async (replyContent) => {
  const model = getModel(); // No JSON mode needed for single string response

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
    const result = await model.generateContent(prompt);
    const intent = result.response.text().trim().toLowerCase();
    
    const validIntents = ["interested", "not_interested", "out_of_office", "wrong_person", "replied"];
    return validIntents.includes(intent) ? intent : "replied";
  } catch (error) {
    console.error("AI Intent Classification Error:", error);
    
    // Fallback for intent detection
    if (error.status === 404 || error.status === 429) {
      try {
        const fallbackModel = genAI.getGenerativeModel({ model: "gemini-pro-latest" });
        const result = await fallbackModel.generateContent(prompt);
        const intent = result.response.text().trim().toLowerCase();
        const validIntents = ["interested", "not_interested", "out_of_office", "wrong_person", "replied"];
        return validIntents.includes(intent) ? intent : "replied";
      } catch (retryError) {
        return "replied";
      }
    }
    return "replied"; // Safe fallback
  }
};
