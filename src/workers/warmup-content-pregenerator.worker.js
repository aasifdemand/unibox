import { initGlobalErrorHandlers } from "../utils/error-handler.js";
initGlobalErrorHandlers();

import { WarmupContentPool } from "../models/index.js";
import { activeWarmupService } from "../services/active-warmup.service.js";
import { DateTime } from "luxon";

const BATCH_SIZE = 50; // How many to generate in one tick
const THRESHOLD = 1000; // Refill if below this
const TICK_INTERVAL_MS = 1 * 60 * 1000; // Check every minute

const log = (level, message, meta = {}) =>
  console.log(
    JSON.stringify({
      ts: DateTime.now().toISO(),
      service: "warmup-content-pregenerator",
      level,
      message,
      ...meta,
    })
  );

async function refillPool() {
  try {
    log("INFO", "🔍 Checking Warmup Content Pool status");

    // 1. Check Emails
    const emailCount = await WarmupContentPool.count({ where: { isUsed: false, type: "email" } });
    if (emailCount < THRESHOLD) {
      log("INFO", `Pool low on emails (${emailCount}/${THRESHOLD}). Generating ${BATCH_SIZE} new entries...`);
      for (let i = 0; i < BATCH_SIZE; i++) {
        const content = await activeWarmupService.generateWarmupContent(true); // Force AI
        await WarmupContentPool.create({
          subject: content.subject,
          body: content.body,
          type: "email",
          isUsed: false
        });
      }
      log("INFO", `Successfully added ${BATCH_SIZE} emails to the pool.`);
    }

    // 2. Check Replies
    const replyCount = await WarmupContentPool.count({ where: { isUsed: false, type: "reply" } });
    if (replyCount < THRESHOLD) {
      log("INFO", `Pool low on replies (${replyCount}/${THRESHOLD}). Generating ${BATCH_SIZE} new entries...`);
      for (let i = 0; i < BATCH_SIZE; i++) {
        // For replies, we generate a generic high-quality one
        const replyBody = await activeWarmupService.generateWarmupReply("Generic Subject", "Generic Body Content", true); // Force AI
        await WarmupContentPool.create({
          subject: "Re: Warmup",
          body: replyBody,
          type: "reply",
          isUsed: false
        });
      }
      log("INFO", `Successfully added ${BATCH_SIZE} replies to the pool.`);
    }

    log("INFO", "✅ Pool check completed");
  } catch (err) {
    log("ERROR", "❌ Failed to refill content pool", { error: err.message });
  }
}

async function boot() {
  log("INFO", "🚀 Warmup Content Pregenerator Worker started");
  await refillPool();
  setInterval(refillPool, TICK_INTERVAL_MS);
}

boot();
