import "../models/index.js";
import { initGlobalErrorHandlers } from "../utils/error-handler.js";
initGlobalErrorHandlers();
import { SmtpSender, GmailSender, OutlookSender } from "../models/index.js";
import { activeWarmupService } from "../services/active-warmup.service.js";


const log = (level, message, meta = {}) =>
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "active-warmup-worker",
      level,
      message,
      ...meta,
    }),
  );

/**
 * The Warmup Worker runs periodically (e.g. every 10-15 minutes).
 * It selects a few mailboxes that have warmup enabled and triggers a send.
 */
async function runWarmupTick() {
  try {
    log("INFO", "⏰ Warmup tick started");

    // 1. Fetch enabled senders across all types
    const [smtps, gmails, outlooks] = await Promise.all([
      SmtpSender.findAll({ where: { warmupEnabled: true, warmupStatus: "active", isVerified: true } }),
      GmailSender.findAll({ where: { warmupEnabled: true, warmupStatus: "active", isVerified: true } }),
      OutlookSender.findAll({ where: { warmupEnabled: true, warmupStatus: "active", isVerified: true } }),
    ]);

    const allSenders = [
      ...smtps.map(s => ({ ...s.get(), type: 'smtp', model: s })),
      ...gmails.map(s => ({ ...s.get(), type: 'gmail', model: s })),
      ...outlooks.map(s => ({ ...s.get(), type: 'outlook', model: s })),
    ];

    // 2. Filter by daily limit and human-like hour pacing
    for (const sender of allSenders) {
      if (sender.warmupCurrentSent >= sender.warmupDailyLimit) continue;

      // Human Randomness: 20% chance to send an email in this specific 10m window
      if (Math.random() < 0.2) {
        await activeWarmupService.triggerWarmupSend(sender);

        // Update the instance
        await sender.model.increment("warmupCurrentSent");
        log("DEBUG", "🚀 Triggered Warmup Send", { email: sender.email, type: sender.type });
      }
    }

    log("INFO", "✅ Warmup tick completed");
  } catch (err) {
    log("ERROR", "❌ Warmup tick failed", { error: err.message });
  }
}

// Start the ticker every 10 minutes
const TICK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
log("INFO", "🚀 Warmup Orchestrator Worker started");

// Initial run
runWarmupTick();

// Periodic runs
setInterval(runWarmupTick, TICK_INTERVAL_MS);

/**
 * Daily Reset: At midnight UTC, reset warmupCurrentSent to 0
 */
setInterval(async () => {
  const now = new Date();
  if (now.getUTCHours() === 0 && now.getUTCMinutes() < 10) {
    log("INFO", "🔄 Resetting daily warmup counts");
    await Promise.all([
      SmtpSender.update({ warmupCurrentSent: 0 }, { where: {} }),
      GmailSender.update({ warmupCurrentSent: 0 }, { where: {} }),
      OutlookSender.update({ warmupCurrentSent: 0 }, { where: {} }),
    ]);
  }
}, 600_000); // Check every 10 mins if it's midnight
