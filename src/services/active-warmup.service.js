import { SmtpSender, GmailSender, OutlookSender, WarmupMessage } from "../models/index.js";
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

const FALLBACK_CONTENT = [
  { 
    subject: "Quick catch up?", 
    body: "<p>I hope you're having a productive week so far.</p><p>Do you have 5 minutes to sync tomorrow morning about the latest updates from the team? I'd appreciate your perspective on the current progress.</p>" 
  },
  { 
    subject: "Question regarding the project", 
    body: "<p>I was just reviewing our current progress on the project roadmap.</p><p>Could you clarify the timeline for the next phase when you have a moment? I want to make sure we're fully aligned on the deliverables.</p>" 
  },
  { 
    subject: "Coffee next week?", 
    body: "<p>It's been a while since we caught up properly outside of our standard meetings.</p><p>Are you free for a quick coffee sometime next week? Let me know what your schedule looks like and we can find a time that works.</p>" 
  },
  { 
    subject: "Follow up on our discussion", 
    body: "<p>Just wanted to follow up on the specific points we discussed yesterday afternoon.</p><p>Everything seems to be moving in the right direction, but I'm happy to dive deeper into any of the items if you'd like.</p>" 
  },
  { 
    subject: "Great sync today", 
    body: "<p>It was great syncing with you earlier today. It's always helpful to get everyone on the same page.</p><p>I've noted down the action items we agreed upon and will get started on them shortly. I'll keep you posted on the progress.</p>" 
  },
  { 
    subject: "Quick question on the lunch", 
    body: "<p>Are we still on for lunch tomorrow at the usual spot?</p><p>I was thinking of trying that new place around the corner instead if you're up for it. Let me know what you think!</p>" 
  },
  { 
    subject: "Weekend plans", 
    body: "<p>Any exciting plans for the upcoming weekend?</p><p>I'm planning to head out of town for a bit of a hike if the weather holds up. Hope you have a great one regardless.</p>" 
  },
  { 
    subject: "Thoughts on the new layout", 
    body: "<p>Have you had a chance to look at the new dashboard layout yet?</p><p>I'd love to get your feedback on the usability before we finalize the changes next week. Whenever you have a spare moment.</p>" 
  },
  { 
    subject: "Documentation update", 
    body: "<p>I've just finished updating the internal documentation for the new module.</p><p>Could you take a quick look and see if anything is missing or unclear? I've tried to keep it as concise as possible.</p>" 
  },
  { 
    subject: "Congratulations!", 
    body: "<p>Just saw the news about the successful launch. Huge congratulations to you and the whole team!</p><p>It's a fantastic achievement and well-deserved after all the hard work everyone put in.</p>" 
  },
  { 
    subject: "Missing notes", 
    body: "<p>I seem to have misplaced my notes from our meeting on Tuesday.</p><p>If you have a moment, could you send over the key action items we discussed? I want to make sure I haven't missed anything important.</p>" 
  },
  { 
    subject: "Shared a file", 
    body: "<p>I've just shared the draft proposal with you on the shared drive.</p><p>Please take a look when you have a chance and let me know if you have any initial thoughts or suggestions for improvement.</p>" 
  },
  { 
    subject: "Rescheduling our call", 
    body: "<p>Something unexpected has come up, and I won't be able to make our scheduled call tomorrow morning.</p><p>Would you be free to reschedule for later in the afternoon or perhaps Friday morning instead? Sorry for the last-minute change.</p>" 
  },
  { 
    subject: "Feedback received", 
    body: "<p>Thanks so much for the feedback you sent over yesterday. It was incredibly helpful.</p><p>I've already started incorporating some of your suggestions into the next version of the report. I'll share it with you once it's ready.</p>" 
  },
  { 
    subject: "Quick intro", 
    body: "<p>I'd like to introduce you to a colleague of mine who is working on a similar project.</p><p>I think there could be some great opportunities for collaboration between your two teams. I'll set up a quick intro call for next week.</p>" 
  },
  { 
    subject: "Office commute", 
    body: "<p>How was your commute this morning? The traffic was particularly bad on my end.</p><p>I'm considering starting a bit earlier or later to avoid the rush. Do you have any tips for a better route?</p>" 
  },
  { 
    subject: "Conference registration", 
    body: "<p>Are you planning on attending the tech conference next month?</p><p>Registration is closing soon, and I wanted to see if you were interested in going so we could potentially travel together.</p>" 
  },
  { 
    subject: "New software tool", 
    body: "<p>I've been experimenting with a new software tool for project management lately.</p><p>It seems quite promising so far. I'd be happy to give you a quick demo sometime if you're interested in seeing how it works.</p>" 
  },
  { 
    subject: "Coffee break", 
    body: "<p>If you're in the office today, would you like to grab a quick coffee break this afternoon?</p><p>I could use a bit of a stretch and a chat. Let me know if you have 10-15 minutes free around 3 PM.</p>" 
  },
  { 
    subject: "Article recommendation", 
    body: "<p>I came across this interesting article about the future of remote work today and thought of you.</p><p>It has some really insightful perspective on the challenges and opportunities ahead. Let me know what you think if you get a chance to read it.</p>" 
  }
];

const FALLBACK_REPLIES = [
  "Thanks for the update, sounds good!",
  "I'll check this and get back to you soon.",
  "That works for me, looking forward to it.",
  "Great, thanks for letting me know!",
  "Acknowledged. Have a great day!"
];

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
    - DO NOT include a sign-off or signature in the body (I will add it manually).
    
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
      console.error("Warmup AI Content Generation Failed, using fallback:", error.message);
      return FALLBACK_CONTENT[Math.floor(Math.random() * FALLBACK_CONTENT.length)];
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
      console.error("Warmup AI Reply Generation Failed, using fallback:", error.message);
      return FALLBACK_REPLIES[Math.floor(Math.random() * FALLBACK_REPLIES.length)];
    }
  }

  /**
   * Picks a random "target" mailbox from the warmup-enabled pool.
   * Includes SMTP, Gmail, and Outlook accounts.
   * Logic: 
   * 1. Peer accounts (same user)
   * 2. Global accounts (other users)
   * 3. System Pool (specifically tagged by admin)
   */
  async pickTarget(sender) {
    const models = [
      { name: "smtp", model: SmtpSender },
      { name: "gmail", model: GmailSender },
      { name: "outlook", model: OutlookSender },
    ];

    // Helper to find targets based on conditions (Refined with Interaction Locking)
    const findInPool = async (where) => {
      let pool = [];
      for (const { name, model } of models) {
        const results = await model.findAll({
          where: {
            email: { [Op.ne]: sender.email },
            id: { [Op.ne]: sender.id },
            warmupEnabled: true,
            isVerified: true,
            warmupStatus: "active",
            ...where
          },
          attributes: ["id", "email", "displayName"]
        });

        for (const r of results) {
          // INTERACTION LOCKING: Check for ANY interaction in the last 24h (both directions)
          const recentInteraction = await WarmupMessage.findOne({
            where: {
              [Op.or]: [
                { senderId: sender.id, recipientId: r.id },
                { senderId: r.id, recipientId: sender.id }
              ],
              sentAt: { [Op.gte]: new Date(Date.now() - 24 * 60 * 60 * 1000) }
            },
            attributes: ['id']
          });

          if (!recentInteraction) {
            pool.push({ id: r.id, type: name, email: r.email, displayName: r.displayName });
          }
        }
      }
      return pool;
    };

    // Helper to sort by least recently targeted
    const rankByHistory = async (pool) => {
      if (pool.length <= 1) return pool;

      const ids = pool.map(p => p.id);
      const history = await WarmupMessage.findAll({
        where: { recipientId: { [Op.in]: ids } },
        attributes: [
          "recipientId",
          [sequelize.fn("MAX", sequelize.col("sentAt")), "lastSentAt"]
        ],
        group: ["recipientId"],
        raw: true
      });

      const historyMap = history.reduce((acc, curr) => {
        acc[curr.recipientId] = new Date(curr.lastSentAt).getTime();
        return acc;
      }, {});

      return pool.sort((a, b) => {
        const timeA = historyMap[a.id] || 0;
        const timeB = historyMap[b.id] || 0;
        return timeA - timeB; // Oldest first
      });
    };

    // 1. Peer matching (same user, different account, NOT system)
    let peerPool = await findInPool({ userId: sender.userId, isSystemAccount: false });
    if (peerPool.length > 0) {
      const ranked = await rankByHistory(peerPool);
      const picked = ranked[0];
      console.log(`[Warmup] Picked target from PEER POOL (Rotation): ${picked.email}`);
      return picked;
    }

    // 2. Global Pool (any user, different account, NOT system)
    let globalPool = await findInPool({ isSystemAccount: false });
    if (globalPool.length > 0) {
      const ranked = await rankByHistory(globalPool);
      const picked = ranked[0];
      console.log(`[Warmup] Picked target from GLOBAL POOL (Rotation): ${picked.email}`);
      return picked;
    }

    // 3. System Pool Fallback (Specifically tagged by Admin to "do the job")
    let systemPool = await findInPool({ isSystemAccount: true });
    if (systemPool.length > 0) {
      const ranked = await rankByHistory(systemPool);
      const picked = ranked[0];
      console.log(`[Warmup] Picked target from SYSTEM POOL (Rotation): ${picked.email}`);
      return picked;
    }

    return null;
  }

  /**
   * Orchestrates a single warmup send.
   */
  async triggerWarmupSend(sender) {
    const target = await this.pickTarget(sender);
    if (!target) return;

    const { subject, body } = await this.generateWarmupContent();

    // Human-like Greetings
    const greetings = ["Hi", "Hello", "Hey", "Greetings"];
    const greeting = greetings[Math.floor(Math.random() * greetings.length)];
    const recipientName = target.displayName || target.email.split("@")[0];

    // Human-like Sign-offs
    const signOffs = ["Best", "Regards", "Best regards", "Thanks", "Cheers", "All the best", "Kind regards"];
    const signOff = signOffs[Math.floor(Math.random() * signOffs.length)];
    const senderName = sender.displayName || sender.email.split("@")[0];

    const htmlBody = `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; font-size: 14px; line-height: 1.6; color: #333333; max-width: 600px;">
        <p>${greeting} ${recipientName},</p>
        
        <div style="margin: 16px 0;">
          ${body}
        </div>
        
        <p style="margin-top: 24px;">
          ${signOff},<br/>
          <strong>${senderName}</strong>
        </p>
      </div>
    `.trim();

    const channel = await getChannel();

    // We reuse the existing EMAIL_SEND queue but with 
    // a 'warmup' flag in metadata to avoid stats corruption
    const determinedType = sender.type || 
      (sender.model?.constructor?.name === "OutlookSender" || sender.constructor?.name === "OutlookSender" ? "outlook" : 
       sender.model?.constructor?.name === "GmailSender" || sender.constructor?.name === "GmailSender" ? "gmail" : "smtp");

    channel.sendToQueue(QUEUES.EMAIL_SEND, Buffer.from(JSON.stringify({
      senderId: sender.id,
      senderType: determinedType,
      recipientEmail: target.email,
      subject,
      htmlBody,
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
      body: htmlBody,
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
