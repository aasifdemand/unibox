import { initGlobalErrorHandlers } from "../utils/error-handler.js";
initGlobalErrorHandlers();

import { 
  SmtpSender, 
  GmailSender, 
  OutlookSender
} from "../models/index.js";
import { Op } from "sequelize";
import { DateTime } from "luxon";
import { getRabbitChannel as getChannel } from "../queues/rabbit.js";
import { QUEUES } from "../queues/queues.js";

const log = (level, message, meta = {}) =>
  console.log(
    JSON.stringify({
      ts: DateTime.now().toISO(),
      service: "active-warmup-monitor-producer",
      level,
      message,
      ...meta,
    })
  );

/**
 * Periodically identifies mailboxes that need a warmup check
 * and pushes them to the WARMUP_RESCUE queue.
 */
async function runMonitorProducerTick() {
  try {
    log("INFO", "🔍 Warmup monitoring producer tick started");

    const channel = await getChannel();
    const fifteenMinsAgo = DateTime.now().minus({ minutes: 15 }).toJSDate();
    const BATCH_SIZE = 500;

    const models = [
      { name: "outlook", model: OutlookSender },
      { name: "gmail", model: GmailSender },
      { name: "smtp", model: SmtpSender },
    ];

    for (const { name: type, model } of models) {
      let offset = 0;
      while (true) {
        const mailboxes = await model.findAll({
          where: {
            warmupEnabled: true,
            warmupStatus: "active",
            isVerified: true,
            ...(type === "smtp" ? { isActive: true } : {}),
            [Op.or]: [
              { lastWarmupRescueAt: { [Op.lt]: fifteenMinsAgo } },
              { lastWarmupRescueAt: null },
            ],
          },
          limit: BATCH_SIZE,
          offset: offset,
          order: [["id", "ASC"]],
          attributes: ["id", "email"],
        });

        if (mailboxes.length === 0) break;

        log("INFO", `Enqueuing batch of ${mailboxes.length} ${type} mailboxes for rescue check`);

        for (const item of mailboxes) {
          // 1. Mark as "Checked" immediately 
          await model.update(
            { lastWarmupRescueAt: DateTime.now().toJSDate() },
            { where: { id: item.id } }
          );

          // 2. Push to Queue
          channel.sendToQueue(
            QUEUES.WARMUP_RESCUE,
            Buffer.from(
              JSON.stringify({
                senderId: item.id,
                senderType: type,
                email: item.email,
              })
            ),
            { persistent: true }
          );
        }

        offset += BATCH_SIZE;
      }
    }

    log("INFO", "✅ Warmup monitoring producer tick completed");
  } catch (err) {
    log("ERROR", "❌ Warmup monitoring producer failed", { error: err.message });
  }
}

const PRODUCER_INTERVAL = 5 * 60 * 1000;

async function boot() {
  try {
    log("INFO", "🚀 Warmup Monitoring Producer booted");
    await runMonitorProducerTick();
    setInterval(async () => {
        try {
            await runMonitorProducerTick();
        } catch (err) {
            log("ERROR", "Interval tick failed", { error: err.message });
        }
    }, PRODUCER_INTERVAL);
  } catch (err) {
    log("ERROR", "Worker boot failed, retrying in 10s", { error: err.message });
    setTimeout(boot, 10000);
  }
}

boot();
