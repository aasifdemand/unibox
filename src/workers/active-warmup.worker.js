import { DateTime } from "luxon";
import { SmtpSender, GmailSender, OutlookSender } from "../models/index.js";
import { getRabbitChannel as getChannel } from "../queues/rabbit.js";
import { QUEUES } from "../queues/queues.js";


const TICK_INTERVAL_MS = 10 * 60 * 1000;
const BATCH_SIZE = 500;

export const log = (level, message, meta = {}) => {
  console.log(
    JSON.stringify({
      ts: DateTime.now().toISO(),
      service: "active-warmup-producer",
      level,
      message,
      ...meta,
    })
  );
};

export async function runWarmupProducerTick(options = {}) {
  try {
    log("INFO", "⏰ Warmup producer tick started", { forceAll: !!options.forceAll });
    const channel = await getChannel();

    const models = [
      { name: "outlook", model: OutlookSender },
      { name: "gmail", model: GmailSender },
      { name: "smtp", model: SmtpSender },
    ];

    for (const { name: senderType, model } of models) {
      let offset = 0;
      while (true) {
        const mailboxes = await model.findAll({
          where: {
            warmupEnabled: true,
            warmupStatus: "active",
            isVerified: true,
            ...(senderType === "smtp" ? { isActive: true } : {}),
          },
          limit: BATCH_SIZE,
          offset: offset,
          order: [["id", "ASC"]],
        });

        if (mailboxes.length === 0) break;

        for (const sender of mailboxes) {
          // A. RESET: If it's a new day, reset the current sent count
          const today = DateTime.now().toFormat("yyyy-MM-dd");
          const lastReset = sender.warmupLastResetDate;

          if (lastReset !== today) {
            const nextLimit = Math.min(
              (sender.warmupDailyLimit || 1) + (sender.warmupIncrement || 1),
              sender.warmupMaxLimit || 50
            );

            await model.update(
              {
                warmupCurrentSent: 0,
                warmupLastResetDate: today,
                warmupDailyLimit: nextLimit,
                lastWarmupCheckAt: DateTime.now().toJSDate(),
              },
              { where: { id: sender.id } }
            );

            sender.warmupCurrentSent = 0;
            sender.warmupDailyLimit = nextLimit;
          }

          // B. ENQUEUE: If limit not reached and probability hits
          if (sender.warmupCurrentSent >= (sender.warmupDailyLimit || 5)) {
            await model.update(
              { lastWarmupCheckAt: DateTime.now().toJSDate() },
              { where: { id: sender.id } }
            );
            continue;
          }

          const isFirstSendOfDay = sender.warmupCurrentSent === 0;
          if (options.forceAll || isFirstSendOfDay || Math.random() < 0.5) {
            // Assign a random delay within the TICK_INTERVAL_MS window (minus some buffer)
            const delayMs = Math.floor(Math.random() * (TICK_INTERVAL_MS - 30000));

            channel.sendToQueue(
              QUEUES.WARMUP_SEND,
              Buffer.from(
                JSON.stringify({
                  senderId: sender.id,
                  senderType,
                  email: sender.email,
                  delayMs, // Processor will use this to stagger
                })
              ),
              { persistent: true }
            );

            await model.update(
              { lastWarmupCheckAt: DateTime.now().toJSDate() },
              { where: { id: sender.id } }
            );
            log("INFO", "📤 Enqueued Staggered Warmup Task", {
              email: sender.email,
              delaySec: Math.round(delayMs / 1000),
            });
          }
        }

        offset += BATCH_SIZE;
        // Small yield to event loop if needed between heavy batches
        if (offset % (BATCH_SIZE * 2) === 0) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    }

    log("INFO", "✅ Warmup producer tick completed");
  } catch (err) {
    log("ERROR", "❌ Warmup producer tick failed", { error: err.message });
  }
}



import { fileURLToPath } from "url";
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === (process.argv[1].startsWith('file:') ? fileURLToPath(process.argv[1]) : process.argv[1]);

async function boot() {
  try {
    log("INFO", "🚀 Warmup Producer Worker started");
    await runWarmupProducerTick();
    setInterval(async () => {
      try {
        await runWarmupProducerTick();
      } catch (err) {
        log("ERROR", "Interval tick failed", { error: err.message });
      }
    }, TICK_INTERVAL_MS);
  } catch (err) {
    log("ERROR", "Worker boot failed, retrying in 10s", { error: err.message });
    setTimeout(boot, 10000);
  }
}

if (isMain) {
  boot();
}

