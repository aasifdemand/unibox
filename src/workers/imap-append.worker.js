import "../models/index.js";
import { initGlobalErrorHandlers } from "../utils/error-handler.js";
import { getRabbitChannel } from "../queues/rabbit.js";
import { QUEUES } from "../queues/queues.js";
import { SmtpSender } from "../models/index.js";
import {
  createImapConnection,
  resolveFolder,
  appendToFolder,
} from "../utils/imap-helper.js";
import Redis from "ioredis";

initGlobalErrorHandlers();

const redis = new Redis(process.env.REDIS_URL);

const log = (level, message, meta = {}) =>
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "imap-append-worker",
      level,
      message,
      ...meta,
    })
  );

async function processImapAppend(msg, channel) {
  const content = msg.content.toString();
  const { senderId, messageBuffer, senderType } = JSON.parse(content);

  // We only support SMTP/IMAP for manual append
  if (senderType !== "smtp") {
    return channel.ack(msg);
  }

  log("INFO", "Processing IMAP append task", { senderId });

  let imapConn;
  try {
    const sender = await SmtpSender.findByPk(senderId);
    if (!sender) {
      log("ERROR", "Sender not found for IMAP append", { senderId });
      return channel.ack(msg);
    }

    // 1. Connect to IMAP
    imapConn = await createImapConnection(sender, null);

    // 2. Resolve Sent folder
    const resolvedSent = await resolveFolder(imapConn, sender, "SENT");

    // 3. Append message
    // Note: messageBuffer comes in as a base64 string or similar from JSON.parse
    // We should ensure it's a Buffer
    const buffer = Buffer.from(messageBuffer, "base64");
    await appendToFolder(imapConn, resolvedSent, buffer);

    log("INFO", "✅ Successfully appended email to Sent folder", {
      senderId,
      folder: resolvedSent,
    });

    // 4. Clear mailbox cache so UI remains fresh
    const cachePattern = `mailbox:smtp:${senderId}:messages:*`;
    const keys = await redis.keys(cachePattern);
    if (keys.length > 0) {
      await redis.del(keys);
      log("DEBUG", "🧹 Cleared mailbox cache", { senderId, keysCount: keys.length });
    }

    // 5. Ack
    channel.ack(msg);
  } catch (err) {
    log("ERROR", "❌ IMAP append failed", {
      senderId,
      error: err.message,
    });
    // For IMAP, we might want to retry a few times if it's a conn error, 
    // but for now we'll just nack and let it sit (or discard if retry logic isn't here)
    // To avoid infinite loops on auth errors, we could check err.status
    if (err.status === 401) {
       log("WARN", "Discarding task due to Auth Error", { senderId });
       return channel.ack(msg);
    }
    
    // Nack with requeue if it might be a temporary network blip
    channel.nack(msg, false, true);
  } finally {
    if (imapConn) {
      try {
        imapConn.end();
      } catch {
        /* ignore close errors */
      }
    }
  }
}

(async () => {
  log("INFO", "IMAP Append Worker booting...");

  const channel = await getRabbitChannel();
  if (!channel) {
    log("CRITICAL", "Could not connect to RabbitMQ");
    process.exit(1);
  }

  await channel.assertQueue(QUEUES.EMAIL_APPEND_SENT, { durable: true });
  channel.prefetch(2); // Can handle a couple of slow IMAP conns in parallel

  log("INFO", "Listening for IMAP append tasks", { queue: QUEUES.EMAIL_APPEND_SENT });

  channel.consume(QUEUES.EMAIL_APPEND_SENT, (msg) => {
    if (msg) processImapAppend(msg, channel);
  });
})();
