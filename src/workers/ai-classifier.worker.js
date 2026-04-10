import "../models/index.js";
import { initGlobalErrorHandlers } from "../utils/error-handler.js";
initGlobalErrorHandlers();

import { DateTime } from "luxon";
import ReplyEvent from "../models/reply-event.model.js";
import Campaign from "../models/campaign.model.js";
import { getRabbitChannel as getChannel } from "../queues/rabbit.js";
import { QUEUES } from "../queues/queues.js";
import { classifyIntent } from "../services/ai.service.js";
import { syncLead } from "../services/crm-sync.service.js";

const log = (level, message, meta = {}) =>
  console.log(
    JSON.stringify({
      ts: DateTime.now().toISO(),
      service: "ai-classifier",
      level,
      message,
      ...meta,
    })
  );

async function startWorker() {
  let channel;
  try {
    channel = await getChannel();
    await channel.assertQueue(QUEUES.AI_CLASSIFY, { durable: true });
    
    // AI is slow, so we keep prefetch low but allow parallel processing if scaled
    channel.prefetch(2);

    log("INFO", "🤖 AI Intent Classifier Worker Started");

    channel.consume(QUEUES.AI_CLASSIFY, async (msg) => {
      if (!msg) return;

      try {
        const { replyEventId, body } = JSON.parse(msg.content.toString());
        log("DEBUG", "🧠 Classifying intent for reply", { replyEventId });

        const replyEvent = await ReplyEvent.findByPk(replyEventId);
        if (!replyEvent) {
          log("WARN", "Reply event not found, skipping", { replyEventId });
          return channel.ack(msg);
        }

        // 1. Classify with AI
        const intent = await classifyIntent(body).catch(() => "replied");
        
        // 2. Update Local DB
        await replyEvent.update({ intent });

        // 3. Update Lead in CRM with refined intent
        const campaign = await Campaign.findByPk(replyEvent.campaignId, { attributes: ["userId"] });
        if (campaign) {
           // Internal CRM
           await syncLead(campaign.userId, replyEvent.replyFrom, "replied", intent).catch(() => {});
           
        // 3. Enqueue CRM Sync (Async to avoid rate limits)
        const channel = await getChannel();
        await channel.assertQueue(QUEUES.CRM_SYNC, { durable: true });
        channel.sendToQueue(QUEUES.CRM_SYNC, Buffer.from(JSON.stringify({
           userId: campaign.userId,
           email: replyEvent.replyFrom,
           event: "replied",
           customPayload: {
             custom_intent: intent,
             recent_reply_body: body
           }
        })), { persistent: true });
        
        log("DEBUG", "📤 Enqueued CRM sync task", { replyEventId });
        }

        log("INFO", "✅ AI Classification complete", { replyEventId, intent });
        channel.ack(msg);
      } catch (err) {
        log("ERROR", "Failed to classify intent", { error: err.message });
        // Ack anyway to prevent infinite loop on poison messages, or move to DLQ
        channel.ack(msg);
      }
    });

    channel.on("close", () => setTimeout(startWorker, 5000));
  } catch (err) {
    log("ERROR", "AI Classifier failed to start", { error: err.message });
    setTimeout(startWorker, 5000);
  }
}

startWorker();
