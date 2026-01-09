import "../models/index.js";
import nodemailer from "nodemailer";

import Email from "../models/email.model.js";
import Sender from "../models/sender.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import EmailEvent from "../models/email-event.model.js";
import BounceEvent from "../models/bounce-event.model.js";

import { getChannel } from "../queues/rabbitmq.js";
import { QUEUES } from "../queues/queues.js";

/* =========================
   STRUCTURED LOGGER
========================= */
const log = (level, message, meta = {}) => {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "email-sender",
      level,
      message,
      ...meta,
    })
  );
};

/* =========================
   WORKER BOOT
========================= */
(async () => {
  const channel = await getChannel();
  await channel.assertQueue(QUEUES.EMAIL_SEND, { durable: true });
  channel.prefetch(5);

  log("INFO", "📧 Email Sender started", {
    queue: QUEUES.EMAIL_SEND,
    prefetch: 5,
  });

  channel.consume(QUEUES.EMAIL_SEND, async (msg) => {
    if (!msg) return;

    const { emailId } = JSON.parse(msg.content.toString());

    log("INFO", "📥 Email job received", {
      emailId,
      deliveryTag: msg.fields.deliveryTag,
    });

    try {
      /* =========================
         LOAD EMAIL
      ========================= */
      const email = await Email.findByPk(emailId);

      if (!email) {
        log("WARN", "Email not found — acking", { emailId });
        channel.ack(msg);
        return;
      }

      if (email.status === "sent") {
        log("INFO", "Email already sent — skipping", { emailId });
        channel.ack(msg);
        return;
      }

      /* =========================
         LOAD SENDER
      ========================= */
      const sender = await Sender.findByPk(email.senderId);

      if (!sender) {
        throw new Error("Sender not found");
      }

      /* =========================
         EMAIL EVENT → QUEUED
      ========================= */
      await EmailEvent.create({
        emailId: email.id,
        eventType: "queued",
        eventTimestamp: new Date(),
        metadata: {
          queue: QUEUES.EMAIL_SEND,
          senderId: sender.id,
        },
      });

      log("DEBUG", "🔐 Using SMTP config", {
        senderId: sender.id,
        provider: sender.provider,
        smtpHost: sender.smtpHost,
        smtpUser: sender.smtpUser,
      });

      /* =========================
         SMTP TRANSPORT
      ========================= */
      const transporter = nodemailer.createTransport({
        host: sender.smtpHost,
        port: sender.smtpPort,
        secure: sender.smtpSecure,
        auth: {
          user: sender.smtpUser,
          pass: sender.smtpPass,
        },
      });

      /* =========================
         SEND EMAIL
      ========================= */
      const start = Date.now();

      const result = await transporter.sendMail({
        from: `"${sender.displayName}" <${sender.email}>`,
        to: email.recipientEmail,
        subject: email.metadata.subject,
        html: email.metadata.htmlBody,
      });

      const durationMs = Date.now() - start;

      /* =========================
         EMAIL EVENT → SENT
      ========================= */
      await EmailEvent.create({
        emailId: email.id,
        eventType: "sent",
        eventTimestamp: new Date(),
        metadata: {
          provider: sender.provider,
          messageId: result.messageId,
          response: result.response,
          durationMs,
        },
      });

      await email.update({
        status: "sent",
        providerMessageId: result.messageId,
        sentAt: new Date(),
      });

      log("INFO", "✅ Email SENT", {
        emailId,
        campaignId: email.campaignId,
        messageId: result.messageId,
        durationMs,
      });

      channel.ack(msg);
    } catch (err) {
      log("ERROR", "💥 SMTP send failed", {
        emailId,
        error: err.message,
        code: err.code,
        response: err.response,
      });

      /* =========================
         EMAIL EVENT → FAILED
      ========================= */
      await EmailEvent.create({
        emailId,
        eventType: "failed",
        eventTimestamp: new Date(),
        metadata: {
          error: err.message,
          code: err.code,
          response: err.response,
        },
      });

      /* =========================
         BOUNCE EVENT (HARD / SOFT)
      ========================= */
      await BounceEvent.create({
        emailId,
        bounceType:
          err.responseCode && err.responseCode >= 500 ? "hard" : "soft",
        reason: err.message,
        smtpResponse: err.response,
        occurredAt: new Date(),
        metadata: {
          code: err.code,
        },
      });

      /* =========================
         STOP RECIPIENT
      ========================= */
      await CampaignRecipient.update(
        { status: "bounced" },
        { where: { email: email?.recipientEmail } }
      );

      /* =========================
         RETRY (TRANSIENT ONLY)
      ========================= */
      channel.nack(msg, false, true);
    }
  });
})();
