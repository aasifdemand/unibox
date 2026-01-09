import "../models/index.js";
import Campaign from "../models/campaign.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import { getChannel } from "../queues/rabbitmq.js";
import { QUEUES } from "../queues/queues.js";

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const log = (level, message, meta = {}) => {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      service: "campaign-scheduler",
      level,
      message,
      ...meta,
    })
  );
};

(async () => {
  const channel = await getChannel();
  await channel.assertQueue(QUEUES.CAMPAIGN_SEND, { durable: true });

  log("INFO", "📆 Campaign Scheduler started");

  setInterval(async () => {
    log("INFO", "⏰ Scheduler tick started");

    const campaigns = await Campaign.findAll({
      where: { status: ["scheduled", "running"] },
    });

    log("INFO", "📊 Campaigns fetched", {
      count: campaigns.length,
    });

    for (const campaign of campaigns) {
      const now = dayjs().tz(campaign.timezone || "UTC");

      log("DEBUG", "🔍 Evaluating campaign", {
        campaignId: campaign.id,
        status: campaign.status,
        scheduledAt: campaign.scheduledAt,
        now: now.toISOString(),
      });

      if (campaign.scheduledAt && now.isBefore(campaign.scheduledAt)) {
        log("DEBUG", "⏳ Campaign not due yet", {
          campaignId: campaign.id,
        });
        continue;
      }

      if (campaign.status === "scheduled") {
        await campaign.update({ status: "running" });

        log("INFO", "▶️ Campaign moved to RUNNING", {
          campaignId: campaign.id,
        });
      }

      const recipients = await CampaignRecipient.findAll({
        where: {
          campaignId: campaign.id,
          status: "pending",
        },
        limit: campaign.throttlePerMinute || 10,
      });

      log("INFO", "📥 Recipients selected for send window", {
        campaignId: campaign.id,
        selected: recipients.length,
        throttle: campaign.throttlePerMinute || 10,
      });

      if (recipients.length === 0) {
        log("INFO", "🏁 No pending recipients left", {
          campaignId: campaign.id,
        });
        continue;
      }

      for (const recipient of recipients) {
        log("DEBUG", "➡️ Enqueuing orchestrator job", {
          campaignId: campaign.id,
          recipientId: recipient.id,
          step: recipient.currentStep,
        });

        channel.sendToQueue(
          QUEUES.CAMPAIGN_SEND,
          Buffer.from(
            JSON.stringify({
              campaignId: campaign.id,
              recipientId: recipient.id,
              step: recipient.currentStep,
            })
          ),
          { persistent: true }
        );
      }
    }

    log("INFO", "✅ Scheduler tick completed");
  }, 60 * 1000);
})();
