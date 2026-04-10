import "../models/index.js";
import { initGlobalErrorHandlers } from "../utils/error-handler.js";
initGlobalErrorHandlers();

import { DateTime } from "luxon";
import { getRabbitChannel as getChannel } from "../queues/rabbit.js";
import { QUEUES } from "../queues/queues.js";
import { syncLeadToAllCRMs } from "../services/crm-sync.provider.js";

const log = (level, message, meta = {}) =>
  console.log(
    JSON.stringify({
      ts: DateTime.now().toISO(),
      service: "crm-sync-worker",
      level,
      message,
      ...meta,
    })
  );

async function startWorker() {
  let channel;
  try {
    channel = await getChannel();
    await channel.assertQueue(QUEUES.CRM_SYNC, { durable: true });
    
    // CRM APIs are very slow and strictly rate-limited. 
    // We keep prefetch low to avoid blasting all connections at once.
    channel.prefetch(5);

    log("INFO", "🤝 CRM Sync Worker Started (Rate-Limit Shield Active)");

    channel.consume(QUEUES.CRM_SYNC, async (msg) => {
      if (!msg) return;

      try {
        const { userId, email, event, customPayload } = JSON.parse(msg.content.toString());
        log("DEBUG", "🔗 Syncing lead to external CRMs", { userId, email, event });

        // Execute actual sync
        await syncLeadToAllCRMs(userId, email, event, customPayload);

        log("INFO", "✅ CRM sync complete", { userId, email });
        channel.ack(msg);
      } catch (err) {
        log("ERROR", "CRM sync failed", { error: err.message });
        // Retry logic: If it failed, we could nack with requeue=true, 
        // but to prevent infinite loops on bad credentials, we'll ack and let the syncLeadToAllCRMs internal update handle the 'error' status.
        channel.ack(msg);
      }
    });

    channel.on("close", () => setTimeout(startWorker, 5000));
  } catch (err) {
    log("ERROR", "CRM Sync Worker failed to start", { error: err.message });
    setTimeout(startWorker, 5000);
  }
}

startWorker();
