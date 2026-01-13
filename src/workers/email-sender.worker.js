// src/workers/email-sender.worker.js
import "../models/index.js";
import nodemailer from "nodemailer";
import { randomUUID } from "crypto";

import Email from "../models/email.model.js";
import Sender from "../models/sender.model.js";
import CampaignSend from "../models/campaign-send.model.js";
import EmailEvent from "../models/email-event.model.js";
import BounceEvent from "../models/bounce-event.model.js";
import Campaign from "../models/campaign.model.js";

import { getChannel } from "../queues/rabbit.js";
import { QUEUES } from "../queues/queues.js";
import { getValidMicrosoftToken } from "../utils/get-valid-microsoft-token.js";

const log = (level, message, meta = {}) =>
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "email-sender",
      level,
      message,
      ...meta,
    })
  );

function generateMessageId(emailId, domain) {
  return `<${emailId}.${randomUUID().slice(0, 8)}.${Date.now()}@${domain}>`;
}

(async () => {
  const channel = await getChannel();
  await channel.assertQueue(QUEUES.EMAIL_SEND, { durable: true });
  channel.prefetch(5);

  log("INFO", "📧 Email Sender ready");

  channel.consume(QUEUES.EMAIL_SEND, async (msg) => {
    const { emailId } = JSON.parse(msg.content.toString());

    let email, sender, send;

    try {
      email = await Email.findByPk(emailId);
      if (!email || email.status === "sent") return channel.ack(msg);

      sender = await Sender.findByPk(email.senderId);
      if (!sender || !sender.isVerified) {
        throw new Error("Sender unavailable");
      }

      send = await CampaignSend.findOne({ where: { emailId } });
      if (send && send.status !== "queued") return channel.ack(msg);

      await EmailEvent.create({
        emailId,
        eventType: "queued",
        eventTimestamp: new Date(),
      });

      const messageId = generateMessageId(emailId, sender.email.split("@")[1]);

      if (sender.provider === "outlook") {
        const token = await getValidMicrosoftToken(sender);

        const res = await fetch(
          "https://graph.microsoft.com/v1.0/me/sendMail",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              message: {
                subject: email.metadata.subject,
                body: {
                  contentType: "HTML",
                  content: email.metadata.htmlBody,
                },
                toRecipients: [
                  { emailAddress: { address: email.recipientEmail } },
                ],
                internetMessageId: messageId,
              },
              saveToSentItems: true,
            }),
          }
        );

        if (!res.ok) throw new Error(`Graph API ${res.status}`);
      } else {
        const transporter = nodemailer.createTransport({
          host: sender.smtpHost,
          port: sender.smtpPort,
          secure: sender.smtpSecure,
          auth: {
            user: sender.smtpUser,
            pass: sender.smtpPass,
          },
        });

        await transporter.sendMail({
          from: `"${sender.displayName}" <${sender.email}>`,
          to: email.recipientEmail,
          subject: email.metadata.subject,
          html: email.metadata.htmlBody,
          messageId,
        });
      }

      await Promise.all([
        email.update({
          status: "sent",
          providerMessageId: messageId,
          sentAt: new Date(),
        }),
        CampaignSend.update(
          { status: "sent", sentAt: new Date() },
          { where: { emailId } }
        ),
        Campaign.increment("totalSent", {
          by: 1,
          where: { id: email.campaignId },
        }),
        EmailEvent.create({
          emailId,
          eventType: "sent",
          eventTimestamp: new Date(),
        }),
      ]);

      log("INFO", "✅ Email sent", { emailId });

      channel.ack(msg);
    } catch (err) {
      log("ERROR", "❌ Send failed", { emailId, error: err.message });

      if (email) {
        await email.update({
          status: "failed",
          lastError: err.message.slice(0, 500),
        });
      }

      if (send) {
        await CampaignSend.update(
          { status: "failed", error: err.message.slice(0, 500) },
          { where: { emailId } }
        );
      }

      await BounceEvent.create({
        emailId,
        bounceType: "hard",
        reason: err.message.slice(0, 500),
        occurredAt: new Date(),
      });

      channel.ack(msg);
    }
  });
})();
