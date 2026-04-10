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
import { initIndices, bulkUpdate } from "../services/elasticsearch.service.js";

const log = (level, msg, meta = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: "es-sync", level, msg, ...meta }));

async function startWorker() {
  let channel;
  try {
    // Ensure indices exist before consuming
    await initIndices();

    channel = await getChannel();
    await channel.assertQueue(QUEUES.ES_SYNC, { durable: true });

    // Higher prefetch for bulk processing
    channel.prefetch(100);

    log("INFO", "🔍 Elasticsearch Sync Worker started (Bulk Mode)");

    let buffer = [];
    let flushTimeout = null;

    const flushBuffer = async () => {
      if (buffer.length === 0) return;

      const ops = [...buffer];
      buffer = [];
      if (flushTimeout) {
        clearTimeout(flushTimeout);
        flushTimeout = null;
      }

      try {
        await bulkUpdate(ops.map(o => o.payload));
        // Ack all messages in this batch
        ops.forEach(o => channel.ack(o.msg));
        log("DEBUG", `🚀 Bulk synced ${ops.length} operations to ES`);
      } catch (err) {
        log("ERROR", "Bulk sync flush failed", { error: err.message });
        // Requeue them individually on failure
        ops.forEach(o => channel.nack(o.msg, false, true));
      }
    };

    channel.consume(QUEUES.ES_SYNC, async (msg) => {
      if (!msg) return;

      try {
        const payload = JSON.parse(msg.content.toString());
        buffer.push({ msg, payload });

        if (buffer.length >= 50) {
          await flushBuffer();
        } else if (!flushTimeout) {
          flushTimeout = setTimeout(flushBuffer, 2000);
        }
      } catch (err) {
        log("ERROR", "Failed to parse ES sync message", { error: err.message });
        channel.ack(msg);
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
