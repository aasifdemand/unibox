// src/workers/campaign-orchestrator.worker.js
import "../models/index.js";

import Campaign from "../models/campaign.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import CampaignStep from "../models/campaign-step.model.js";
import CampaignSend from "../models/campaign-send.model.js";
import Email from "../models/email.model.js";
import GlobalEmailRegistry from "../models/global-email-registry.model.js";

import { getChannel } from "../queues/rabbit.js";
import { QUEUES } from "../queues/queues.js";
import { renderTemplate } from "../utils/template-renderer.js";
import { tryCompleteCampaign } from "../utils/campaign-completion.checker.js";

import dayjs from "dayjs";

/* =========================
   LOGGER
========================= */
const log = (level, message, meta = {}) =>
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "campaign-orchestrator",
      level,
      message,
      ...meta,
    })
  );

/* =========================
   ENSURE STEP 0 EXISTS
========================= */
async function ensureStepZero(campaign) {
  const existing = await CampaignStep.findOne({
    where: { campaignId: campaign.id, stepOrder: 0 },
  });

  if (existing) return existing;

  log("INFO", "🧱 Auto-creating step 0", { campaignId: campaign.id });

  return CampaignStep.create({
    campaignId: campaign.id,
    stepOrder: 0,
    subject: campaign.subject,
    htmlBody: campaign.htmlBody,
    textBody: campaign.textBody,
    delayMinutes: 0,
    condition: "always",
  });
}

/* =========================
   WORKER
========================= */
(async () => {
  const channel = await getChannel();

  await channel.assertQueue(QUEUES.CAMPAIGN_SEND, { durable: true });
  await channel.assertQueue(QUEUES.EMAIL_ROUTE, { durable: true });

  channel.prefetch(1);

  log("INFO", "🚀 Campaign Orchestrator ready");

  channel.consume(QUEUES.CAMPAIGN_SEND, async (msg) => {
    if (!msg) return;

    const { campaignId, recipientId } = JSON.parse(msg.content.toString());

    try {
      const campaign = await Campaign.findByPk(campaignId);
      const recipient = await CampaignRecipient.findByPk(recipientId);

      /* =========================
         HARD GUARDS
      ========================= */
      if (!campaign || campaign.status !== "running") {
        return channel.ack(msg);
      }

      if (!recipient || recipient.status !== "pending") {
        return channel.ack(msg);
      }

      const step = Number.isInteger(recipient.currentStep)
        ? recipient.currentStep
        : 0;

      log("DEBUG", "🧩 Processing step", {
        campaignId,
        recipientId,
        step,
      });

      /* =========================
         STEP 0 SAFETY
      ========================= */
      if (step === 0) {
        await ensureStepZero(campaign);
      }

      const stepConfig = await CampaignStep.findOne({
        where: { campaignId, stepOrder: step },
      });

      /* =========================
         NO MORE STEPS → COMPLETE
      ========================= */
      if (!stepConfig) {
        await recipient.update({
          status: "completed",
          nextRunAt: null,
        });

        log("INFO", "🏁 Recipient completed campaign", {
          campaignId,
          recipientId,
        });

        await tryCompleteCampaign(campaignId);
        return channel.ack(msg);
      }

      /* =========================
         EMAIL VERIFICATION
      ========================= */
      const verified = await GlobalEmailRegistry.findOne({
        where: {
          normalizedEmail: recipient.email.toLowerCase(),
          verificationStatus: "valid",
        },
      });

      if (!verified) {
        await recipient.update({
          status: "stopped",
          nextRunAt: null,
        });

        log("WARN", "⛔ Email not verified — recipient stopped", {
          recipientId,
        });

        await tryCompleteCampaign(campaignId);
        return channel.ack(msg);
      }

      /* =========================
         IDEMPOTENT SEND
      ========================= */
      const [send, created] = await CampaignSend.findOrCreate({
        where: { campaignId, recipientId, step },
        defaults: {
          senderId: campaign.senderId,
          status: "queued",
        },
      });

      if (!created && send.status !== "queued") {
        return channel.ack(msg);
      }

      /* =========================
         TEMPLATE RENDERING
      ========================= */
      const vars = {
        name: recipient.name || "there",
        email: recipient.email,
        ...(recipient.metadata || {}),
      };

      const email = await Email.create({
        userId: campaign.userId,
        campaignId,
        senderId: campaign.senderId, // temp, router may rotate
        recipientEmail: recipient.email,
        metadata: {
          subject: renderTemplate(stepConfig.subject, vars),
          htmlBody: renderTemplate(stepConfig.htmlBody, vars),
          step,
        },
      });

      /* =========================
         NEXT STEP SCHEDULING
      ========================= */
      await Promise.all([
        recipient.update({
          status: "sent",
          currentStep: step + 1,
          lastSentAt: new Date(),
          nextRunAt: dayjs()
            .add(stepConfig.delayMinutes || 0, "minute")
            .toDate(),
        }),
        send.update({ emailId: email.id }),
      ]);

      /* =========================
         ROUTE EMAIL
      ========================= */
      channel.sendToQueue(
        QUEUES.EMAIL_ROUTE,
        Buffer.from(JSON.stringify({ emailId: email.id })),
        { persistent: true }
      );

      log("INFO", "📨 Email routed", {
        emailId: email.id,
        campaignId,
        recipientId,
      });

      channel.ack(msg);
    } catch (err) {
      log("ERROR", "❌ Orchestrator failed", {
        campaignId,
        recipientId,
        error: err.message,
      });
      channel.ack(msg);
    }
  });
})();
