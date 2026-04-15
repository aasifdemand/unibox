import "../models/index.js";
import { initGlobalErrorHandlers } from "../utils/error-handler.js";
initGlobalErrorHandlers();

import Campaign from "../models/campaign.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import CampaignStep from "../models/campaign-step.model.js";
import CampaignSend from "../models/campaign-send.model.js";
import Email from "../models/email.model.js";
import GlobalEmailRegistry from "../models/global-email-registry.model.js";
import SenderHealth from "../models/sender-health.model.js";
import { getSenderWithType } from "../models/index.js";

import { getRabbitChannel as getChannel } from "../queues/rabbit.js";
import { QUEUES } from "../queues/queues.js";
import { renderTemplate } from "../utils/template-renderer.js";
import { injectTracking } from "../utils/tracking-injector.js";
import { tryCompleteCampaign } from "../utils/campaign-completion.checker.js";
import crypto from "crypto";

import { DateTime } from "luxon";
import sequelize from "../config/db.js";
import { Op } from "sequelize";

function nextSendableTime(campaign) {
  const tz = campaign.timezone || "UTC";
  const days = campaign.sendingDays || ["monday", "tuesday", "wednesday", "thursday", "friday"];
  const startTime = campaign.startTime || "09:00";
  const endTime = campaign.endTime || "18:00";

  const [startH, startM] = startTime.split(":").map(Number);
  const [endH, endM] = endTime.split(":").map(Number);
  const startMins = startH * 60 + startM;
  const endMins = endH * 60 + endM;

  let cursor = DateTime.now().setZone(tz);

  for (let i = 0; i < 14 * 24 * 60; i += 1) {
    const dayName = cursor.toFormat("EEEE").toLowerCase();
    const curMinutes = cursor.hour * 60 + cursor.minute;

    let isInsideWindow = false;
    if (startMins <= endMins) {
      isInsideWindow = curMinutes >= startMins && curMinutes <= endMins;
    } else {
      isInsideWindow = curMinutes >= startMins || curMinutes <= endMins;
    }

    if (days.includes(dayName) && isInsideWindow) {
      if (i === 0) return null; // Valid right now, process immediately
      return cursor.toJSDate(); // Valid in future, schedule for then
    }

    cursor = cursor.plus({ minutes: 1 });
  }

  // Failsafe if no days configured properly
  return DateTime.now().setZone(tz).plus({ days: 1 }).set({ hour: startH, minute: startM }).toJSDate();
}

const log = (level, message, meta = {}) =>
  console.log(JSON.stringify({ ts: DateTime.now().toISO(), service: "campaign-orchestrator", level, message, ...meta }));



async function startWorker() {
  let channel;
  try {
    channel = await getChannel();
    await channel.assertQueue(QUEUES.CAMPAIGN_SEND, { durable: true });
    await channel.assertQueue(QUEUES.EMAIL_ROUTE, { durable: true });
    channel.prefetch(10);

    channel.consume(QUEUES.CAMPAIGN_SEND, async (msg) => {
      if (!msg) return;
      const { campaignId, recipientId } = JSON.parse(msg.content.toString());

      try {
        const campaign = await Campaign.findByPk(campaignId);
        const recipient = await CampaignRecipient.findByPk(recipientId);

        if (!campaign || campaign.status !== "running" || !recipient || recipient.status !== "pending") {
          return channel.ack(msg);
        }

        const nextValidTime = nextSendableTime(campaign);
        if (nextValidTime !== null) {
          await recipient.update({ nextRunAt: nextValidTime });
          return channel.ack(msg);
        }

        // 1. Identify current Step
        const stepOrder = Number.isInteger(recipient.currentStep) ? recipient.currentStep : 0;

        // 2. Ensure Step 0 exists (Self-Healing)
        if (stepOrder === 0) {
          await CampaignStep.upsert({
            campaignId: campaign.id,
            stepOrder: 0,
            subject: campaign.subject || "No Subject",
            htmlBody: campaign.htmlBody || "<p></p>",
            textBody: campaign.textBody || "",
            delayMinutes: 0,
            condition: "always",
          });
        }

        const stepConfig = await CampaignStep.findOne({
          where: { campaignId, stepOrder }
        });

        if (!stepConfig) {
          await recipient.update({ status: "completed", nextRunAt: null });
          await tryCompleteCampaign(campaignId);
          return channel.ack(msg);
        }

        // 3. Global Registry Checks (Unsubscribes & Verification)
        const globalRegistry = await GlobalEmailRegistry.findOne({
          where: {
            normalizedEmail: recipient.email.toLowerCase(),
            [Op.or]: [
              { userId: campaign.userId },
              { userId: null }
            ]
          }
        });

        if (globalRegistry?.unsubscribed) {
          log("INFO", "🚫 Recipient unsubscribed. Stopping.", { recipientEmail: recipient.email });
          await recipient.update({ status: "unsubscribed", nextRunAt: null });
          await tryCompleteCampaign(campaignId);
          return channel.ack(msg);
        }

        const vs = globalRegistry?.verificationStatus;
        if (!vs || vs === "invalid" || vs === "unknown" || vs === "verifying" || (vs === "risky" && campaign.blockRiskyEmails)) {
          log("INFO", `🚫 Recipient email ${vs || 'unverified'}. Stopping.`, { recipientEmail: recipient.email });
          await recipient.update({ status: "stopped", nextRunAt: null });
          await tryCompleteCampaign(campaignId);
          return channel.ack(msg);
        }

        // 4. Step Condition Logic (no_reply, on_open, etc.)
        if (stepOrder > 0 && stepConfig.condition !== "always") {
          const previousSend = await CampaignSend.findOne({
            where: { campaignId, recipientId, step: stepOrder - 1 },
            order: [["createdAt", "DESC"]]
          });

          let conditionMet = false;
          if (previousSend) {
            if (stepConfig.condition === "no_reply" && !previousSend.repliedAt) conditionMet = true;
            if (stepConfig.condition === "on_open" && previousSend.openedAt) conditionMet = true;
            if (stepConfig.condition === "on_click" && previousSend.clickedAt) conditionMet = true;
          }

          if (!conditionMet) {
            log("DEBUG", "⏭️ Step condition not met. Skipping to next step.", { stepOrder, condition: stepConfig.condition });
            await recipient.update({ currentStep: stepOrder + 1, nextRunAt: DateTime.now().toJSDate() });
            channel.sendToQueue(QUEUES.CAMPAIGN_SEND, Buffer.from(JSON.stringify({ campaignId, recipientId })));
            return channel.ack(msg);
          }
        }

        // Shuffled sender selection
        let senderIdToUse = null;
        let sender = null;
        const candidateIds = campaign.senderIds && campaign.senderIds.length > 0
          ? [...campaign.senderIds].sort(() => Math.random() - 0.5) 
          : [campaign.senderId].filter(id => id != null);

        for (const sId of candidateIds) {
          const candidateSender = await getSenderWithType(sId, campaign.senderType);
          if (!candidateSender || !candidateSender.isVerified || !candidateSender.isActive) continue;
          const health = await SenderHealth.findOne({ where: { mailboxId: sId } });
          if (health?.blacklisted) continue;
          senderIdToUse = sId;
          sender = candidateSender;
          break;
        }

        if (!sender) {
          log("WARN", "🚨 No healthy senders. Auto-pausing campaign.", { campaignId });
          await campaign.update({ status: "paused", pauseReason: "No healthy mailboxes available." });
          return channel.ack(msg);
        }

        let senderSignatureHtml = sender.signature || "";
        
        // Append designation to the signature if it exists
        if (sender.designation) {
          const designationHtml = `<div style="color: #64748b; font-size: 13px; margin-top: 2px;">${sender.designation}</div>`;
          senderSignatureHtml = senderSignatureHtml ? `${senderSignatureHtml}\n${designationHtml}` : designationHtml;
        }

        const variables = {
          email: recipient.email,
          name: recipient.name || "",
          first_name: (recipient.name || "").split(" ")[0] || "",
          last_name: (recipient.name || "").split(" ").slice(1).join(" ") || "",
          sender_name: sender.displayName || sender.name || "",
          sender_designation: sender.designation || "",
          __signature__: senderSignatureHtml,
          ...recipient.metadata
        };

        // If the template does NOT contain a %signature% token, auto-append the signature at the end
        const htmlBody = stepConfig.htmlBody || "";
        const bodyWithSignature = senderSignatureHtml && !/%signature%/i.test(htmlBody)
          ? htmlBody + `\n${senderSignatureHtml}`
          : htmlBody;

        const emailId = crypto.randomUUID();
        const renderedSubject = renderTemplate(stepConfig.subject, variables);
        const renderedHtml = injectTracking(renderTemplate(bodyWithSignature, variables), emailId, {
          trackOpens: campaign.trackOpens,
          trackClicks: campaign.trackClicks,
          unsubscribeLink: campaign.unsubscribeLink,
        });
        const renderedText = renderTemplate(stepConfig.textBody, variables);

        const t = await sequelize.transaction();
        try {
          const [send, created] = await CampaignSend.findOrCreate({
            where: { campaignId, recipientId, step: stepOrder },
            defaults: { senderId: senderIdToUse, status: "queued" },
            transaction: t
          });

          if (!created && send.status !== "queued") {
            await t.rollback();
            return channel.ack(msg);
          }

          const email = await Email.create({
            id: emailId,
            userId: campaign.userId,
            campaignId,
            senderId: senderIdToUse,
            senderType: campaign.senderType,
            recipientEmail: recipient.email,
            recipientId: recipient.id,
            subject: renderedSubject,
            htmlBody: renderedHtml,
            textBody: renderedText,
            status: "pending",
            metadata: { step: stepOrder },
          }, { transaction: t });

          const nextStep = stepConfig.onConditionStepOrder || stepOrder + 1;
          const nextStepConfig = await CampaignStep.findOne({ where: { campaignId, stepOrder: nextStep }, transaction: t });
          
          if (nextStepConfig) {
            await recipient.update({
              status: "pending", currentStep: nextStep, lastSentAt: DateTime.now().toJSDate(),
              nextRunAt: DateTime.now().plus({ minutes: nextStepConfig.delayMinutes || 0 }).toJSDate()
            }, { transaction: t });
          } else {
            await recipient.update({ status: "completed", currentStep: nextStep, lastSentAt: DateTime.now().toJSDate(), nextRunAt: null }, { transaction: t });
            await tryCompleteCampaign(campaignId, { transaction: t });
          }

          await send.update({ emailId: email.id, status: "sent" }, { transaction: t });
          await t.commit();
          channel.sendToQueue(QUEUES.EMAIL_ROUTE, Buffer.from(JSON.stringify({ emailId: email.id })), { persistent: true });
        } catch (internalErr) {
           await t.rollback();
           throw internalErr;
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
