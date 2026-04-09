import { CrmStage, Lead, ListUploadRecord } from "../models/index.js";

/**
 * Syncs a contact's position in the CRM pipeline based on activity.
 * @param {string} userId - The owner of the lead.
 * @param {string} email - The lead's email.
 * @param {string} event - The interaction event (e.g., 'sent', 'replied').
 * @param {string} category - The specific intent category (e.g., 'interested', 'out_of_office').
 */
export const syncLead = async (userId, email, event, category = 'replied') => {
  try {
    const normalizedEmail = email.toLowerCase().trim();

    // 1. Find the contact
    const contact = await ListUploadRecord.findOne({
      where: { normalizedEmail, userId },
    });

    if (!contact) return; // No global contact, skip CRM sync

    // 2. Find or Create Lead
    let lead = await Lead.findOne({
      where: { contactId: contact.id, userId },
    });

    // 3. Find target stage based on mapping
    // If it's a 'sent' event, we look for a stage named 'Email Sent' as a fallback
    // If it's a 'replied' event, we look for a stage mapped to the specific category
    let stage = null;

    if (event === "sent") {
      // Enter lead into the very first pipeline stage (position 0 = "New Leads")
      stage = await CrmStage.findOne({
        where: { userId },
        order: [["position", "ASC"]],
      });
    } else if (event === "replied") {
      // Look for a stage specifically mapped to THIS reply category (intent)
      stage = await CrmStage.findOne({
        where: { userId, replyCategory: category },
      });

      // Fallback: If no stage is mapped to the specific intent, look for a general 'replied' mapping
      if (!stage && category !== "replied") {
        stage = await CrmStage.findOne({
          where: { userId, replyCategory: "replied" },
        });
      }
    }

    if (!stage) return; // No stage found to move the lead to

    if (!lead) {
      // Create new lead in the new stage
      await Lead.create({
        userId,
        contactId: contact.id,
        stageId: stage.id,
        lastActivityAt: new Date(),
        metadata: { lastIntent: category }
      });
    } else {
      // Move the lead
      // We check position to ensure leads only move "forward" or into defined intent stages
      const currentStage = await CrmStage.findByPk(lead.stageId);
      
      const updates = {
        lastActivityAt: new Date(),
        metadata: { ...lead.metadata, lastIntent: category }
      };

      // Terminal Intents (Negative/Interested/Replied categories) often override position
      // We allow leads to move "backwards" or into specific intent stages if explicitly mapped
      const isTerminalIntent = ["interested", "not_interested", "out_of_office", "wrong_person"].includes(category);

      if (!currentStage || currentStage.position < stage.position || isTerminalIntent) {
        updates.stageId = stage.id;
      }
      
      await lead.update(updates);
    }
  } catch (error) {
    console.error("Error in CrmSyncService:", error);
  }
};
