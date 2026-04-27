import { Op } from "sequelize";
import { DateTime } from "luxon";
import Campaign from "../models/campaign.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import CampaignStep from "../models/campaign-step.model.js";
import CampaignSend from "../models/campaign-send.model.js";
import { emitToUser } from "./event-broadcaster.js";

export async function checkAllCampaignsCompletion() {
  console.log(`[${DateTime.now().toISO()}]  Checking for campaigns that can be completed...`);
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
  
  // 1. Check for queued sends in the pipeline
  const queuedSends = await CampaignSend.count({
    where: { campaignId, status: "queued" },
    transaction
  });

  if (queuedSends > 0) return false;

  // 2. Count active recipients
  const activeCount = await CampaignRecipient.count({
    where: { campaignId, status: { [Op.in]: ["pending", "sent"] } },
    transaction
  });

  if (activeCount > 0) {
    // 3. SELF-HEALING: If recipients are "pending" but have finished all steps, mark them completed.
    // This handles edge cases where the orchestrator might have skipped a final update.
    const totalSteps = await CampaignStep.count({ where: { campaignId }, transaction });
    
    // Step 0 is the initial outreach, so if totalSteps is 1, they are done after Step 0.
    const stuckCount = await CampaignRecipient.count({
      where: {
        campaignId,
        status: "pending",
        currentStep: { [Op.gte]: totalSteps }
      },
      transaction
    });

    if (stuckCount > 0) {
      console.log(`[Campaign ${campaignId}] 🛠️ Auto-finalizing ${stuckCount} recipients who finished all steps.`);
      await CampaignRecipient.update(
        { status: "completed", nextRunAt: null },
        { 
          where: { 
            campaignId, 
            status: "pending", 
            currentStep: { [Op.gte]: totalSteps } 
          }, 
          transaction 
        }
      );

      // Re-check active count after self-healing
      if (activeCount > stuckCount) return false;
    } else {
      return false;
    }
  }

  // 4. Final Campaign Completion
  const [updated] = await Campaign.update(
    { status: "completed", completedAt: DateTime.now().toJSDate() },
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
