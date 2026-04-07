import { initGlobalErrorHandlers } from "../utils/error-handler.js";
initGlobalErrorHandlers();

import { 
  SmtpSender, 
  GmailSender, 
  OutlookSender
} from "../models/index.js";
import { Op } from "sequelize";
import { getRabbitChannel as getChannel } from "../queues/rabbit.js";
import { QUEUES } from "../queues/queues.js";

const log = (level, message, meta = {}) =>
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
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
    const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000);

    const queryOptions = {
        where: {
            warmupEnabled: true,
            isVerified: true,
            [Op.or]: [
                { lastWarmupCheckAt: { [Op.lt]: fifteenMinsAgo } },
                { lastWarmupCheckAt: null }
            ]
        },
        limit: 100, // Process in batches of 100 per producer tick
        attributes: ['id', 'email']
    };

    const [gmails, outlooks, smtps] = await Promise.all([
      GmailSender.findAll(queryOptions),
      OutlookSender.findAll(queryOptions),
      SmtpSender.findAll({ ...queryOptions, where: { ...queryOptions.where, isActive: true } }),
    ]);

    const allToEnqueue = [
      ...gmails.map(s => ({ id: s.id, type: 'gmail', email: s.email, model: GmailSender })),
      ...outlooks.map(s => ({ id: s.id, type: 'outlook', email: s.email, model: OutlookSender })),
      ...smtps.map(s => ({ id: s.id, type: 'smtp', email: s.email, model: SmtpSender })),
    ];

    if (allToEnqueue.length === 0) {
        log("INFO", "📭 No mailboxes due for warmup monitor check");
        return;
    }

    log("INFO", `Enqueuing ${allToEnqueue.length} mailboxes for warmup rescue check`);

    for (const item of allToEnqueue) {
        // 1. Mark as "Checked" immediately to prevent re-fetch in next producer tick
        await item.model.update(
            { lastWarmupCheckAt: new Date() },
            { where: { id: item.id } }
        );

        // 2. Push to Queue
        channel.sendToQueue(QUEUES.WARMUP_RESCUE, Buffer.from(JSON.stringify({
            senderId: item.id,
            senderType: item.type,
            email: item.email
        })), { persistent: true });
    }

    log("INFO", "✅ Enqueued all due mailbox checks");
  } catch (err) {
    log("ERROR", "❌ Warmup monitoring producer failed", { error: err.message });
  }
}

// Tick every 5 minutes (more aggressive but handles batches of 100)
const PRODUCER_INTERVAL = 5 * 60 * 1000;
log("INFO", "🚀 Warmup Monitoring Producer booted");
runMonitorProducerTick();
setInterval(runMonitorProducerTick, PRODUCER_INTERVAL);
