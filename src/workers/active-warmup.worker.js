import { DateTime } from "luxon";
import { SmtpSender, GmailSender, OutlookSender, User } from "../models/index.js";
import { activeWarmupService } from "../services/active-warmup.service.js";

export const log = (level, message, meta = {}) =>
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
 * It handles both:
 * 1. Dawn Transition: Resetting counts and incrementing limits at local midnight.
 * 2. Warmup Sends: Triggering emails based on daily limits and pacing.
 */
export async function runWarmupTick(options = {}) {
  try {
    log("INFO", "⏰ Warmup tick started", { forceAll: !!options.forceAll });

    // 1. Fetch enabled senders with User timezone info
    const queryOptions = {
      where: { warmupEnabled: true, warmupStatus: "active", isVerified: true },
      include: [{ model: User, attributes: ["timezone"] }]
    };

    const [smtps, gmails, outlooks] = await Promise.all([
      SmtpSender.findAll(queryOptions),
      GmailSender.findAll(queryOptions),
      OutlookSender.findAll(queryOptions),
    ]);

    const allSenders = [
      ...smtps.map(s => ({ ...s.get(), type: 'smtp', model: s, user: s.User })),
      ...gmails.map(s => ({ ...s.get(), type: 'gmail', model: s, user: s.User })),
      ...outlooks.map(s => ({ ...s.get(), type: 'outlook', model: s, user: s.User })),
    ];

    if (allSenders.length === 0) {
      log("INFO", "📭 No eligible senders found for warmup");
      return;
    }

    for (const sender of allSenders) {
      const timezone = sender.user?.timezone || "UTC";
      const today = DateTime.now().setZone(timezone).toFormat("yyyy-MM-dd");

      // A. DAWN TRANSITION: Has the local day changed since the last reset?
      if (sender.warmupLastResetDate !== today) {
        log("INFO", `🌅 Dawn transition for ${sender.email} (${timezone})`);
        
        const nextDaysActive = (sender.warmupDaysActive || 0) + 1;
        const nextLimit = Math.min(
          sender.warmupMaxLimit || 50,
          (sender.warmupInitialLimit || 2) + (nextDaysActive * (sender.warmupIncrementBy || 2)),
        );

        await sender.model.update({
          warmupCurrentSent: 0,
          warmupDaysActive: nextDaysActive,
          warmupDailyLimit: nextLimit,
          warmupLastResetDate: today
        });
        
        // Update local object to reflect reset
        sender.warmupCurrentSent = 0;
        sender.warmupDailyLimit = nextLimit;
      }

      // B. QUIET HOURS: Only send during 8 AM - 8 PM in user's timezone
      const currentHour = DateTime.now().setZone(timezone).hour;
      if (currentHour < 8 || currentHour >= 20) {
        log("DEBUG", `🛌 Quiet hours for ${sender.email} (${timezone}, hour: ${currentHour})`);
        continue;
      }

      // C. WARMUP SEND: Trigger based on daily limit and probability
      if (sender.warmupCurrentSent >= sender.warmupDailyLimit) {
        log("DEBUG", `⏭️ Limit reached for ${sender.email} (${sender.warmupCurrentSent}/${sender.warmupDailyLimit})`);
        continue;
      }

      // Human Randomness: 20% chance to send an email in this specific 10m window
      // Bypass if 'forceAll' is provided (for testing)
      if (options.forceAll || Math.random() < 0.2) {
        await activeWarmupService.triggerWarmupSend(sender);

        // Update the instance
        await sender.model.increment("warmupCurrentSent");
        log("INFO", "🚀 Triggered Warmup Send", { email: sender.email, type: sender.type });
      }
    }

    log("INFO", "✅ Warmup tick completed");
  } catch (err) {
    log("ERROR", "❌ Warmup tick failed", { error: err.message, stack: err.stack });
  }
}

// Start the ticker every 10 minutes
const TICK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

// Detect if this file is being run directly as a script
import { fileURLToPath } from "url";
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === (process.argv[1].startsWith('file:') ? fileURLToPath(process.argv[1]) : process.argv[1]);

if (isMain) {
  log("INFO", "🚀 Warmup Orchestrator Worker started (Timezone-Aware Mode)");

  // Initial run
  runWarmupTick();

  // Periodic runs
  setInterval(runWarmupTick, TICK_INTERVAL_MS);
}

