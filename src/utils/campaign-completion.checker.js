import { Op } from "sequelize";
import Campaign from "../models/campaign.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import CampaignSend from "../models/campaign-send.model.js";
import { emitToUser } from "./event-broadcaster.js";

export async function checkAllCampaignsCompletion() {
  console.log(`[${new Date().toISOString()}]  Checking for campaigns that can be completed...`);
  const runningCampaigns = await Campaign.findAll({
    where: { status: { [Op.in]: ["running", "sending"] } },
  });

  let completedCount = 0;
  for (const campaign of runningCampaigns) {
    const completed = await tryCompleteCampaign(campaign.id);
    if (completed) completedCount++;
  }
  return completedCount;
}

export async function tryCompleteCampaign(campaignId, options = {}) {
  const transaction = options.transaction;
  const queuedSends = await CampaignSend.count({
    where: { campaignId, status: "queued" },
    transaction
  });

  if (queuedSends > 0) return false;

  const activeRecipients = await CampaignRecipient.count({
    where: { campaignId, status: { [Op.in]: ["pending", "sent"] } },
    transaction
  });

  if (activeRecipients > 0) return false;

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const recentlyCompletedCount = await CampaignRecipient.count({
    where: { campaignId, status: "completed", lastSentAt: { [Op.gte]: sevenDaysAgo } },
    transaction
  });

  if (recentlyCompletedCount > 0) return false;

  const [updated] = await Campaign.update(
    { status: "completed", completedAt: new Date() },
    { where: { id: campaignId, status: { [Op.ne]: "completed" } }, transaction }
  );

  if (updated > 0) {
    console.log(`[Campaign ${campaignId}] ✅ Campaign marked as completed`);
    const campaign = await Campaign.findByPk(campaignId, { attributes: ['userId', 'name'], transaction });
    if (campaign) {
      emitToUser(campaign.userId, "notification", {
        type: "success",
        category: "campaign",
        title: "Campaign Completed",
        message: `Your campaign "${campaign.name}" has finished sending.`,
      });
    }
  }

  return updated > 0;
}
