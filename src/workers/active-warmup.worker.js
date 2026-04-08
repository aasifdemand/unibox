import { DateTime } from "luxon";
import { SmtpSender, GmailSender, OutlookSender, User } from "../models/index.js";
import { getRabbitChannel as getChannel } from "../queues/rabbit.js";
import { QUEUES } from "../queues/queues.js";
import { Op } from "sequelize";

export const log = (level, message, meta = {}) =>
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "active-warmup-producer",
      level,
      message,
      ...meta,
    }),
  );

/**
 * The Warmup Producer identifies mailboxes eligible for sending
 * and pushes tasks to the WARMUP_SEND queue.
 */
export async function runWarmupProducerTick(options = {}) {
  try {
    log("INFO", "⏰ Warmup producer tick started", { forceAll: !!options.forceAll });

    const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000);
    const channel = await getChannel();

    // 1. Fetch enabled senders that haven't been checked recently
    const queryOptions = {
      where: { 
        warmupEnabled: true, 
        warmupStatus: "active", 
        isVerified: true,
        [Op.or]: [
            { lastWarmupCheckAt: { [Op.lt]: tenMinsAgo } },
            { lastWarmupCheckAt: null }
        ]
      },
      include: [{ model: User, attributes: ["timezone"] }],
      limit: 100
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
      log("INFO", "📭 No eligible senders due for warmup send check");
      return;
    }

    for (const sender of allSenders) {
      const timezone = sender.user?.timezone || "UTC";
      const today = DateTime.now().setZone(timezone).toFormat("yyyy-MM-dd");

      // A. DAWN TRANSITION: Reset counts at midnight
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
          warmupLastResetDate: today,
          lastWarmupCheckAt: new Date()
        });
        
        sender.warmupCurrentSent = 0;
        sender.warmupDailyLimit = nextLimit;
      }

      // B. QUIET HOURS: Skip if not 8AM-8PM
      const currentHour = DateTime.now().setZone(timezone).hour;
      if (currentHour < 8 || currentHour >= 20) {
        continue;
      }

      // C. ENQUEUE: If limit not reached and probability hits
      if (sender.warmupCurrentSent >= sender.warmupDailyLimit) {
        // Still update the timestamp so we don't keep picking up "Finished" senders in every tick
        await sender.model.update({ lastWarmupCheckAt: new Date() }, { where: { id: sender.id } });
        continue;
      }

      // Human Randomness: 20% chance per check
      if (options.forceAll || Math.random() < 0.2) {
        channel.sendToQueue(QUEUES.WARMUP_SEND, Buffer.from(JSON.stringify({
          senderId: sender.id,
          senderType: sender.type,
          email: sender.email
        })), { persistent: true });
        
        await sender.model.update({ lastWarmupCheckAt: new Date() }, { where: { id: sender.id } });
        log("INFO", "📤 Enqueued Warmup Send Task", { email: sender.email });
      }
    }

    log("INFO", "✅ Warmup producer tick completed");
  } catch (err) {
    log("ERROR", "❌ Warmup producer tick failed", { error: err.message });
  }
}

const TICK_INTERVAL_MS = 10 * 60 * 1000;

import { fileURLToPath } from "url";
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === (process.argv[1].startsWith('file:') ? fileURLToPath(process.argv[1]) : process.argv[1]);

if (isMain) {
  log("INFO", "🚀 Warmup Producer Worker started");
  runWarmupProducerTick();
  setInterval(runWarmupProducerTick, TICK_INTERVAL_MS);
}

