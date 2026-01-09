import "../models/index.js";

import Campaign from "../models/campaign.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import CampaignStep from "../models/campaign-step.model.js";
import Email from "../models/email.model.js";

import { getChannel } from "../queues/rabbitmq.js";
import { QUEUES } from "../queues/queues.js";
import { renderTemplate } from "../utils/template-renderer.js";

/* =========================
   STRUCTURED LOGGER
========================= */
const log = (level, message, meta = {}) => {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      service: "campaign-orchestrator",
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

  await channel.assertQueue(QUEUES.CAMPAIGN_SEND, { durable: true });
  channel.prefetch(1);

  log("INFO", "🚀 Campaign Orchestrator started", {
    queue: QUEUES.CAMPAIGN_SEND,
    prefetch: 1,
  });

  channel.consume(QUEUES.CAMPAIGN_SEND, async (msg) => {
    if (!msg) return;

    const payload = JSON.parse(msg.content.toString());
    const { campaignId, recipientId, step } = payload;

    log("INFO", "📥 Orchestration job received", payload);

    try {
      /* =========================
         LOAD CORE DATA
      ========================= */
      const campaign = await Campaign.findByPk(campaignId);
      const recipient = await CampaignRecipient.findByPk(recipientId);

      if (!campaign || !recipient) {
        log("WARN", "⚠️ Campaign or recipient missing — acking", payload);
        channel.ack(msg);
        return;
      }

      if (campaign.status !== "running") {
        log("INFO", "⏸ Campaign not running — skipping", {
          campaignId,
          status: campaign.status,
        });
        channel.ack(msg);
        return;
      }

      if (recipient.status !== "pending") {
        log("INFO", "⏭ Recipient already processed — skipping", {
          recipientId,
          status: recipient.status,
        });
        channel.ack(msg);
        return;
      }

      /* =========================
         STEP RESOLUTION
      ========================= */
      let stepConfig;

      if (step === 0) {
        stepConfig = campaign; // initial email
      } else {
        stepConfig = await CampaignStep.findOne({
          where: {
            campaignId,
            stepOrder: step,
          },
        });
      }

      if (!stepConfig) {
        log("INFO", "🏁 No step found — recipient completed", {
          recipientId,
          step,
        });

        await recipient.update({
          status: "completed",
        });

        channel.ack(msg);
        return;
      }

      /* =========================
         TEMPLATE VARIABLES
      ========================= */
      log("DEBUG", "🧩 Rendering template", {
        recipientId,
        step,
      });

      const variables = {
        name: recipient.name || "there",
        email: recipient.email,

        // copy-safe defaults
        industry: recipient.metadata?.industry,
        jobTitle: recipient.metadata?.jobTitle,
        company: recipient.metadata?.company,

        ...(recipient.metadata || {}),
      };


      const renderedSubject = renderTemplate(
        stepConfig.subject,
        variables
      );

      const renderedHtml = renderTemplate(
        stepConfig.htmlBody,
        variables
      );


      /* =========================
         CREATE EMAIL RECORD
      ========================= */
      const email = await Email.create({
        userId: campaign.userId,
        campaignId,
        senderId: campaign.senderId,
        recipientEmail: recipient.email,
        metadata: {
          subject: renderedSubject,
          htmlBody: renderedHtml,
        },
      });

      /* =========================
         UPDATE RECIPIENT STATE
      ========================= */
      await recipient.update({
        status: "sent",
        lastSentAt: new Date(),
        currentStep: step + 1,
      });

      log("INFO", "📨 Email created & queued", {
        campaignId,
        recipientId,
        emailId: email.id,
        step,
        nextStep: step + 1,
      });

      /* =========================
         QUEUE EMAIL SEND
      ========================= */
      channel.sendToQueue(
        QUEUES.EMAIL_SEND,
        Buffer.from(
          JSON.stringify({
            emailId: email.id,
          })
        ),
        { persistent: true }
      );

      channel.ack(msg);
    } catch (err) {
      log("ERROR", "💥 Orchestration failed", {
        payload,
        error: err.message,
        stack: err.stack,
      });

      /**
       * IMPORTANT:
       * Requeue ONLY transient failures.
       * Code bugs should be ACKed after fix.
       */
      channel.nack(msg, false, true);
    }
  });
})();
