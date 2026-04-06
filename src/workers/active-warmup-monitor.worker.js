import { initGlobalErrorHandlers } from "../utils/error-handler.js";
initGlobalErrorHandlers();

import { 
  SmtpSender, 
  GmailSender, 
  OutlookSender, 
  WarmupMessage,
  SenderHealth
} from "../models/index.js";
import { activeWarmupService } from "../services/active-warmup.service.js";
import { google } from "googleapis";
import axios from "axios";
import { refreshGoogleToken } from "../utils/refresh-google-token.js";
import { getValidMicrosoftToken } from "../utils/get-valid-microsoft-token.js";
import { createImapConnection } from "../utils/imap-helper.js";
import { simpleParser } from "mailparser";
import { Op } from "sequelize";
import sequelize from "../config/db.js";
import { getRabbitChannel as getChannel } from "../queues/rabbit.js";
import { QUEUES } from "../queues/queues.js";

const log = (level, message, meta = {}) =>
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "active-warmup-monitor",
      level,
      message,
      ...meta,
    })
  );

/**
 * Periodically scans mailboxes for incoming warmup emails.
 * Performs Spam -> Inbox rescue, Marks as Read, and Replies.
 */
async function runMonitorTick() {
  try {
    log("INFO", "🔍 Warmup monitoring tick started");

    const [gmails, outlooks, smtps] = await Promise.all([
      GmailSender.findAll({ where: { warmupEnabled: true, isVerified: true } }),
      OutlookSender.findAll({ where: { warmupEnabled: true, isVerified: true } }),
      SmtpSender.findAll({ where: { warmupEnabled: true, isVerified: true, isActive: true } }),
    ]);

    const allSenders = [
      ...gmails.map(s => { s.type = 'gmail'; return s; }),
      ...outlooks.map(s => { s.type = 'outlook'; return s; }),
      ...smtps.map(s => { s.type = 'smtp'; return s; }),
    ];

    for (const sender of allSenders) {
      await processMailboxMonitor(sender);
    }

    log("INFO", "✅ Warmup monitoring tick completed");
  } catch (err) {
    log("ERROR", "❌ Warmup monitoring tick failed", { error: err.message });
  }
}

async function processMailboxMonitor(mailbox) {
  try {
    log("DEBUG", `Processing mailbox monitor for ${mailbox.email}`);

    // 1. Fetch recent warmup messages sent to this mailbox
    const recentWarmups = await WarmupMessage.findAll({
      where: {
        recipientEmail: mailbox.email,
        sentAt: { [Op.gte]: new Date(Date.now() - 48 * 60 * 60 * 1000) }, // Last 48h
        status: { [Op.ne]: 'replied' }
      }
    });

    if (recentWarmups.length === 0) return;

    // 2. Scan folders (Provider Specific)
    let stats = { totalFound: 0, spamCount: 0 };
    if (mailbox.type === 'gmail') stats = await monitorGmail(mailbox, recentWarmups);
    else if (mailbox.type === 'outlook') stats = await monitorOutlook(mailbox, recentWarmups);
    else if (mailbox.type === 'smtp') stats = await monitorImap(mailbox, recentWarmups);

    // 3. Update Sender Health
    if (stats.totalFound > 0) {
      const spamRate = (stats.spamCount / stats.totalFound) * 100;
      
      const health = await SenderHealth.findOne({ where: { mailboxId: mailbox.id } });
      if (!health) {
        await SenderHealth.create({ 
          mailboxId: mailbox.id,
          reputationScore: 100, // Initial
          healthStatus: 'healthy'
        });
      }

      await SenderHealth.update({
        warmupSpamRate: spamRate,
        warmupTotalRescued: sequelize.literal(`"warmupTotalRescued" + ${stats.spamCount}`),
        lastCheckedAt: new Date()
      }, { where: { mailboxId: mailbox.id } });

      log("INFO", `Updated health for ${mailbox.email}`, { spamRate: spamRate.toFixed(2), rescued: stats.spamCount });
    }

  } catch (err) {
    log("ERROR", `Monitor failed for ${mailbox.email}`, { error: err.message, stack: err.stack });
  }
}

/* =========================
   GMAIL MONITOR
========================= */
async function monitorGmail(mailbox, recentWarmups) {
  const token = await refreshGoogleToken(mailbox);
  if (!token) throw new Error("Could not refresh Google token");

  const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_CALLBACK_URL_SENDER);
  oauth2.setCredentials({ access_token: token.accessToken });
  const gmail = google.gmail({ version: "v1", auth: oauth2 });

  // Search for emails from any of our sending peers
  const peerEmails = [...new Set(recentWarmups.map(w => w.senderEmail))];
  const query = `(${peerEmails.map(e => `from:${e}`).join(" OR ")}) newer_than:2d`;

  const res = await gmail.users.messages.list({ userId: "me", q: query });
  let stats = { totalFound: 0, spamCount: 0 };
  
  for (const msg of res.data.messages || []) {
    const full = await gmail.users.messages.get({ userId: "me", id: msg.id, format: "metadata", metadataHeaders: ["From", "Subject"] });
    const headers = full.data.payload.headers;
    const from = headers.find(h => h.name === 'From')?.value;
    const subject = headers.find(h => h.name === 'Subject')?.value;

    const match = recentWarmups.find(w => from.includes(w.senderEmail) && subject === w.subject);
    if (!match) continue;

    stats.totalFound++;

    // ACTION: Rescue from Spam
    if (full.data.labelIds.includes("SPAM")) {
      stats.spamCount++;
      await activeWarmupService.moveToInbox(mailbox, "gmail", msg.id);
      log("INFO", "Rescued Gmail from Spam", { email: mailbox.email, match: match.senderEmail });
    }

    // ACTION: Mark as Read
    if (full.data.labelIds.includes("UNREAD")) {
      await activeWarmupService.markAsRead(mailbox, "gmail", msg.id);
    }

    // ACTION: Reply?
    await handleMaybeReply(mailbox, "gmail", msg.id, match);
  }
  return stats;
}

/* =========================
   OUTLOOK MONITOR
========================= */
async function monitorOutlook(mailbox, recentWarmups) {
  const token = await getValidMicrosoftToken(mailbox);
  if (!token) throw new Error("Could not refresh Outlook token");

  const headers = { Authorization: `Bearer ${token}` };

  // Search inbox and junk
  const folders = ["inbox", "junkemail"];
  let stats = { totalFound: 0, spamCount: 0 };

  for (const folder of folders) {
    const res = await axios.get(`https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages?$top=20`, { headers });
    
    for (const msg of res.data.value || []) {
      const from = msg.from?.emailAddress?.address;
      const match = recentWarmups.find(w => from?.toLowerCase() === w.senderEmail.toLowerCase() && msg.subject === w.subject);
      if (!match) continue;

      stats.totalFound++;

      if (folder === "junkemail") {
        stats.spamCount++;
        await activeWarmupService.moveToInbox(mailbox, "outlook", msg.id);
        log("INFO", "Rescued Outlook from Spam", { email: mailbox.email, match: match.senderEmail });
      }

      if (!msg.isRead) {
        await activeWarmupService.markAsRead(mailbox, "outlook", msg.id);
      }

      await handleMaybeReply(mailbox, "outlook", msg.id, match);
    }
  }
  return stats;
}

/* =========================
   IMAP MONITOR
========================= */
async function monitorImap(mailbox, recentWarmups) {
  const imap = await createImapConnection(mailbox);
  
  return new Promise((resolve) => {
    imap.once("ready", () => {
      // Check INBOX and typical Spam folders
      const scanFolders = ["INBOX", "Spam", "Junk"];
      let stats = { totalFound: 0, spamCount: 0 };
      
      const doScan = async (idx) => {
        if (idx >= scanFolders.length) {
          imap.end();
          return resolve(stats);
        }

        const box = scanFolders[idx];
        imap.openBox(box, false, (err) => {
          if (err) return doScan(idx + 1);

          imap.search([["SINCE", new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)]], (err, results) => {
            if (err || !results.length) return doScan(idx + 1);

            const fetch = imap.fetch(results, { bodies: "HEADER.FIELDS (FROM SUBJECT)" });
            fetch.on("message", (msg) => {
              msg.on("body", (stream) => {
                let buffer = "";
                stream.on("data", chunk => buffer += chunk.toString());
                stream.on("end", async () => {
                  const parsed = await simpleParser(buffer);
                  const from = parsed.from?.value?.[0]?.address;
                  const subject = parsed.subject;

                  const match = recentWarmups.find(w => from?.toLowerCase() === w.senderEmail.toLowerCase() && subject === w.subject);
                  if (match) {
                     stats.totalFound++;
                     msg.once("attributes", async (attrs) => {
                        if (box !== "INBOX") {
                           stats.spamCount++;
                           await activeWarmupService.moveToInbox(mailbox, "smtp", attrs.uid);
                           log("INFO", "Rescued SMTP from Spam", { email: mailbox.email, match: match.senderEmail });
                        }
                        if (!attrs.flags.includes("\\Seen")) {
                           await activeWarmupService.markAsRead(mailbox, "smtp", attrs.uid);
                        }
                        await handleMaybeReply(mailbox, "smtp", attrs.uid, match);
                     });
                  }
                });
              });
            });
            fetch.once("end", () => doScan(idx + 1));
          });
        });
      };

      doScan(0);
    });
    
    imap.once("error", (err) => {
      log("ERROR", "IMAP Monitor Connection Error", { error: err.message });
      resolve({ totalFound: 0, spamCount: 0 });
    });

    imap.connect();
  });
}

/**
 * Decisions whether to reply to a warmup email.
 */
async function handleMaybeReply(mailbox, type, messageId, warmupLog) {
  // 30% chance according to default setting
  const replyChance = mailbox.warmupReplyRate || 0.3;
  if (Math.random() > replyChance) return;

  // Check if we already replied to this interaction in the logs
  if (warmupLog.status === 'replied') return;

  log("INFO", `Generating AI Warmup Reply for ${mailbox.email} -> ${warmupLog.senderEmail}`);

  const replyBody = await activeWarmupService.generateWarmupReply(warmupLog.subject, warmupLog.body);

  // Send the reply back to the sender
  const channel = await getChannel();
  channel.sendToQueue(QUEUES.EMAIL_SEND, Buffer.from(JSON.stringify({
    senderId: mailbox.id,
    senderType: mailbox.type,
    recipientEmail: warmupLog.senderEmail,
    subject: `Re: ${warmupLog.subject}`,
    htmlBody: replyBody,
    isWarmup: true,
    metadata: {
      warmup: true,
      originalMessageId: messageId,
      isReply: true
    }
  })), { persistent: true });
  
  // Update status
  await warmupLog.update({ status: 'replied', lastActionAt: new Date() });
}

// Tick every 15 minutes
const MONITOR_INTERVAL = 15 * 60 * 1000;
log("INFO", "🚀 Warmup Monitoring Orchestrator booted");
runMonitorTick();
setInterval(runMonitorTick, MONITOR_INTERVAL);
