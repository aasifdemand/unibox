import Email from "../models/email.model.js";
import { Op } from "sequelize";
import { DateTime } from "luxon";

/**
 * DeliveryGuard helps manage sender health by enforcing:
 * 1. Warm-up limits (starting low and increasing over time)
 * 2. Hard daily caps to prevent domain burning
 * 3. Throttling checks
 */
export class DeliveryGuard {
  // Configurable limits
  static LIMITS = {
    GMAIL: { initial: 30, max: 500, dailyIncrement: 20 },
    OUTLOOK: { initial: 50, max: 1000, dailyIncrement: 30 },
    SMTP: { initial: 100, max: 5000, dailyIncrement: 50 },
  };

  static async getAllowedVolume(sender) {
    // 1. Properly detect Provider Type to prevent generic SMTP overrides
    let providerKey = "SMTP";
    const modelName = sender.constructor?.name || "";
    if (modelName === "GmailSender" || sender.type === "gmail") providerKey = "GMAIL";
    if (modelName === "OutlookSender" || sender.type === "outlook") providerKey = "OUTLOOK";

    const config = this.LIMITS[providerKey] || this.LIMITS.SMTP;

    // 2. Calculate Calendar Age tied to Timezone
    const tz = sender.timezone || sender.user?.timezone || "UTC";
    const createdMidnight = DateTime.fromJSDate(sender.createdAt).setZone(tz).startOf("day");
    const currentMidnight = DateTime.now().setZone(tz).startOf("day");
    
    const ageInDays = Math.floor(currentMidnight.diff(createdMidnight, "days").days);

    // Volume = Initial + (Age * Increment)
    const calculatedLimit = config.initial + ageInDays * config.dailyIncrement;

    // Cap at provider max
    return Math.min(calculatedLimit, config.max);
  }

  /**
   * Checks if a sender can send more emails today.
   */
  static async canSendToday(sender) {
    const allowedLimit = await this.getAllowedVolume(sender);

    // Count emails sent by this sender today (in their local timezone)
    const tz = sender.timezone || sender.user?.timezone || "UTC";
    const startOfToday = DateTime.now().setZone(tz).startOf("day").toUTC().toJSDate();

    const sentTodayCount = await Email.count({
      where: {
        senderId: sender.id,
        createdAt: {
          [Op.gte]: startOfToday,
        },
        status: ["sent", "delivered", "pending", "queued"], // Include pending to avoid bursts
      },
    });

    return {
      allowed: sentTodayCount < allowedLimit,
      currentCount: sentTodayCount,
      limit: allowedLimit,
      remaining: Math.max(0, allowedLimit - sentTodayCount),
    };
  }
}
