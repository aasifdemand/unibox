import Redis from "ioredis";
import { DateTime } from "luxon";
import { smtpWarmupService } from "../services/smtp-warmup.service.js";

const redis = new Redis(process.env.REDIS_URL);

/**
 * Checks if a sender (Gmail, Outlook, or SMTP) has reached its daily sending quota.
 * Quotas are tracked in Redis and compared against the sender's daily limit
 * (which may be governed by a warmup schedule).
 * 
 * @param {Object} sender - The sender model instance
 * @param {string} type - 'gmail', 'outlook', or 'smtp'
 * @returns {Promise<{isAtQuota: boolean, current: number, limit: number}>}
 */
export async function checkSenderQuota(sender, type = "smtp") {
  const today = DateTime.now().toISODate();
  const warmupKey = `warmup:${sender.id}:${today}`;
  const campaignKey = `campaign:${sender.id}:${today}`;

  // Fetch current counts from Redis
  const [warmupCount, campaignCount] = await Promise.all([
    redis.get(warmupKey),
    redis.get(campaignKey)
  ]);

  const currentTotal = parseInt(warmupCount || "0") + parseInt(campaignCount || "0");
  
  // Calculate limit: 
  // If warmup is enabled, use the ramping limit. 
  // Otherwise, fallback to the sender's hard dailyLimit.
  let limit = sender.dailyLimit || 500;
  
  if (sender.warmupEnabled || type === "smtp") {
    const warmupLimit = await smtpWarmupService.getSenderDailyLimit(sender);
    limit = Math.min(limit, warmupLimit);
  }

  return {
    isAtQuota: currentTotal >= limit,
    current: currentTotal,
    limit: limit
  };
}
