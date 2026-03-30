import "../models/index.js";
import { initGlobalErrorHandlers } from "../utils/error-handler.js";
import { getRabbitChannel } from "../queues/rabbit.js";
import { QUEUES } from "../queues/queues.js";
import MailboxSyncService from "../services/mailbox-sync.service.js";
import { GmailSender, OutlookSender, SmtpSender } from "../models/index.js";

initGlobalErrorHandlers();

const log = (level, message, meta = {}) =>
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "mailbox-sync",
      level,
      message,
      ...meta,
    })
  );

async function processMailboxSync(msg, channel) {
  const content = msg.content.toString();
  const { senderId, senderType } = JSON.parse(content);

  log("INFO", "Consuming sync task", { senderId, senderType });

  try {
    // 1. Mark sync as started in some way or just call service
    await MailboxSyncService.syncMailbox(senderId, senderType);

    // 2. Ack the message
    channel.ack(msg);
  } catch (err) {
    log("ERROR", "Mailbox sync failed", { senderId, senderType, error: err.message });
    // Retry logic could go here, for now just nack
    channel.nack(msg, false, false);
  }
}

/**
 * Periodically queue all mailboxes for syncing
 */
async function scheduleGlobalSyncs() {
  log("INFO", "Scheduling global syncs for all verified mailboxes...");
  
  const [gmail, outlook, smtp] = await Promise.all([
    GmailSender.findAll({ where: { isVerified: true } }),
    OutlookSender.findAll({ where: { isVerified: true } }),
    SmtpSender.findAll({ where: { isVerified: true, isActive: true } }),
  ]);

  const all = [
    ...gmail.map(m => ({ id: m.id, type: 'gmail' })),
    ...outlook.map(m => ({ id: m.id, type: 'outlook' })),
    ...smtp.map(m => ({ id: m.id, type: 'smtp' })),
  ];

  for (const m of all) {
    // We could queue directly here, but using the service for now is fine
    // queueMailboxSync(m.id, m.type);
    log("DEBUG", "Queueing sync for mailbox", { id: m.id, type: m.type });
    // (Self-invocation for now, ideally this would be triggered from outside)
  }
}

(async () => {
  log("INFO", "Mailbox Sync Worker booting...");

  const channel = await getRabbitChannel();
  if (!channel) {
    log("CRITICAL", "Could not connect to RabbitMQ");
    process.exit(1);
  }

  await channel.assertQueue(QUEUES.MAILBOX_SYNC, { durable: true });
  channel.prefetch(1);

  log("INFO", "Listening for mailbox sync tasks", { queue: QUEUES.MAILBOX_SYNC });

  channel.consume(QUEUES.MAILBOX_SYNC, (msg) => {
    if (msg) processMailboxSync(msg, channel);
  });

  // Optional: Global poll for sync every 15 minutes to keep DB fresh
  // (In production, this would be a separate scheduler task)
  setInterval(() => {
    scheduleGlobalSyncs();
  }, 15 * 60 * 1000); 

})();
