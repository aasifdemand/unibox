import "../models/index.js";
import { initGlobalErrorHandlers } from "../utils/error-handler.js";
initGlobalErrorHandlers();
import Campaign from "../models/campaign.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import CampaignSend from "../models/campaign-send.model.js";
import GlobalEmailRegistry from "../models/global-email-registry.model.js";
import { getRabbitChannel as getChannel } from "../queues/rabbit.js";
import { QUEUES } from "../queues/queues.js";
import { DateTime } from "luxon";
import pLimit from "p-limit";
import { Op } from "sequelize";
import sequelize from "../config/db.js";
import { getSenderWithType } from "../models/index.js";
import { DeliveryGuard } from "../utils/delivery-guard.js";

const log = (level, message, meta = {}) =>
  console.log(
    JSON.stringify({
      ts: DateTime.now().toISO(),
      service: "campaign-scheduler",
      level,
      message,
      ...meta,
    }),
  );


const limit = pLimit(20); // Process 20 campaigns in parallel

(async () => {
  const channel = await getChannel();
  await channel.assertQueue(QUEUES.CAMPAIGN_SEND, { durable: true });

  const processCampaign = async (campaign) => {
    try {
      const tz = campaign.timezone || "UTC";
      const now = DateTime.now().setZone(tz);

      // 1. Status Activation Check
      if (campaign.status === "scheduled") {
        const scheduledAt = DateTime.fromJSDate(campaign.scheduledAt).setZone(tz);
        if (now >= scheduledAt) {
          await campaign.update({
            status: "running",
            startedAt: DateTime.now().toJSDate()
          });
          log("INFO", "▶️ Campaign started", { campaignId: campaign.id });
        }
      }

      if (campaign.status !== "running") return;

      // 2. Sending Window Check
      const nowTz = now;
      const dayName = nowTz.toFormat("EEEE").toLowerCase();
      const currentTime = nowTz.toFormat("HH:mm");

      const allowedDays = campaign.sendingDays || ["monday", "tuesday", "wednesday", "thursday", "friday"];
      const startTime = campaign.startTime || "09:00";
      const endTime = campaign.endTime || "18:00";

      let isInsideWindow = false;
      if (startTime <= endTime) {
        // Standard window (e.g., 09:00 to 18:00)
        isInsideWindow = currentTime >= startTime && currentTime <= endTime;
      } else {
        // Cross-midnight window (e.g., 22:00 to 04:00)
        isInsideWindow = currentTime >= startTime || currentTime <= endTime;
      }

      if (!allowedDays.includes(dayName) || !isInsideWindow) {
        return; // Outside window
      }

      // 3. Warm-up & Daily Limits Check
      const sender = await getSenderWithType(campaign.senderId, campaign.senderType);
      if (!sender) {
        log("ERROR", "❌ Sender not found for campaign", { campaignId: campaign.id });
        return;
      }

      const health = await DeliveryGuard.canSendToday(sender);
      if (!health.allowed) return;

      const startOfDay = now.startOf('day').toJSDate();
      
      // 🚀 FIX: Only count NEW leads (Step 0) for the maxLeadsPerDay limit.
      // Follow-ups should be allowed to proceed as long as the sender has daily capacity.
      const newLeadsSentToday = await CampaignSend.count({
        where: {
          campaignId: campaign.id,
          step: 0,
          sentAt: { [Op.gte]: startOfDay }
        }
      });

      const maxNewLeadsPerDay = campaign.maxLeadsPerDay || 100;
      let remainingNewLeadsQuota = Math.max(0, maxNewLeadsPerDay - newLeadsSentToday);

      // 4. Batch Selection
      // We don't limit the initial fetch by remainingNewLeadsQuota because we want to pick up follow-ups too!
      const batchSize = Math.min(campaign.throttlePerMinute || 1, health.remaining);
      if (batchSize <= 0) return;

      const recipients = await CampaignRecipient.findAll({
        where: {
          campaignId: campaign.id,
          status: "pending",
          nextRunAt: { [Op.or]: [{ [Op.lte]: now.toJSDate() }, { [Op.is]: null }] },
        },
        include: [{ model: GlobalEmailRegistry, required: false, attributes: ["unsubscribed"] }],
        // 🚀 PRIORITIZE FOLLOW-UPS: Order by currentStep DESC so people further in the funnel go first
        order: [
          ["currentStep", "DESC"],
          ["nextRunAt", "ASC"]
        ],
        limit: Math.max(batchSize, 50), // Fetch a bit more to account for quota filtering
      });

      if (recipients.length === 0) return;

      log("DEBUG", "📤 Batching recipients", {
        campaignId: campaign.id,
        count: recipients.length,
        remainingNewLeadsQuota,
        totalSenderRemaining: health.remaining
      });

      // 5. Enqueue tasks
      let enqueuedCount = 0;
      for (const r of recipients) {
        if (enqueuedCount >= batchSize) break;

        // Apply maxLeadsPerDay ONLY to new leads (Step 0)
        if (r.currentStep === 0) {
          if (remainingNewLeadsQuota <= 0) continue;
          remainingNewLeadsQuota--;
        }

        if (r.GlobalEmailRegistry?.unsubscribed) {
          await r.update({ status: "unsubscribed", nextRunAt: null });
          continue;
        }

        channel.sendToQueue(QUEUES.CAMPAIGN_SEND, Buffer.from(JSON.stringify({
          campaignId: campaign.id,
          recipientId: r.id
        })), { persistent: true });

        // 5b. Short safety lease (2 mins) while orchestrator processes. 
        // Using UTC for consistency.
        await r.update({ nextRunAt: now.plus({ minutes: 2 }).toJSDate() });
        enqueuedCount++;
      }
    } catch (campaignErr) {
      log("ERROR", "❌ Error processing campaign", {
        campaignId: campaign.id,
        error: campaignErr.message
      });
    }
  };

  log("INFO", "🚀 Campaign Scheduler started (Distributed Leasing Mode)");

  // Tick every 30 seconds for better responsiveness, 
  // but it's safe because of the 60s lease window.
  setInterval(async () => {
    try {
      log("DEBUG", "⏰ Scheduler tick (Leasing Batch)");

      // 1. ATOMIC LEASING: Fetch and Lock a batch of 50 campaigns
      const leasedCampaigns = await sequelize.transaction(async (t) => {
        const batch = await Campaign.findAll({
          where: {
            status: { [Op.in]: ["scheduled", "running"] },
            [Op.or]: [
              { lastScheduledCheckAt: { [Op.lt]: DateTime.now().minus({ minutes: 1 }).toJSDate() } },
              { lastScheduledCheckAt: null }
            ]
          },
          limit: 200, // Handle up to 200 campaigns per tick for high-scale environments
          lock: true,
          skipLocked: true, // Standard for high-scale distributed workers
          transaction: t
        });

        if (batch.length > 0) {
          const ids = batch.map(c => c.id);
          await Campaign.update(
            { lastScheduledCheckAt: DateTime.now().toJSDate() },
            { 
              where: { id: { [Op.in]: ids } },
              transaction: t 
            }
          );
          log("DEBUG", `🔓 Leased ${batch.length} campaigns for processing`);
        }
        return batch;
      });

      if (leasedCampaigns.length === 0) return;

      // 2. Process leased batch in parallel
      await Promise.all(leasedCampaigns.map(c => limit(() => processCampaign(c))));

    } catch (err) {
      log("ERROR", "❌ Scheduler tick error", { error: err.message, stack: err.stack });
    }
  }, 30_000); 
})();
