import "../models/index.js";
import Redis from "ioredis";
import Email from "../models/email.model.js";
import Sender from "../models/sender.model.js";

import { getChannel } from "../queues/rabbit.js";
import { QUEUES } from "../queues/queues.js";
import { mtaDetectorCache } from "../services/mta-detector-cache.service.js";
import { EmailProvider } from "../enums/email-provider.enum.js";

const redis = new Redis(process.env.REDIS_URL);

/* =========================
   PROVIDER RATE LIMITS
========================= */
const PROVIDER_LIMITS = {
  [EmailProvider.GOOGLE]: 20,
  [EmailProvider.MICROSOFT]: 15,
  [EmailProvider.YAHOO]: 10,
  default: 5,
};

/* =========================
   LOGGER
========================= */
const log = (level, message, meta = {}) =>
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "email-router",
      level,
      message,
      ...meta,
    })
  );

/* =========================
   PROVIDER → SENDER MAP
========================= */
function mapProviderToSenderType(provider) {
  switch (provider) {
    case EmailProvider.GOOGLE:
      return "gmail";
    case EmailProvider.MICROSOFT:
      return "outlook";
    default:
      return null; // generic SMTP
  }
}

(async () => {
  const channel = await getChannel();
  await channel.assertQueue(QUEUES.EMAIL_ROUTE, { durable: true });
  await channel.assertQueue(QUEUES.EMAIL_SEND, { durable: true });

  channel.prefetch(5);

  log("INFO", "🚦 Email Router ready");

  channel.consume(QUEUES.EMAIL_ROUTE, async (msg) => {
    if (!msg) return;

    let emailId;

    try {
      emailId = JSON.parse(msg.content.toString()).emailId;
    } catch {
      return channel.ack(msg);
    }

    try {
      /* =========================
         LOAD EMAIL
      ========================= */
      const email = await Email.findByPk(emailId);
      if (!email) return channel.ack(msg);

      // 🔒 Idempotency: already routed
      if (email.senderId) {
        log("DEBUG", "⏭️ Email already routed", { emailId });
        return channel.ack(msg);
      }

      /* =========================
         MTA DETECTION
      ========================= */
      const mta = await mtaDetectorCache.detect(email.recipientEmail);
      const provider = mta.provider || EmailProvider.UNKNOWN;

      log("DEBUG", "📡 Provider detected", {
        emailId,
        provider,
        confidence: mta.confidence,
      });

      /* =========================
         PROVIDER RATE LIMIT
      ========================= */
      const windowKey = `rate:${provider}:${Math.floor(Date.now() / 60000)}`;
      const count = await redis.incr(windowKey);
      await redis.expire(windowKey, 60);

      const limit = PROVIDER_LIMITS[provider] || PROVIDER_LIMITS.default;

      if (count > limit) {
        await redis.decr(windowKey);

        log("WARN", "⏳ Provider rate limit hit, re-queueing", {
          emailId,
          provider,
          limit,
        });

        setTimeout(() => {
          channel.sendToQueue(QUEUES.EMAIL_ROUTE, msg.content, {
            persistent: true,
          });
        }, 5000);

        return channel.ack(msg);
      }

      /* =========================
         SENDER SELECTION (SMART)
      ========================= */
      const preferredSenderType = mapProviderToSenderType(provider);

      let sender = null;

      // 1️⃣ Try provider-matched sender
      if (preferredSenderType) {
        sender = await Sender.findOne({
          where: {
            isVerified: true,
            provider: preferredSenderType,
          },
          order: [["updatedAt", "ASC"]],
        });
      }

      // 2️⃣ Fallback to any verified sender
      if (!sender) {
        sender = await Sender.findOne({
          where: { isVerified: true },
          order: [["updatedAt", "ASC"]],
        });
      }

      if (!sender) {
        throw new Error("No verified sender available");
      }

      /* =========================
         ASSIGN & ROUTE
      ========================= */
      await email.update({
        senderId: sender.id,
        deliveryProvider: provider,
        deliveryConfidence: mta.confidence,
        routedAt: new Date(),
      });

      channel.sendToQueue(
        QUEUES.EMAIL_SEND,
        Buffer.from(JSON.stringify({ emailId })),
        { persistent: true }
      );

      log("INFO", "➡️ Email routed", {
        emailId,
        provider,
        sender: sender.email,
      });

      channel.ack(msg);
    } catch (err) {
      log("ERROR", "❌ Routing failed", {
        emailId,
        error: err.message,
      });

      channel.ack(msg);
    }
  });
})();
