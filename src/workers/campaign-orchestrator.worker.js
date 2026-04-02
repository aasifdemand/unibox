import "../models/index.js";
import { initGlobalErrorHandlers } from "../utils/error-handler.js";
initGlobalErrorHandlers();

import Campaign from "../models/campaign.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import CampaignStep from "../models/campaign-step.model.js";
import CampaignSend from "../models/campaign-send.model.js";
import Email from "../models/email.model.js";
import GlobalEmailRegistry from "../models/global-email-registry.model.js";
import { getSenderWithType, sequelize } from "../models/index.js";

import { getRabbitChannel as getChannel } from "../queues/rabbit.js";
import { QUEUES } from "../queues/queues.js";
import { renderTemplate } from "../utils/template-renderer.js";
import { injectTracking } from "../utils/tracking-injector.js";
import { tryCompleteCampaign } from "../utils/campaign-completion.checker.js";
import crypto from "crypto";

import { DateTime } from "luxon";

function nextSendableTime(campaign) {
  const tz        = campaign.timezone  || "UTC";
  const days      = campaign.sendingDays || ["monday","tuesday","wednesday","thursday","friday"];
  const startTime = campaign.startTime  || "09:00";
  const endTime   = campaign.endTime    || "18:00";

  const [startH, startM] = startTime.split(":").map(Number);
  const [endH,   endM  ] = endTime.split(":").map(Number);

  let cursor = DateTime.now().setZone(tz);
  for (let i = 0; i < 14 * 24 * 60; i += 1) {
    const dayName    = cursor.toFormat("EEEE").toLowerCase();
    const curMinutes = cursor.hour * 60 + cursor.minute;
    const startMins  = startH * 60 + startM;
    const endMins    = endH   * 60 + endM;
    if (days.includes(dayName) && curMinutes >= startMins && curMinutes < endMins) return null;
    cursor = cursor.plus({ minutes: 1 });
  }
  return DateTime.now().setZone(tz).plus({ days: 1 }).set({ hour: startH, minute: startM }).toJSDate();
}

const log = (level, message, meta = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: "campaign-orchestrator", level, message, ...meta }));



async function startWorker() {
  let channel;
  try {
    channel = await getChannel();
    await channel.assertQueue(QUEUES.CAMPAIGN_SEND, { durable: true });
    await channel.assertQueue(QUEUES.EMAIL_ROUTE, { durable: true });
    channel.prefetch(1);

    channel.consume(QUEUES.CAMPAIGN_SEND, async (msg) => {
      if (!msg) return;
      const { campaignId, recipientId } = JSON.parse(msg.content.toString());

      try {
        const campaign = await Campaign.findByPk(campaignId);
        const recipient = await CampaignRecipient.findByPk(recipientId);

        if (!campaign || campaign.status !== "running" || !recipient || recipient.status !== "pending") {
          return channel.ack(msg);
        }

        const t = await sequelize.transaction();
        try {
          const step = Number.isInteger(recipient.currentStep) ? recipient.currentStep : 0;
          if (step === 0) {
             await CampaignStep.upsert({
                campaignId: campaign.id,
                stepOrder: 0,
                subject: campaign.subject || "No Subject",
                htmlBody: campaign.htmlBody || "<p></p>",
                textBody: campaign.textBody || "",
                delayMinutes: 0,
                condition: "always",
              }, { transaction: t });
          }

          const stepConfig = await CampaignStep.findOne({ 
            where: { campaignId, stepOrder: step },
            transaction: t
          });

          if (!stepConfig) {
            await recipient.update({ status: "completed", nextRunAt: null }, { transaction: t });
            await tryCompleteCampaign(campaignId, { transaction: t });
            await t.commit();
            return channel.ack(msg);
          }

          const globalRegistry = await GlobalEmailRegistry.findOne({ 
            where: { normalizedEmail: recipient.email.toLowerCase() },
            transaction: t
          });

          if (globalRegistry?.unsubscribed) {
            await recipient.update({ status: "unsubscribed", nextRunAt: null }, { transaction: t });
            await tryCompleteCampaign(campaignId, { transaction: t });
            await t.commit();
            return channel.ack(msg);
          }

          const vs = globalRegistry?.verificationStatus;
          if (!vs || vs === "invalid" || vs === "unknown" || vs === "verifying" || (vs === "risky" && campaign.blockRiskyEmails)) {
            await recipient.update({ status: "stopped", nextRunAt: null }, { transaction: t });
            await tryCompleteCampaign(campaignId, { transaction: t });
            await t.commit();
            return channel.ack(msg);
          }

          if (step > 0 && stepConfig.condition !== "always") {
            const previousSend = await CampaignSend.findOne({
              where: { campaignId, recipientId, step: step - 1 },
              order: [["createdAt", "DESC"]],
              transaction: t
            });
            let conditionMet = false;
            if (previousSend) {
              if (stepConfig.condition === "no_reply" && !previousSend.repliedAt) conditionMet = true;
              if (stepConfig.condition === "on_open" && previousSend.openedAt) conditionMet = true;
              if (stepConfig.condition === "on_click" && previousSend.clickedAt) conditionMet = true;
            }
            if (!conditionMet) {
              await recipient.update({ currentStep: step + 1, nextRunAt: new Date() }, { transaction: t });
              await t.commit();
              channel.sendToQueue(QUEUES.CAMPAIGN_SEND, Buffer.from(JSON.stringify({ campaignId, recipientId })));
              return channel.ack(msg);
            }
          }

          const nextValidTime = nextSendableTime(campaign);
          if (nextValidTime !== null) {
            await recipient.update({ nextRunAt: nextValidTime }, { transaction: t });
            await t.commit();
            return channel.ack(msg);
          }

          let senderIdToUse = campaign.senderId;
          if (campaign.senderIds?.length > 0) senderIdToUse = campaign.senderIds[Math.floor(Math.random() * campaign.senderIds.length)];
          const sender = await getSenderWithType(senderIdToUse, campaign.senderType);

          const [send, created] = await CampaignSend.findOrCreate({
            where: { campaignId, recipientId, step },
            defaults: { senderId: senderIdToUse, status: "queued" },
            transaction: t
          });

          if (!created && send.status !== "queued") {
            await t.rollback();
            return channel.ack(msg);
          }

          const variables = {
            email: recipient.email,
            name: recipient.name || "",
            first_name: (recipient.name || "").split(" ")[0] || "",
            sender_name: sender?.displayName || sender?.name || "",
            ...recipient.metadata
          };

          const activeSubject = stepConfig.subject;
          const activeHtml = stepConfig.htmlBody;
          const activeText = stepConfig.textBody;

          const emailId = crypto.randomUUID();
          const email = await Email.create({
            id: emailId,
            userId: campaign.userId,
            campaignId,
            senderId: senderIdToUse,
            senderType: campaign.senderType,
            recipientEmail: recipient.email,
            recipientId: recipient.id,
            subject: renderTemplate(activeSubject, variables),
            htmlBody: injectTracking(renderTemplate(activeHtml, variables), emailId, {
              trackOpens: campaign.trackOpens,
              trackClicks: campaign.trackClicks,
              unsubscribeLink: campaign.unsubscribeLink,
            }),
            textBody: renderTemplate(activeText, variables),
            status: "pending",
            metadata: { step },
          }, { transaction: t });

          const nextStep = stepConfig.onConditionStepOrder || step + 1;
          const nextStepConfig = await CampaignStep.findOne({ where: { campaignId, stepOrder: nextStep }, transaction: t });
          if (nextStepConfig) {
            await recipient.update({
              status: "pending", currentStep: nextStep, lastSentAt: new Date(),
              nextRunAt: DateTime.now().plus({ minutes: nextStepConfig.delayMinutes || 0 }).toJSDate()
            }, { transaction: t });
          } else {
            await recipient.update({ status: "completed", currentStep: nextStep, lastSentAt: new Date(), nextRunAt: null }, { transaction: t });
            await tryCompleteCampaign(campaignId, { transaction: t });
          }

          await send.update({ emailId: email.id, status: "sent" }, { transaction: t });
          await t.commit();
          channel.sendToQueue(QUEUES.EMAIL_ROUTE, Buffer.from(JSON.stringify({ emailId: email.id })), { persistent: true });
        } catch (txnErr) {
          await t.rollback();
          throw txnErr;
        }
        channel.ack(msg);
      } catch (err) {
        log("ERROR", "❌ Orchestrator failed", { campaignId, recipientId, error: err.message });
        const headers = msg.properties.headers || {};
        const retryCount = (headers["x-retry-count"] || 0) + 1;
        if (retryCount <= 3) {
          channel.publish("", QUEUES.CAMPAIGN_SEND, msg.content, { headers: { "x-retry-count": retryCount }, persistent: true });
        } else {
          const dlq = `${QUEUES.CAMPAIGN_SEND}_DLQ`;
          await channel.assertQueue(dlq, { durable: true });
          channel.sendToQueue(dlq, msg.content, { headers: { ...headers, "x-final-error": err.message }, persistent: true });
        }
        channel.ack(msg);
      }
    });

    channel.on("close", () => setTimeout(startWorker, 5000));
  } catch (err) {
    console.error("💥 Orchestrator failed to start:", err);
    setTimeout(startWorker, 5000);
  }
}

startWorker();
