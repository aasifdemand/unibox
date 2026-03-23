import { CrmStage, Lead, ListUploadRecord } from "../models/index.js";
import { Op } from "sequelize";

/**
 * Get the full CRM pipeline for a user.
 * Seeds default stages if none exist.
 */
export const getPipeline = async (req, res) => {
  try {
    const userId = req.user.id;

    const stages = await CrmStage.findAll({
      where: { userId },
      order: [["position", "ASC"]],
    });

    // 3. Fetch leads for these stages
    const pipeline = await Promise.all(
      stages.map(async (stage) => {
        const leads = await Lead.findAll({
          where: { stageId: stage.id, userId },
          include: [
            {
              model: ListUploadRecord,
              as: "contact",
              attributes: ["id", "normalizedEmail", "name", "metadata"],
            },
          ],
          order: [["updatedAt", "DESC"]],
        });

        return {
          ...stage.toJSON(),
          leads: leads.map(l => ({
            id: l.id,
            value: l.value,
            lastActivity: l.lastActivityAt,
            contact: l.contact,
          })),
        };
      })
    );

    res.json({ success: true, data: pipeline });
  } catch (error) {
    console.error("Error fetching CRM pipeline:", error);
    res.status(500).json({ success: false, message: "Failed to fetch pipeline" });
  }
};

/**
 * Moving a lead to a specific stage.
 */
export const moveLead = async (req, res) => {
  try {
    const { leadId, stageId } = req.body;
    const userId = req.user.id;

    const lead = await Lead.findOne({ where: { id: leadId, userId } });
    if (!lead) return res.status(404).json({ success: false, message: "Lead not found" });

    const stage = await CrmStage.findOne({ where: { id: stageId, userId } });
    if (!stage) return res.status(404).json({ success: false, message: "Target stage not found" });

    await lead.update({ stageId, lastActivityAt: new Date() });

    res.json({ success: true, message: "Lead moved successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to move lead" });
  }
};

/**
 * Add a custom stage to the pipeline.
 */
export const addStage = async (req, res) => {
  try {
    const { name, color, replyCategory } = req.body;
    const userId = req.user.id;

    const lastStage = await CrmStage.findOne({
      where: { userId },
      order: [["position", "DESC"]],
    });

    const position = lastStage ? lastStage.position + 1 : 0;

    const stage = await CrmStage.create({
      userId,
      name,
      color,
      replyCategory,
      position,
      type: "custom",
    });

    res.json({ success: true, data: stage });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to add stage" });
  }
};

/**
 * Reorder stages.
 */
export const reorderStages = async (req, res) => {
  try {
    const { stageIds } = req.body; // Array of IDs in new order
    const userId = req.user.id;

    await Promise.all(
      stageIds.map((id, index) =>
        CrmStage.update({ position: index }, { where: { id, userId } })
      )
    );

    res.json({ success: true, message: "Stages reordered" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to reorder stages" });
  }
};

/**
 * Get available reply categories for mapping.
 */
export const getReplyCategories = async (req, res) => {
  const categories = [
    { id: "replied", name: "General Reply" },
    { id: "interested", name: "Interested / Positive" },
    { id: "not_interested", name: "Not Interested / Negative" },
    { id: "out_of_office", name: "Out of Office / Auto-reply" },
    { id: "wrong_person", name: "Wrong Person / Referral" },
  ];
  res.json({ success: true, data: categories });
};

/**
 * Delete a stage. Leads in it are reassigned to the first stage (position 0).
 */
export const deleteStage = async (req, res) => {
  try {
    const { stageId } = req.params;
    const userId = req.user.id;

    const stage = await CrmStage.findOne({ where: { id: stageId, userId } });
    if (!stage) return res.status(404).json({ success: false, message: "Stage not found" });

    // Find fallback stage (first by position that isn't the one being deleted)
    const fallback = await CrmStage.findOne({
      where: { userId, id: { [Op.ne]: stageId } },
      order: [["position", "ASC"]],
    });

    if (fallback) {
      await Lead.update({ stageId: fallback.id }, { where: { stageId, userId } });
    } else {
      // No other stages — delete leads too
      await Lead.destroy({ where: { stageId, userId } });
    }

    await stage.destroy();
    res.json({ success: true, message: "Stage deleted" });
  } catch (error) {
    console.error("Error deleting stage:", error);
    res.status(500).json({ success: false, message: "Failed to delete stage" });
  }
};

/**
 * Update a lead's value, notes, or metadata.
 */
export const updateLead = async (req, res) => {
  try {
    const { leadId } = req.params;
    const userId = req.user.id;
    const { value, notes, tags } = req.body;

    const lead = await Lead.findOne({ where: { id: leadId, userId } });
    if (!lead) return res.status(404).json({ success: false, message: "Lead not found" });

    const metadata = { ...lead.metadata };
    if (notes !== undefined) metadata.notes = notes;
    if (tags !== undefined) metadata.tags = tags;

    const updates = { metadata, lastActivityAt: new Date() };
    if (value !== undefined) updates.value = parseFloat(value) || 0;

    await lead.update(updates);
    res.json({ success: true, data: lead });
  } catch (error) {
    console.error("Error updating lead:", error);
    res.status(500).json({ success: false, message: "Failed to update lead" });
  }
};

