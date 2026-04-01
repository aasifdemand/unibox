import { SmtpSender, WarmupMessage } from "../models/index.js";
import { refreshGoogleToken } from "../utils/refresh-google-token.js";
import { getValidMicrosoftToken } from "../utils/get-valid-microsoft-token.js";
import { createImapConnection } from "../utils/imap-helper.js";
import { google } from "googleapis";
import sequelize from "../config/db.js";
import { Op } from "sequelize";
import axios from "axios";
import { QUEUES } from "../queues/queues.js";
import { getRabbitChannel as getChannel } from "../queues/rabbit.js";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "phi2";

class ActiveWarmupService {
  /**
   * Generates benign, human-looking email content using AI.
   */
  async generateWarmupContent() {
    const prompt = `Generate a short, professional, and very casual email between two colleagues or acquaintances.
    Topics could be: weather, weekend plans, a quick question about a generic tech topic, or a follow-up on an imaginary non-sales meeting.
    
    Guidelines:
    - Subject must be short (2-4 words).
    - Body must be 2-3 sentences.
    - NO links, NO sales pitch, NO attachments.
    - Use a friendly but professional tone.
    
    Output format: JSON object {"subject": "...", "body": "..."}`;

    try {
      const response = await axios.post(`${OLLAMA_BASE_URL}/api/generate`, {
        model: OLLAMA_MODEL,
        prompt: prompt,
        stream: false,
        format: "json"
      });

      const content = JSON.parse(response.data.response);
      return content;
    } catch (error) {
      console.error("Warmup AI Content Generation Failed:", error.message);
      return {
        subject: "Quick question regarding our sync",
        body: "Hey there, just wanted to follow up on our discussion from earlier. Let me know if you have a moment to chat tomorrow morning. Best."
      };
    }
  }

  /**
   * Generates a short, benign reply to a warmup email.
   */
  async generateWarmupReply(originalSubject, originalBody) {
    const prompt = `You are a professional colleague. I will give you a short email subject and body. 
    Generate a very short, casual reply (1 sentence).
    Examples: "Thanks for letting me know!", "Sounds great, looking forward to it.", "I'll check this and get back to you soon."
    
    Original Subject: ${originalSubject}
    Original Body: ${originalBody}
    
    Output format: JSON object {"body": "..."}`;

    try {
      const response = await axios.post(`${OLLAMA_BASE_URL}/api/generate`, {
        model: OLLAMA_MODEL,
        prompt: prompt,
        stream: false,
        format: "json"
      });

      const content = JSON.parse(response.data.response);
      return content.body;
    } catch (error) {
      console.error("Warmup AI Reply Generation Failed:", error.message);
      return "Thanks for the update, sounds good!";
    }
  }

  /**
   * Picks a random "target" mailbox from the warmup-enabled pool.
   * Prioritize SMTP accounts as per user request.
   */
  async pickTarget(sender) {
    // 1. Try to find another SMTP sender from the same user (safest loop)
    const peerSmtp = await SmtpSender.findOne({
      where: {
        userId: sender.userId,
        id: { [Op.ne]: sender.id },
        warmupEnabled: true,
        isVerified: true
      },
      order: sequelize.random()
    });

    if (peerSmtp) return { id: peerSmtp.id, type: "smtp", email: peerSmtp.email };

    // 2. If no other SMTP on same user, try any SMTP from any user (Global Pool)
    // NOTE: In production, you'd want to ensure privacy/security here.
    const globalSmtp = await SmtpSender.findOne({
      where: {
        id: { [Op.ne]: sender.id },
        warmupEnabled: true,
        isVerified: true
      },
      order: sequelize.random()
    });

    if (globalSmtp) return { id: globalSmtp.id, type: "smtp", email: globalSmtp.email };

    return null; // No peer found
  }

  /**
   * Orchestrates a single warmup send.
   */
  async triggerWarmupSend(sender) {
    const target = await this.pickTarget(sender);
    if (!target) return;

    const { subject, body } = await this.generateWarmupContent();

    const channel = await getChannel();

    // We reuse the existing EMAIL_SEND queue but with 
    // a 'warmup' flag in metadata to avoid stats corruption
    channel.sendToQueue(QUEUES.EMAIL_SEND, Buffer.from(JSON.stringify({
      senderId: sender.id,
      senderType: sender.type || "smtp",
      recipientEmail: target.email,
      subject,
      htmlBody: body,
      isWarmup: true,
      metadata: {
        warmup: true,
        targetEmail: target.email
      }
    })), { persistent: true });

    // 4. Log the warmup message for monitoring loop
    await WarmupMessage.create({
      senderId: sender.id,
      senderEmail: sender.email,
      recipientId: target.id,
      recipientEmail: target.email,
      subject,
      body,
      status: "sent"
    });

    console.log(`[Warmup] Queued warmup from ${sender.email} to ${target.email}`);
  }

  /**
   * Marks a message as read in the provider's system.
   */
  async markAsRead(mailbox, type, messageId) {
    if (type === "gmail") {
      const token = await refreshGoogleToken(mailbox);
      const gmail = this._getGmailClient(token.accessToken);
      await gmail.users.messages.modify({ userId: "me", id: messageId, requestBody: { removeLabelIds: ["UNREAD"] } });
    } else if (type === "outlook") {
      const token = await getValidMicrosoftToken(mailbox);
      await axios.patch(`https://graph.microsoft.com/v1.0/me/messages/${messageId}`, { isRead: true }, { headers: { Authorization: `Bearer ${token}` } });
    } else if (type === "smtp") {
      const imap = await createImapConnection(mailbox);
      return new Promise((res, rej) => {
        imap.addFlags(messageId, "\\Seen", (err) => { imap.end(); if (err) rej(err); else res(true); });
      });
    }
  }

  /**
   * Rescues an email from Spam and moves it to the primary Inbox.
   */
  async moveToInbox(mailbox, type, messageId) {
    if (type === "gmail") {
      const token = await refreshGoogleToken(mailbox);
      const gmail = this._getGmailClient(token.accessToken);
      await gmail.users.messages.modify({ userId: "me", id: messageId, requestBody: { removeLabelIds: ["SPAM"], addLabelIds: ["INBOX"] } });
    } else if (type === "outlook") {
      const token = await getValidMicrosoftToken(mailbox);
      // Move to 'inbox' well-known folder
      await axios.post(`https://graph.microsoft.com/v1.0/me/messages/${messageId}/move`, { destinationId: "inbox" }, { headers: { Authorization: `Bearer ${token}` } });
    } else if (type === "smtp") {
      const imap = await createImapConnection(mailbox);
      return new Promise((res, rej) => {
        // We might need to know the 'Spam' folder name, but typically we move to 'INBOX'
        imap.move(messageId, "INBOX", (err) => { imap.end(); if (err) rej(err); else res(true); });
      });
    }
  }

  _getGmailClient(accessToken) {
    const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_CALLBACK_URL_SENDER);
    oauth2Client.setCredentials({ access_token: accessToken });
    return google.gmail({ version: "v1", auth: oauth2Client });
  }
}

export const activeWarmupService = new ActiveWarmupService();
