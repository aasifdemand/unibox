import "../models/index.js";
import { initGlobalErrorHandlers } from "../utils/error-handler.js";
initGlobalErrorHandlers();
import Redis from "ioredis";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { randomUUID } from "crypto";
import axios from "axios";
import dns from "dns/promises";
import { DateTime } from "luxon";


import Email from "../models/email.model.js";
import GmailSender from "../models/gmail-sender.model.js";
import OutlookSender from "../models/outlook-sender.model.js";
import SmtpSender from "../models/smtp-sender.model.js";
import Campaign from "../models/campaign.model.js";
import CampaignSend from "../models/campaign-send.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import EmailEvent from "../models/email-event.model.js";
import BounceEvent from "../models/bounce-event.model.js";
import SenderHealth from "../models/sender-health.model.js";

import { smtpWarmupService } from "../services/smtp-warmup.service.js";
import { syncLead } from "../services/crm-sync.service.js";
import { syncLeadToAllCRMs } from "../services/crm-sync.provider.js";
import { senderHealthService } from "../services/sender-health.service.js";
import { getRabbitChannel as getChannel } from "../queues/rabbit.js";
import { QUEUES } from "../queues/queues.js";
import { refreshGoogleToken } from "../utils/refresh-google-token.js";
import { getValidMicrosoftToken } from "../utils/get-valid-microsoft-token.js";

import { SocksProxyAgent } from "socks-proxy-agent";
import socks from "socks";

import { getProxyForEmail, deleteProxySticky } from "../utils/proxy-resolver.js";

const redis = new Redis(process.env.REDIS_URL);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* =========================
   DNS PRE-SEND VERIFICATION
   Warns if SPF / DKIM / DMARC are missing for the sender's domain.
   Does NOT block delivery — only logs issues.
========================= */

const DKIM_SELECTORS_TO_PROBE = [
  "default",
  "mail",
  "dkim",
  "smtp",
  "k1",
  "selector1",
  "selector2",
];


async function checkSenderDns(domain) {
  const cacheKey = `dns:check:${domain}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (err) {
    console.error("DNS Cache Redis Error:", err.message);
  }

  const result = { spf: false, dkim: false, dkimSelector: null, dmarc: false };

  // SPF
  try {
    const txtRecords = await dns.resolveTxt(domain);
    result.spf = txtRecords
      .flat()
      .some((r) => r.toLowerCase().startsWith("v=spf1"));
  } catch {
    /* no SPF found */
  }

  // DKIM — probe common selectors
  for (const sel of DKIM_SELECTORS_TO_PROBE) {
    try {
      const records = await dns.resolveTxt(`${sel}._domainkey.${domain}`);
      if (records.flat().join("").includes("v=DKIM1")) {
        result.dkim = true;
        result.dkimSelector = sel;
        break;
      }
    } catch {
      /* selector not found */
    }
  }

  // DMARC
  try {
    const dmarcRecords = await dns.resolveTxt(`_dmarc.${domain}`);
    result.dmarc = dmarcRecords
      .flat()
      .join("")
      .toLowerCase()
      .startsWith("v=dmarc1");
  } catch {
    /* no DMARC found */
  }

  result.ts = Date.now();

  try {
    await redis.set(cacheKey, JSON.stringify(result), "EX", 86400); // 24h
  } catch (err) {
    console.error("DNS Cache Store Error:", err.message);
  }

  return result;
}

/* =========================
   SMTP TRANSPORTER CACHE
   Reuse transporters per sender — avoids creating a new one per email.
   TTL: 30 minutes. Evicted on auth/connection errors.
========================= */
const transporterCache = new Map(); // senderId → { transporter, expiresAt }
const TRANSPORTER_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getOrCreateTransporter(sender, proxy = null) {
  const cacheKey = `${sender.id}:${proxy || 'direct'}`;
  const cached = transporterCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.transporter;
  }

  const transportConfig = {
    host: sender.smtpHost,
    port: sender.smtpPort,
    secure: sender.smtpSecure,
    auth: {
      user: sender.smtpUsername,
      pass: sender.smtpPassword,
    },
    tls: {
      rejectUnauthorized: false,
    },
  };

  if (proxy) {
    transportConfig.proxy = proxy;
  }

  const transporter = nodemailer.createTransport(transportConfig);

  if (proxy && (proxy.startsWith("socks4") || proxy.startsWith("socks5"))) {
    transporter.set("proxy_socks_module", socks);
  }

  transporterCache.set(cacheKey, {
    transporter,
    expiresAt: Date.now() + TRANSPORTER_TTL_MS,
  });

  return transporter;
}

function evictTransporter(senderId) {
  transporterCache.delete(senderId);
}

const log = (level, message, meta = {}) =>
  console.log(
    JSON.stringify({
      ts: DateTime.now().toISO(),
      service: "email-sender",
      level,
      message,
      ...meta,
    }),
  );

/* =========================
   BOUNCE CLASSIFIER
========================= */

function classifyBounce(error) {
  const msg = error.message.toLowerCase();

  if (
    msg.includes("550") ||
    msg.includes("user unknown") ||
    msg.includes("does not exist") ||
    msg.includes("mailbox unavailable")
  ) {
    return "hard";
  }

  if (msg.includes("spam") || msg.includes("blacklisted")) {
    return "complaint";
  }

  return "soft";
}

/* =========================
   MESSAGE ID
========================= */

function generateMessageId(emailId, domain) {
  const prefix = emailId || `warmup-${randomUUID().slice(0, 8)}`;
  return `<${prefix}.${randomUUID().slice(0, 8)}.${Date.now()}@${domain}>`;
}

/* =========================
   WORKER START
========================= */

async function startWorker() {
  let channel;
  try {
    channel = await getChannel();
    await channel.assertQueue(QUEUES.EMAIL_SEND, { durable: true });
    channel.prefetch(5);

    log("INFO", "Advanced Email Sender Started");

    channel.consume(QUEUES.EMAIL_SEND, async (msg) => {
      if (!msg) return;

      let emailRecord;
      let sender;
      let isWarmup = false;
      let emailId;

      try {
        const payload = JSON.parse(msg.content.toString());
        log("DEBUG", "📥 RabbitMQ Message Received", { ...payload });

        const {
          senderType,
          policy = {},
          recipientEmail: warmupRecipient,
          subject: warmupSubject,
          htmlBody: warmupBody,
          // Extract both senderId and payload.sender as source for lookup
          senderId: pSenderId,
          sender: pSender,
        } = payload;

        emailId = payload.emailId;
        isWarmup = payload.isWarmup || false;

        // 1. & 3. Resolve the Sender (Unifying Warmup and Regular)
        const finalSenderType = senderType || payload.type || "smtp";
        const finalSenderId = pSenderId || pSender || (payload.emailId ? (await Email.findByPk(payload.emailId))?.senderId : null);

        if (!finalSenderId) {
          throw new Error("No sender ID found in payload");
        }

        if (finalSenderType === "gmail") sender = await GmailSender.findByPk(finalSenderId);
        else if (finalSenderType === "outlook") sender = await OutlookSender.findByPk(finalSenderId);
        else sender = await SmtpSender.findByPk(finalSenderId);

        if (!sender || !sender.isVerified) {
          log("ERROR", "Sender not found or not verified", {
            senderId: finalSenderId,
            senderType: finalSenderType,
            isWarmup
          });
          throw new Error(`Sender [${finalSenderType}] with ID [${finalSenderId}] is unverified or missing`);
        }

        // 3. Load Email Record (if not warmup)
        if (!isWarmup && payload.emailId) {
          emailRecord = await Email.findByPk(payload.emailId);
          if (!emailRecord || emailRecord.status !== "routed") {
            return channel.ack(msg);
          }
        }

        const finalRecipient = isWarmup ? warmupRecipient : emailRecord.recipientEmail;
        const finalSubject = isWarmup ? warmupSubject : emailRecord.subject;
        const finalBody = isWarmup ? warmupBody : emailRecord.htmlBody;

        // 2. Resolve Proxy
        const proxy = await getProxyForEmail(sender.email);
        if (proxy) log("DEBUG", "🌐 Using SOCKS5 proxy for this send", { emailId, isWarmup });

        log("DEBUG", "🚀 Processing email for delivery", {
          emailId,
          recipient: finalRecipient,
          senderType: finalSenderType,
          isWarmup,
        });

        /* =========================
           REPUTATION BLOCK
        ========================= */

        const health = await SenderHealth.findOne({
          where: { mailboxId: sender.id },
        });

        if (health?.blacklisted) throw new Error("Sender IP blacklisted");

        if (health?.reputationScore < 40)
          throw new Error("Sender reputation critical");

        /* =========================
           SMTP WARMUP CONTROL
        ========================= */

        if (senderType === "smtp") {
          const maxDaily = await smtpWarmupService.getSenderDailyLimit(sender);

          const today = DateTime.now().toISODate();
          const warmupKey = `warmup:${sender.id}:${today}`;
          const campaignKey = `campaign:${sender.id}:${today}`;

          const sentWarmupToday = parseInt(await redis.get(warmupKey) || "0");
          const sentCampaignToday = parseInt(await redis.get(campaignKey) || "0");
          const totalSentToday = sentWarmupToday + sentCampaignToday;

          if (isWarmup) {
            if (totalSentToday >= maxDaily) {
              throw new Error("Warmup daily limit reached");
            }
            await redis.incr(warmupKey);
            await redis.expire(warmupKey, 86400);
          } else {
            // For campaigns, we allow a bit of 'overdrive' or we just ensure we don't block
            // if the total is still within reasonable bounds, or we subtract from warmup if possible.
            // Simplified: Campaigns always increment campaignKey. We only block if TOTAL exceeds maxDaily.
            if (totalSentToday >= maxDaily) {
              // Priority logic: if it's a campaign and we're at the limit, 
              // we still fail but we've at least tracked them separately for better reporting.
              // In a more advanced version, we would pause warmups to make room.
              throw new Error("Sender daily limit reached (Campaigns + Warmup)");
            }
            await redis.incr(campaignKey);
            await redis.expire(campaignKey, 86400);
          }
        }

        /* =========================
           HUMAN-LIKE DELAY
        ========================= */

        const jitter = Math.floor(Math.random() * 2000);
        await sleep((policy.delayMs || 1000) + jitter);

        /* =========================
           SEND EMAIL
        ========================= */

        const domain = sender.email.split("@")[1];
        const messageId = generateMessageId(emailId, domain);

        let providerMessageId = messageId;
        let providerThreadId = null;
        let providerConversationId = null;
        let internetMessageId = null;


        if (senderType === "smtp") {
          const transporter = getOrCreateTransporter(sender, proxy);

          // 🔍 DNS pre-send check — warn if SPF/DKIM/DMARC are missing
          checkSenderDns(domain)
            .then((dnsResult) => {
              const issues = [];
              if (!dnsResult.spf) issues.push("SPF record missing");
              if (!dnsResult.dkim)
                issues.push(
                  "DKIM record missing (check aaPanel DKIM settings)",
                );
              if (!dnsResult.dmarc) issues.push("DMARC record missing");
              if (issues.length) {
                log(
                  "WARN",
                  "⚠️ Deliverability issues detected — emails may land in spam",
                  {
                    domain,
                    senderId: sender.id,
                    issues,
                  },
                );
              }
            })
            .catch(() => { }); // non-blocking

          try {
            const mailOptions = {
              from: `"${sender.displayName}" <${sender.email}>`,
              to: finalRecipient,
              subject: finalSubject,
              html: finalBody,
              messageId,
            };

            if (
              emailRecord.htmlBody &&
              emailRecord.htmlBody.includes("/tracking/unsubscribe/")
            ) {
              const appUrl =
                process.env.APP_URL ||
                process.env.VITE_API_URL ||
                "http://localhost:8080";
              const unsubUrl = `${appUrl}/api/v1/tracking/unsubscribe/${emailId}`;
              mailOptions.headers = {
                "List-Unsubscribe": `<${unsubUrl}>`,
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
              };
            }

            await transporter.sendMail(mailOptions);

            // 📤 APPEND TO SENT FOLDER (SMTP Manual persistence)
            // 📤 OFFLOAD IMAP APPEND (Async offload for throughput)
            try {
              const composer = new MailComposer(mailOptions);
              const messageBuffer = await composer.compile().build();

              channel.sendToQueue(
                QUEUES.EMAIL_APPEND_SENT,
                Buffer.from(JSON.stringify({
                  senderId: sender.id,
                  messageBuffer: messageBuffer.toString("base64"),
                  senderType: "smtp"
                })),
                { persistent: true }
              );
              log("DEBUG", "📤 Offloaded IMAP append to queue", { senderId: sender.id });
            } catch (composerErr) {
              log("ERROR", "❌ Failed to offload IMAP append", { error: composerErr.message });
            }
          } catch (smtpErr) {
            // Evict cached transporter on auth/connection errors so next send gets a fresh one
            if (
              smtpErr.code === "EAUTH" ||
              smtpErr.code === "ECONNECTION" ||
              smtpErr.responseCode >= 500
            ) {
              evictTransporter(sender.id);
            }
            throw smtpErr;
          }
        }

        if (senderType === "gmail") {
          const token = await refreshGoogleToken(sender);
          if (!token) throw new Error("Failed to refresh Google token");

          let rawHeaders =
            `From: ${sender.email}\r\n` +
            `To: ${finalRecipient}\r\n` +
            `Subject: ${finalSubject}\r\n`;

          if (
            !isWarmup &&
            finalBody &&
            finalBody.includes("/tracking/unsubscribe/")
          ) {
            const appUrl =
              process.env.APP_URL ||
              process.env.VITE_API_URL ||
              "http://localhost:8080";
            const unsubUrl = `${appUrl}/api/v1/tracking/unsubscribe/${emailId}`;
            rawHeaders +=
              `List-Unsubscribe: <${unsubUrl}>\r\n` +
              "List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n";
          }

          const raw =
            rawHeaders +
            "Content-Type: text/html; charset=UTF-8\r\n\r\n" +
            finalBody;

          const encoded = Buffer.from(raw)
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");

          const axiosConfig = {
            headers: {
              Authorization: `Bearer ${token.accessToken}`,
            },
          };

          if (proxy) {
            axiosConfig.httpsAgent = new SocksProxyAgent(proxy);
            axiosConfig.proxy = false;
          }

          const res = await axios.post(
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
            { raw: encoded },
            axiosConfig
          );

          providerMessageId = res.data.id;
          providerThreadId = res.data.threadId;
          providerConversationId = res.data.threadId; // Gmail uses threadId for threading
          internetMessageId = res.data.id; // Gmail ID is its persistent identifier

        }

        if (senderType === "outlook") {
          const token = await getValidMicrosoftToken(sender);
          if (!token) throw new Error("Failed to refresh Outlook token");

          // 1. Create the message (not sendMail) so we get IDs back
          const messagePayload = {
            subject: finalSubject,
            body: { contentType: "HTML", content: finalBody },
            toRecipients: [
              { emailAddress: { address: finalRecipient } },
            ],
          };

          // 🚀 Microsoft Graph API requires custom headers to start with 'x-' or 'X-'
          const headers = [];

          if (emailId) {
            headers.push({
              name: "X-Unibox-Email-Id",
              value: emailId,
            });
          }

          if (
            !isWarmup &&
            finalBody &&
            finalBody.includes("/tracking/unsubscribe/")
          ) {
            const appUrl =
              process.env.APP_URL ||
              process.env.VITE_API_URL ||
              "http://localhost:8080";
            const unsubUrl = `${appUrl}/api/v1/tracking/unsubscribe/${emailId}`;
            headers.push(
              { name: "X-List-Unsubscribe", value: `<${unsubUrl}>` },
              {
                name: "X-List-Unsubscribe-Post",
                value: "List-Unsubscribe=One-Click",
              },
            );
          }

          // ONLY add the property if there are actually headers to send
          if (headers.length > 0) {
            messagePayload.internetMessageHeaders = headers;
          }

          const axiosConfig = { headers: { Authorization: `Bearer ${token}` } };
          if (proxy) {
            axiosConfig.httpsAgent = new SocksProxyAgent(proxy);
            axiosConfig.proxy = false;
          }

          const res = await axios.post(
            "https://graph.microsoft.com/v1.0/me/messages",
            messagePayload,
            axiosConfig
          );

          providerMessageId = res.data.id;
          providerConversationId = res.data.conversationId;
          providerThreadId = res.data.conversationId; // Map to threadId for unified tracking
          
          log("DEBUG", "Captured Outlook Identifiers", {
            providerMessageId,
            providerConversationId,
            internetMessageId: res.data.internetMessageId
          });

          // 2. Send the message
          await axios.post(
            `https://graph.microsoft.com/v1.0/me/messages/${res.data.id}/send`,
            {},
            axiosConfig
          );

          // Update message with internetMessageId if it wasn't returned in the first call
          // (Sometimes it's only finalized after send)
          internetMessageId = res.data.internetMessageId;


        }

        /* =========================
           SUCCESS UPDATE
        ========================= */

        if (!isWarmup) {
          await emailRecord.update({
            status: "sent",
            sentAt: DateTime.now().toJSDate(),
            providerMessageId,
            providerThreadId,
            providerConversationId,
            metadata: {
              ...emailRecord.metadata,
              internetMessageId
            }
          });

          await EmailEvent.create({
            emailId,
            eventType: "sent",
            eventTimestamp: DateTime.now().toJSDate(),
          });

          // 📊 UPDATE CAMPAIGN STATS
          if (emailRecord.campaignId) {
            const statsUpdates = [
              CampaignSend.update(
                {
                  status: "sent",
                  sentAt: DateTime.now().toJSDate(),
                },
                { where: { emailId: emailRecord.id } },
              ),
            ];

            // Only increment totalSent for Step 0 (the initial outreach)
            if (emailRecord.metadata?.step === 0) {
              statsUpdates.push(
                Campaign.increment("totalSent", {
                  where: { id: emailRecord.campaignId },
                })
              );
            }

            await Promise.all(statsUpdates);
          }
        }

        log("INFO", "✅ Email sent successfully", {
          emailId,
          recipient: finalRecipient,
          providerMessageId,
          domain,
          isWarmup
        });

        // 🏛️ SYNC LEAD TO CRM
        if (!isWarmup) {
          // Internal
          syncLead(emailRecord.userId, emailRecord.recipientEmail, "sent").catch(e =>
            log("ERROR", "Failed to sync lead to CRM", { error: e.message })
          );
          // External
          syncLeadToAllCRMs(emailRecord.userId, emailRecord.recipientEmail, "sent").catch(e =>
            log("ERROR", "Failed to sync lead to external CRM", { error: e.message })
          );
        }

        channel.ack(msg);
      } catch (err) {
        let errorMetadata = {
          error: err.message,
          stack: err.stack,
          emailId,
          isWarmup
        };

        // Capture Axios 400 error details (payload mismatch)
        if (err.response?.status === 400) {
          errorMetadata.responseBody = err.response.data;
          errorMetadata.requestData = err.config?.data;
        }

        log("ERROR", "Send failed", errorMetadata);

        const isProxyError =
          err.code === "ECONNREFUSED" ||
          err.code === "ETIMEDOUT" ||
          err.message.toLowerCase().includes("socks5") ||
          err.message.toLowerCase().includes("proxy");

        if (isProxyError) {
          log("WARN", "♻️ Proxy failure detected. Rotating sticky session for next send.", { sender: sender?.email });
          await deleteProxySticky(sender?.email);
        }

        if (!isWarmup && emailRecord) {
          await emailRecord.update({
            status: "failed",
            lastError: err.message,
          });

          // 📊 UPDATE CAMPAIGN SEND STATUS
          await CampaignSend.update(
            { status: "failed" },
            { where: { emailId: emailRecord.id } },
          );

          const bounceType = classifyBounce(err);
          await BounceEvent.create({
            emailId: emailRecord.id,
            bounceType,
            reason: err.message,
            occurredAt: DateTime.now().toJSDate(),
          });

          // 🛡️ REPUTATION PROTECTION (GLOBAL GUARD)
          if (bounceType === "hard" && sender) {
            log("DEBUG", "🔍 Checking Global Bounce Limit for sender...", { senderId: sender.id });
            const triggered = await senderHealthService.checkGlobalBounceLimit(sender.id);
            if (triggered) {
              log("CRITICAL", "🚫 Sender PAUSED PLATFORM-WIDE - Hard bounce threshold exceeded.", { sender: sender.email });
            }
          }

          // 📊 Increment campaign bounce stats
          if (emailRecord.campaignId) {
            let incrementField = null;
            if (bounceType === "hard" || bounceType === "soft") {
              incrementField = "totalBounced";
            } else if (bounceType === "complaint") {
              incrementField = "totalSenderBounced";
            }

            if (incrementField) {
              await Campaign.increment(incrementField, {
                where: { id: emailRecord.campaignId },
              });

              // 🛑 AUTO-PAUSE ON HIGH BOUNCE RATE (CAMPAIGN LEVEL)
              const campaign = await Campaign.findByPk(emailRecord.campaignId, {
                attributes: ["id", "status", "totalSent", "totalBounced"],
              });

              if (campaign && campaign.status === "running" && campaign.totalSent >= 50) {
                const bounceRate = (campaign.totalBounced / campaign.totalSent) * 100;
                if (bounceRate >= 5) {
                  await campaign.update({
                    status: "paused",
                    pauseReason: `Auto-paused due to high bounce rate (${bounceRate.toFixed(2)}%). Domain reputation protection active.`,
                  });
                  log("WARN", "🚨 Campaign AUTO-PAUSED due to high bounce rate", {
                    campaignId: campaign.id,
                    bounceRate: `${bounceRate.toFixed(2)}%`,
                  });
                }
              }
            }
          }

          // 🛑 STOP RECIPIENT ON HARD BOUNCE
          if (bounceType === "hard" && emailRecord.recipientId) {
            await CampaignRecipient.update(
              { status: "bounced", nextRunAt: null },
              { where: { id: emailRecord.recipientId } },
            );
          }
        }

        channel.ack(msg);
      }
    });

    channel.on("close", () => {
      log("WARN", "Channel closed, restarting in 5s...");
      setTimeout(startWorker, 5000);
    });
  } catch (err) {
    log("ERROR", "Worker failed to start", { error: err.message });
    setTimeout(startWorker, 5000);
  }
}

startWorker();
