import "../models/index.js";
import { initGlobalErrorHandlers } from "../utils/error-handler.js";
initGlobalErrorHandlers();
import axios from "axios";
import { google } from "googleapis";
import { simpleParser } from "mailparser";
import { Op } from "sequelize";

import GmailSender from "../models/gmail-sender.model.js";
import OutlookSender from "../models/outlook-sender.model.js";
import SmtpSender from "../models/smtp-sender.model.js";
import Email from "../models/email.model.js";
import ReplyEvent from "../models/reply-event.model.js";
import Campaign from "../models/campaign.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import BounceEvent from "../models/bounce-event.model.js";
import { emitToUser } from "../utils/event-broadcaster.js";
import sequelize from "../config/db.js";
import { DateTime } from "luxon";

import { getValidMicrosoftToken } from "../utils/get-valid-microsoft-token.js";
import { refreshGoogleToken } from "../utils/refresh-google-token.js";
import { tryCompleteCampaign } from "../utils/campaign-completion.checker.js";
import { createImapConnection } from "../utils/imap-helper.js";
import { syncLead } from "../services/crm-sync.service.js";
import { syncLeadToAllCRMs } from "../services/crm-sync.provider.js";
import { getProxyForEmail } from "../utils/proxy-resolver.js";
import { QUEUES } from "../queues/queues.js";
import { getRabbitChannel } from "../queues/rabbit.js";

/* =========================
   LOGGER
========================= */

const log = (level, message, meta = {}) =>
  console.log(
    JSON.stringify({
      ts: DateTime.now().toISO(),
      service: "reply-ingestion",
      level,
      message,
      ...meta,
    }),
  );

/* =========================
   CORE REPLY PROCESSOR
========================= */

async function processReply({ sender, email, reply }) {
  try {
    if (!email.campaignId) {
      log("ERROR", "Reply matched email without campaignId", {
        emailId: email.id,
      });
      return;
    }

    // Prevent duplicates
    const exists = await ReplyEvent.findOne({
      where: { providerMessageId: reply.messageId },
    });

    if (exists) return;

    let replyEventId = null;
    await sequelize.transaction(async (t) => {
      const event = await ReplyEvent.create({
        emailId: email.id,
        campaignId: email.campaignId,
        recipientId: email.recipientId,
        replyFrom: reply.from,
        replyTo: sender.email,
        subject: reply.subject || "",
        body: reply.body || "",
        providerMessageId: reply.messageId,
        providerThreadId: reply.threadId,
        providerConversationId: reply.conversationId,
        receivedAt: reply.receivedAt || DateTime.now().toJSDate(),
        metadata: reply.headers || {},
      }, { transaction: t });
      replyEventId = event.id;

      // Update email
      await email.update({
        status: "replied",
        repliedAt: reply.receivedAt || DateTime.now().toJSDate(),
      }, { transaction: t });

      // Update recipient status and stop further steps
      if (email.recipientId) {
        const [updatedCount] = await CampaignRecipient.update(
          { status: "replied", nextRunAt: null },
          {
            where: {
              id: email.recipientId,
              status: { [Op.ne]: "replied" }
            },
            transaction: t
          },
        );

        // Only increment campaign total if this is the FIRST reply from this recipient
        if (updatedCount > 0) {
          await Campaign.increment("totalReplied", {
            by: 1,
            where: { id: email.campaignId },
            transaction: t
          });
        }
      }

      await tryCompleteCampaign(email.campaignId, { transaction: t });
    });
    // We let the campaign stay in 'running' status to keep tracking active and visible.

    log("INFO", "Reply processed successfully", {
      emailId: email.id,
      campaignId: email.campaignId,
    });

    // 🏛️ SYNC LEAD TO CRM + ENQUEUE AI INTENT DETECTION
    const campaignData = await Campaign.findByPk(email.campaignId, { attributes: ['userId'] });
    if (campaignData) {
      // Offload AI classification to separate worker to avoid sync lag
      const channel = await getRabbitChannel();
      await channel.assertQueue(QUEUES.AI_CLASSIFY, { durable: true });
      channel.sendToQueue(QUEUES.AI_CLASSIFY, Buffer.from(JSON.stringify({
        replyEventId,
        body: reply.bodySnipped || reply.body
      })), { persistent: true });

      log("DEBUG", "🤖 Enqueued AI classification task", { replyEventId });

      syncLead(campaignData.userId, email.recipientEmail, "replied", "replied").catch(e =>
        log("ERROR", "Failed to sync lead to CRM on reply", { error: e.message })
      );

      syncLeadToAllCRMs(campaignData.userId, email.recipientEmail, "replied", {
        recent_reply_body: reply.bodySnipped || reply.body
      }).catch(e => log("ERROR", "Failed to sync lead to external CRM on reply", { error: e.message }));
    }

    const campaign = await Campaign.findByPk(email.campaignId, { attributes: ['userId', 'name'] });
    if (campaign) {
      emitToUser(campaign.userId, "notification", {
        type: "info",
        category: "reply",
        title: "New Reply Received",
        message: `${reply.from} replied to your email in "${campaign.name}".`,
      });

      // Emit a silent event for the Mailboxes UI to automatically refetch data
      emitToUser(campaign.userId, "mailbox_updated", {
        senderId: sender.id,
        senderEmail: sender.email,
        messageId: reply.messageId,
      });
    }
  } catch (err) {
    log("ERROR", "processReply failed", {
      error: err.message,
      stack: err.stack,
    });
  }
}

function extractGmailBody(payload) {
  if (!payload) return "";

  // 1️⃣ Direct body
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf8");
  }

  // 2️⃣ If multipart — recursively search
  if (payload.parts && payload.parts.length) {
    for (const part of payload.parts) {
      // Prefer plain text
      if (part.mimeType === "text/plain" && part.body?.data) {
        return Buffer.from(part.body.data, "base64").toString("utf8");
      }

      // Otherwise search deeper
      const nested = extractGmailBody(part);
      if (nested) return nested;
    }
  }

  return "";
}

/* =========================
   GMAIL INGESTION
========================= */

async function ingestGmailReplies(sender) {
  log("INFO", "Checking Gmail sender", { sender: sender.email });

  const campaignEmails = await Email.findAll({
    where: {
      senderId: sender.id,
      senderType: "gmail",
      providerThreadId: { [Op.ne]: null },
      campaignId: { [Op.ne]: null },
      status: { [Op.in]: ["sent", "delivered"] },
    },
  });

  const threadMap = new Map();
  campaignEmails.forEach((e) => {
    threadMap.set(e.providerThreadId, e);
  });

  if (!threadMap.size) return;

  const tokenData = await refreshGoogleToken(sender);
  if (!tokenData?.accessToken) return;

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_CALLBACK_URL_SENDER,
  );

  oauth2Client.setCredentials({
    access_token: tokenData.accessToken,
  });

  const gmail = google.gmail({
    version: "v1",
    auth: oauth2Client,
  });

  const res = await gmail.users.messages.list({
    userId: "me",
    q: "in:inbox newer_than:7d",
    maxResults: 100,
  });

  for (const msg of res.data.messages || []) {
    const full = await gmail.users.messages.get({
      userId: "me",
      id: msg.id,
      format: "full",
    });

    const threadId = full.data.threadId;

    const headers = {};
    (full.data.payload?.headers || []).forEach((h) => {
      headers[h.name] = h.value;
    });

    const from = headers["From"]?.match(/[^\s<]+@[^\s>]+/)?.[0]?.toLowerCase();

    if (!from || from === sender.email.toLowerCase()) continue;

    // if (full.data.payload.body?.data) {
    //   body = Buffer.from(full.data.payload.body.data, "base64").toString(
    //     "utf8",
    //   );
    // }

    const matchedEmail = threadMap.get(threadId);
    if (!matchedEmail) continue;

    const body = extractGmailBody(full.data.payload);

    await processReply({
      sender,
      email: matchedEmail,
      reply: {
        from,
        subject: headers["Subject"] || "",
        body,
        receivedAt: headers["Date"] ? DateTime.fromHTTP(headers["Date"]).toJSDate() : DateTime.now().toJSDate(),
        messageId: msg.id,
        threadId,
        conversationId: threadId,
        headers,
      },
    });
  }
}

/* =========================
   OUTLOOK INGESTION
========================= */

async function ingestOutlookReplies(sender) {
  log("INFO", "Checking Outlook sender", { sender: sender.email });

  const campaignEmails = await Email.findAll({
    where: {
      senderId: sender.id,
      senderType: "outlook",
      campaignId: { [Op.ne]: null },
      providerThreadId: { [Op.ne]: null }, // 🔥 use providerThreadId consistently
    },
  });

  if (!campaignEmails.length) {
    log("DEBUG", "No Outlook campaign emails found", {
      sender: sender.email,
    });
    return;
  }

  const convoMap = new Map();
  campaignEmails.forEach((e) => {
    convoMap.set(e.providerThreadId, e);
  });

  const token = await getValidMicrosoftToken(sender);
  if (!token) return;

  const res = await axios.get(
    "https://graph.microsoft.com/v1.0/me/messages?$top=50",
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  for (const msg of res.data.value || []) {
    const conversationId = msg.conversationId;
    const from = msg.from?.emailAddress?.address?.toLowerCase();

    if (!from || from === sender.email.toLowerCase()) continue;

    const matchedEmail = convoMap.get(conversationId);

    if (!matchedEmail) {
      log("DEBUG", "No conversation match found", {
        conversationId,
      });
      continue;
    }

    log("INFO", "Matched Outlook reply", {
      emailId: matchedEmail.id,
      conversationId,
    });

    await processReply({
      sender,
      email: matchedEmail,
      reply: {
        from,
        subject: msg.subject,
        body: msg.body?.content || "",
        receivedAt: DateTime.fromISO(msg.receivedDateTime).toJSDate(),
        messageId: msg.id,
        threadId: conversationId,
        conversationId,
        headers: {
          internetMessageId: msg.internetMessageId,
          conversationId: msg.conversationId,
        },
      },
    });
  }
}

async function ingestImapReplies(sender) {
  log("INFO", "Checking SMTP sender (IMAP)", {
    sender: sender.email,
  });

  try {
    // 1️⃣ Load campaign emails sent by this SMTP sender
    const campaignEmails = await Email.findAll({
      where: {
        senderId: sender.id,
        senderType: "smtp",
        campaignId: { [Op.ne]: null },
        providerMessageId: { [Op.ne]: null },
        status: { [Op.in]: ["sent", "delivered"] },
      },
      attributes: [
        "id",
        "campaignId",
        "recipientId",
        "recipientEmail",
        "providerMessageId",
      ],
    });

    if (!campaignEmails.length) {
      log("DEBUG", "No SMTP campaign emails found", {
        sender: sender.email,
      });
      return;
    }

    // 2️⃣ Build Message-ID map
    const messageIdMap = new Map();
    campaignEmails.forEach((e) => {
      const clean = e.providerMessageId?.replace(/[<>]/g, "").trim();
      if (clean) {
        messageIdMap.set(clean, e);
      }
    });

    if (!messageIdMap.size) return;

    // 3️⃣ Connect to IMAP (Resolve proxy server-side only)
    const proxy = await getProxyForEmail(sender.email);
    const imap = await createImapConnection(sender, proxy);

    return new Promise((resolve) => {
      imap.once("ready", () => {
        imap.openBox("INBOX", false, (err) => {
          if (err) {
            log("ERROR", "Failed to open IMAP inbox", {
              error: err.message,
            });
            return resolve();
          }

          // Search for unseen OR recent messages (last 24h) to be safe
          const since = DateTime.now().minus({ hours: 24 }).toJSDate();
          imap.search([["OR", "UNSEEN", ["SINCE", since]]], (err, results) => {
            if (err || !results?.length) {
              log("DEBUG", "No SMTP replies found in search");
              return resolve();
            }

            const fetch = imap.fetch(results, { bodies: "" });

            fetch.on("message", (msg) => {
              let buffer = "";

              msg.on("body", (stream) => {
                stream.on("data", (chunk) => {
                  buffer += chunk.toString("utf8");
                });
              });

              msg.once("end", async () => {
                try {
                  const parsed = await simpleParser(buffer);

                  const from = parsed.from?.value?.[0]?.address?.toLowerCase();

                  if (!from || from === sender.email.toLowerCase()) {
                    return;
                  }

                  // Extract reference IDs
                  const references = [];
                  if (parsed.inReplyTo) references.push(parsed.inReplyTo);
                  if (parsed.references) references.push(...parsed.references);

                  const cleanRefs = references
                    .map((id) => id?.replace(/[<>]/g, "").trim())
                    .filter(Boolean);

                  if (!cleanRefs.length) return;

                  let matchedEmail = null;

                  for (const ref of cleanRefs) {
                    if (messageIdMap.has(ref)) {
                      matchedEmail = messageIdMap.get(ref);
                      break;
                    }
                  }

                  if (!matchedEmail) return;

                  // Prevent duplicates
                  const exists = await ReplyEvent.findOne({
                    where: {
                      providerMessageId: parsed.messageId,
                      emailId: matchedEmail.id,
                    },
                  });

                  if (exists) return;

                  const body = parsed.text || parsed.html || "(No content)";

                  // 4️⃣ Detect if this is a spam complaint (ARF - Abuse Reporting Format)
                  const isArfReport =
                    parsed.headers.get("content-type")?.includes("report-type=feedback-report") ||
                    parsed.headers.get("x-original-message-id") ||
                    parsed.subject?.toLowerCase().includes("spam") ||
                    parsed.subject?.toLowerCase().includes("abuse report");

                  if (isArfReport) {
                    log("WARN", "🚨 Detected SPAM complaint (ARF)", { emailId: matchedEmail.id });
                    await BounceEvent.create({
                      emailId: matchedEmail.id,
                      bounceType: "complaint",
                      reason: "Recipient marked as SPAM via provider button (ARF detected)",
                      occurredAt: parsed.date ? DateTime.fromJSDate(parsed.date).toJSDate() : DateTime.now().toJSDate(),
                    });

                    // Also auto-unsubscribe the recipient
                    if (matchedEmail.recipientId) {
                      await CampaignRecipient.update(
                        { status: "unsubscribed", nextRunAt: null },
                        { where: { id: matchedEmail.recipientId } },
                      );
                    }
                    return; // Don't process as a regular reply
                  }

                  // 5️⃣ Process regular reply
                  await processReply({
                    sender,
                    email: matchedEmail,
                    reply: {
                      from,
                      subject: parsed.subject || "",
                      body,
                      receivedAt: parsed.date ? DateTime.fromJSDate(parsed.date).toJSDate() : DateTime.now().toJSDate(),
                      messageId: parsed.messageId || parsed.messageId,
                      threadId: parsed.messageId,
                      conversationId: parsed.messageId,
                      headers: Object.fromEntries(parsed.headers),
                    },
                  });

                  // Mark message as seen
                  msg.once("attributes", (attrs) => {
                    imap.addFlags(attrs.uid, ["\\Seen"], () => { });
                  });
                } catch (err) {
                  log("ERROR", "SMTP reply parse failed", {
                    error: err.message,
                  });
                }
              });
            });

            fetch.once("end", async () => {
              await sender.update({
                lastReplyCheckAt: DateTime.now().toJSDate(),
              });

              imap.end();
              resolve();
            });
          });
        });
      });

      imap.once("error", (err) => {
        log("ERROR", "IMAP connection error", {
          error: err.message,
        });
        resolve();
      });

      imap.connect();
    });
  } catch (err) {
    log("ERROR", "SMTP ingestion failed", {
      sender: sender.email,
      error: err.message,
    });
  }
}

/* =========================
   MAIN LOOP
========================= */

const POLL_INTERVAL_MS = 180000; // 3 minutes
const BATCH_SIZE = 10; // Max concurrent senders per batch

let running = false;

/**
 * Process an array of senders in parallel batches of BATCH_SIZE.
 * Promise.allSettled ensures one failure doesn't kill others.
 */
async function runInBatches(senders, fn) {
  for (let i = 0; i < senders.length; i += BATCH_SIZE) {
    const batch = senders.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map((s) => fn(s)));
    results.forEach((r, idx) => {
      if (r.status === "rejected") {
        log("ERROR", "Sender ingestion failed in batch", {
          sender: batch[idx]?.email,
          error: r.reason?.message,
        });
      }
    });
  }
}

async function checkAllSenders() {
  if (running) return;
  running = true;

  try {
    const twentyMinsAgo = DateTime.now().minus({ minutes: 20 }).toJSDate();
    const activeCampaignFilter = {
      model: Campaign,
      required: true,
      where: { status: "running" },
      attributes: [],
    };

    const queryOptions = {
      where: {
        isVerified: true,
        [Op.or]: [
          { lastReplyCheckAt: { [Op.lt]: twentyMinsAgo } },
          { lastReplyCheckAt: null }
        ]
      },
      include: [activeCampaignFilter],
      limit: 50 // Lease 50 per tick
    };

    const providers = [
      { model: GmailSender, type: 'gmail', fn: ingestGmailReplies },
      { model: OutlookSender, type: 'outlook', fn: ingestOutlookReplies },
      { model: SmtpSender, type: 'smtp', fn: ingestImapReplies, where: { ...queryOptions.where, isActive: true } }
    ];

    for (const p of providers) {
      // Atomic Lease
      const batch = await sequelize.transaction(async (t) => {
        const results = await p.model.findAll({
          where: p.where || queryOptions.where,
          include: p.include || queryOptions.include,
          limit: queryOptions.limit,
          lock: true,
          skipLocked: true,
          transaction: t
        });

        if (results.length > 0) {
          await p.model.update(
            { lastReplyCheckAt: DateTime.now().toJSDate() },
            {
              where: { id: { [Op.in]: results.map(r => r.id) } },
              transaction: t
            }
          );
        }
        return results;
      });

      if (batch.length > 0) {
        log("INFO", `🔓 Leased ${batch.length} ${p.type} senders for reply ingestion`);
        await runInBatches(batch, p.fn);
      }
    }

  } catch (err) {
    log("ERROR", "Reply ingestion failure during lease cycle", { error: err.message });
  } finally {
    running = false;
  }
}

/* =========================
   BOOT
========================= */

console.log("🚀 Reply ingestion worker booting...");

(async () => {
  await checkAllSenders();

  setInterval(() => {
    checkAllSenders();
  }, POLL_INTERVAL_MS);
})();
