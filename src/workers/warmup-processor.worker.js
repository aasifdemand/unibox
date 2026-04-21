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
import { DateTime } from 'luxon';

const log = (level, message, meta = {}) =>
  console.log(
    JSON.stringify({
      ts: DateTime.now().toISO(),
      service: "warmup-processor-consumer",
      level,
      message,
      ...meta,
    })
  );

async function startConsumer() {
  let channel;
  try {
    channel = await getChannel();

    // 1. WARMUP_RESCUE Consumer
    await channel.assertQueue(QUEUES.WARMUP_RESCUE, { durable: true });
    channel.prefetch(10); 

    channel.consume(QUEUES.WARMUP_RESCUE, async (msg) => {
      if (!msg) return;
      const data = JSON.parse(msg.content.toString());
      try {
        log("INFO", `Processing Rescue Task for ${data.email}`, { type: data.senderType });
        await processRescueTask(data);
        channel.ack(msg);
      } catch (err) {
        log("ERROR", `Rescue Task Failed for ${data.email}`, { error: err.message });
        channel.nack(msg, false, false);
      }
    });

    // 2. WARMUP_SEND Consumer
    await channel.assertQueue(QUEUES.WARMUP_SEND, { durable: true });

    channel.consume(QUEUES.WARMUP_SEND, async (msg) => {
      if (!msg) return;
      const data = JSON.parse(msg.content.toString());
      try {
        log("INFO", `Processing Send Task for ${data.email}`, { type: data.senderType });
        await processSendTask(data);
        channel.ack(msg);
      } catch (err) {
        log("ERROR", `Send Task Failed for ${data.email}`, { error: err.message });
        channel.nack(msg, false, false);
      }
    });

    log("INFO", "🚀 Warmup Processor Consumer started and listening");

    channel.on("close", () => {
      log("WARN", "Channel closed, restarting in 5s...");
      setTimeout(startConsumer, 5000);
    });

  } catch (err) {
    log("ERROR", "Worker failed to start", { error: err.message });
    setTimeout(startConsumer, 5000);
  }
}

/* =========================
   TASK HANDLERS
========================= */

async function processSendTask(data) {
  const senderId = data.senderId;
  const senderType = data.senderType;

  // Staggering: Wait for the assigned delay before actually sending
  if (data.delayMs && data.delayMs > 0) {
    log("INFO", `Staggering send for ${data.email} - waiting ${Math.round(data.delayMs / 1000)}s`);
    await new Promise((resolve) => setTimeout(resolve, data.delayMs));
  }

  let sender;
  if (senderType === "smtp") sender = await SmtpSender.findByPk(senderId);
  else if (senderType === "gmail") sender = await GmailSender.findByPk(senderId);
  else if (senderType === "outlook") sender = await OutlookSender.findByPk(senderId);
  if (!sender || !sender.warmupEnabled || sender.warmupStatus !== 'active') return;

  // Trigger the actual send via service (Pass explicit type)
  await activeWarmupService.triggerWarmupSend(sender, senderType);

  // Note: We no longer increment warmupCurrentSent here. 
  // It is now handled by the email-sender worker upon successful delivery.
  log("INFO", `Warmup email tasks enqueued for ${sender.email}`);
}

async function processRescueTask(data) {
  const { senderId, senderType } = data;
  let model;
  if (senderType === 'gmail') model = GmailSender;
  else if (senderType === 'outlook') model = OutlookSender;
  else model = SmtpSender;

  const sender = await model.findByPk(senderId);
  if (!sender || !sender.warmupEnabled) return;
  sender.type = senderType; // Inject for monitor functions

  // 1. Fetch recent warmup messages sent to this mailbox
  const recentWarmups = await WarmupMessage.findAll({
    where: {
      recipientEmail: sender.email,
      sentAt: { [Op.gte]: DateTime.now().minus({ hours: 48 }).toJSDate() },
      status: { [Op.ne]: 'replied' }
    }
  });

  if (recentWarmups.length === 0) return;

  // 2. Scan folders
  let stats = { totalFound: 0, spamCount: 0 };
  if (senderType === 'gmail') stats = await monitorGmail(sender, recentWarmups);
  else if (senderType === 'outlook') stats = await monitorOutlook(sender, recentWarmups);
  else if (senderType === 'smtp') stats = await monitorImap(sender, recentWarmups);

  // 3. Update Health
  if (stats.totalFound > 0) {
    const spamRate = (stats.spamCount / stats.totalFound) * 100;
    const health = await SenderHealth.findOne({ where: { mailboxId: sender.id } });

    if (!health) {
      await SenderHealth.create({
        mailboxId: sender.id,
        reputationScore: 100,
        healthStatus: 'healthy'
      });
    }

    await SenderHealth.update({
      warmupSpamRate: spamRate,
      warmupTotalRescued: sequelize.literal(`"warmupTotalRescued" + ${stats.spamCount}`),
      lastCheckedAt: DateTime.now().toJSDate()
    }, { where: { mailboxId: sender.id } });
  }
}

/* =========================
   PROVIDER SCANNERS (Legacy Logic)
========================= */

async function monitorGmail(mailbox, recentWarmups) {
  const token = await refreshGoogleToken(mailbox);
  if (!token) throw new Error("Could not refresh Google token");

  const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_CALLBACK_URL_SENDER);
  oauth2.setCredentials({ access_token: token.accessToken });
  const gmail = google.gmail({ version: "v1", auth: oauth2 });

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

    if (full.data.labelIds.includes("SPAM")) {
      stats.spamCount++;
      await activeWarmupService.moveToInbox(mailbox, "gmail", msg.id);
    }

    if (full.data.labelIds.includes("UNREAD")) {
      await activeWarmupService.markAsRead(mailbox, "gmail", msg.id);
    }

    await handleMaybeReply(mailbox, "gmail", msg.id, match);
  }
  return stats;
}

async function monitorOutlook(mailbox, recentWarmups) {
  const token = await getValidMicrosoftToken(mailbox);
  if (!token) throw new Error("Could not refresh Outlook token");

  const headers = { Authorization: `Bearer ${token}` };
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
      }

      if (!msg.isRead) {
        await activeWarmupService.markAsRead(mailbox, "outlook", msg.id);
      }

      await handleMaybeReply(mailbox, "outlook", msg.id, match);
    }
  }
  return stats;
}

async function monitorImap(mailbox, recentWarmups) {
  const imap = await createImapConnection(mailbox);

  return new Promise((resolve) => {
    imap.once("ready", () => {
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

          imap.search([["SINCE", DateTime.now().minus({ days: 2 }).toJSDate()]], (err, results) => {
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
      log("ERROR", "IMAP Monitor Error", { error: err.message });
      resolve({ totalFound: 0, spamCount: 0 });
    });

    imap.connect();
  });
}

async function handleMaybeReply(mailbox, type, messageId, warmupLog) {
  // If we've already decided (replied or skipped), don't process again
  if (warmupLog.status === 'replied' || warmupLog.status === 'received') return;

  const replyChance = mailbox.warmupReplyRate || 0.3;
  const shouldReply = Math.random() <= replyChance;

  if (shouldReply) {
    const replyBody = await activeWarmupService.generateWarmupReply(warmupLog.subject, warmupLog.body);

    const channel = await getChannel();
    channel.sendToQueue(QUEUES.EMAIL_SEND, Buffer.from(JSON.stringify({
      senderId: mailbox.id,
      senderType: type,
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

    await warmupLog.update({ status: 'replied', lastActionAt: DateTime.now().toJSDate() });
    console.log(`[Warmup] Decided to REPLY to ${warmupLog.subject} (Chance: ${replyChance})`);
  } else {
    // Mark as 'received' so we don't roll the dice again in the next monitor tick
    await warmupLog.update({ status: 'received', lastActionAt: DateTime.now().toJSDate() });
    console.log(`[Warmup] Decided NOT to reply to ${warmupLog.subject} (Chance: ${replyChance})`);
  }
}

startConsumer();
