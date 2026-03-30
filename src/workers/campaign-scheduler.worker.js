import "../models/index.js";
import { initGlobalErrorHandlers } from "../utils/error-handler.js";
initGlobalErrorHandlers();
import Campaign from "../models/campaign.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import GlobalEmailRegistry from "../models/global-email-registry.model.js";
import { getRabbitChannel as getChannel } from "../queues/rabbit.js";
import { QUEUES } from "../queues/queues.js";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import pLimit from "p-limit";
dayjs.extend(utc);
dayjs.extend(timezone);
import { Op } from "sequelize";
import { getSenderWithType } from "../models/index.js";
import { DeliveryGuard } from "../utils/delivery-guard.js";

const log = (level, message, meta = {}) =>
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
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
      // 1. Status Activation Check
      if (campaign.status === "scheduled" && (!campaign.scheduledAt || dayjs.utc().isAfter(campaign.scheduledAt))) {
        await campaign.update({
          status: "running",
          scheduledAt: campaign.scheduledAt || new Date(),
          startedAt: new Date()
        });
        log("INFO", "▶️ Campaign started", { campaignId: campaign.id });
      }

      if (campaign.status !== "running") return;

      // 2. Sending Window Check
      const tz = campaign.timezone || "UTC";
      const now = dayjs.utc().tz(tz);
      const dayName = now.format("dddd").toLowerCase();
      const currentTime = now.format("HH:mm");

      const allowedDays = campaign.sendingDays || ["monday", "tuesday", "wednesday", "thursday", "friday"];
      const startTime = campaign.startTime || "09:00";
      const endTime = campaign.endTime || "18:00";

      if (!allowedDays.includes(dayName) || currentTime < startTime || currentTime > endTime) {
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

      const startOfDay = dayjs.utc().tz(tz).startOf('day').utc().toDate();
      const sentTodayCount = await CampaignRecipient.count({
        where: {
          campaignId: campaign.id,
          lastSentAt: { [Op.gte]: startOfDay },
        },
      });

      const maxPerDay = campaign.maxLeadsPerDay || 100;
      const remainingToday = Math.max(0, maxPerDay - sentTodayCount);
      if (remainingToday === 0) return;

      // 4. Batch Selection
      const batchSize = Math.min(campaign.throttlePerMinute || 1, health.remaining, remainingToday);

      const recipients = await CampaignRecipient.findAll({
        where: {
          campaignId: campaign.id,
          status: "pending",
          nextRunAt: { [Op.or]: [{ [Op.lte]: new Date() }, { [Op.is]: null }] },
        },
        include: [{ model: GlobalEmailRegistry, required: false, attributes: ["unsubscribed"] }],
        order: [["nextRunAt", "ASC"]],
        limit: batchSize,
      });

      if (recipients.length === 0) return;

      log("DEBUG", "📤 Batching recipients", {
        campaignId: campaign.id,
        count: recipients.length,
      });

      // 5. Enqueue tasks
      for (const r of recipients) {
        if (r.GlobalEmailRegistry?.unsubscribed) {
          await r.update({ status: "unsubscribed", nextRunAt: null });
          continue;
        }

        channel.sendToQueue(QUEUES.CAMPAIGN_SEND, Buffer.from(JSON.stringify({
          campaignId: campaign.id,
          recipientId: r.id
        })), { persistent: true });

        const intervalMins = campaign.sendingInterval || 20;
        await r.update({ nextRunAt: dayjs.utc().add(intervalMins, "minute").toDate() });
      }
    } catch (campaignErr) {
      log("ERROR", "❌ Error processing campaign", {
        campaignId: campaign.id,
        error: campaignErr.message
      });
    }
  };

  log("INFO", "🚀 Campaign Scheduler started (Parallel Mode)");

  setInterval(async () => {
    try {
      log("DEBUG", "⏰ Scheduler tick");

      const campaigns = await Campaign.findAll({
        where: { status: { [Op.in]: ["scheduled", "running"] } },
      });

      if (campaigns.length === 0) return;

      // Execute in parallel with limit
      await Promise.all(campaigns.map(c => limit(() => processCampaign(c))));

    } catch (err) {
      log("ERROR", "❌ Scheduler tick error", { error: err.message });
    }
  }, 60_000);
})();
