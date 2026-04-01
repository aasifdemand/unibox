/**
 * elasticsearch-sync.worker.js
 *
 * Consumes from the `es.sync` RabbitMQ queue and upserts / deletes documents
 * in Elasticsearch. This keeps Postgres as the source of truth and Elasticsearch
 * as a fast, eventually-consistent search replica.
 *
 * Message schema:
 *   { action: "upsert" | "delete", index: string, id: string, doc?: object }
 *
 * Run with: npm run es-sync
 */

import "../models/index.js";
import { initGlobalErrorHandlers } from "../utils/error-handler.js";
initGlobalErrorHandlers();

import { getRabbitChannel as getChannel } from "../queues/rabbit.js";
import { QUEUES } from "../queues/queues.js";
import { initIndices, upsertDocument, deleteDocument } from "../services/elasticsearch.service.js";

const log = (level, msg, meta = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: "es-sync", level, msg, ...meta }));

async function startWorker() {
  let channel;
  try {
    // Ensure indices exist before consuming
    await initIndices();

    channel = await getChannel();
    await channel.assertQueue(QUEUES.ES_SYNC, { durable: true });
    channel.prefetch(10);

    log("INFO", "🔍 Elasticsearch Sync Worker started");

    channel.consume(QUEUES.ES_SYNC, async (msg) => {
      if (!msg) return;

      let payload;
      try {
        payload = JSON.parse(msg.content.toString());
        const { action, index, id, doc } = payload;

        if (!action || !index || !id) {
          log("WARN", "Invalid ES sync message — missing required fields", { payload });
          return channel.ack(msg);
        }

        if (action === "upsert") {
          if (!doc) {
            log("WARN", "Upsert action missing doc", { id, index });
            return channel.ack(msg);
          }
          await upsertDocument(index, id, doc);
          log("DEBUG", `✅ Upserted [${index}/${id}]`);
        } else if (action === "delete") {
          await deleteDocument(index, id);
          log("DEBUG", `🗑️  Deleted [${index}/${id}]`);
        } else {
          log("WARN", `Unknown action: ${action}`);
        }

        channel.ack(msg);
      } catch (err) {
        log("ERROR", "Failed to process ES sync message", { error: err.message, payload });
        // Nack without requeue to avoid poison messages
        channel.nack(msg, false, false);
      }
    });

    channel.on("close", () => {
      log("WARN", "Channel closed — restarting in 5s...");
      setTimeout(startWorker, 5000);
    });
  } catch (err) {
    log("ERROR", "Worker failed to start", { error: err.message });
    setTimeout(startWorker, 5000);
  }
}

startWorker();
