import { Op } from "sequelize";
import { DateTime } from "luxon";
import sequelize from "../config/db.js";
import { initGlobalErrorHandlers } from "../utils/error-handler.js";
import { getRabbitChannel } from "../queues/rabbit.js";
import { QUEUES } from "../queues/queues.js";
import { queueMailboxSync } from "../queues/mailbox.queue.js";
import MailboxSyncService from "../services/mailbox-sync.service.js";
import { GmailSender, OutlookSender, SmtpSender } from "../models/index.js";

initGlobalErrorHandlers();

const log = (level, message, meta = {}) =>
  console.log(
    JSON.stringify({
      ts: DateTime.now().toISO(),
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
    await MailboxSyncService.syncMailbox(senderId, senderType);
    channel.ack(msg);
  } catch (err) {
    log("ERROR", "Mailbox sync failed", { senderId, senderType, error: err.message });
    channel.nack(msg, false, false);
  }
}

/**
 * Periodically identifies mailboxes due for syncing and leases them.
 */
async function scheduleBatchSyncs() {
  try {
    const fifteenMinsAgo = DateTime.now().minus({ minutes: 15 }).toJSDate();
    
    // Process 100 per provider per tick
    const queryOptions = {
        where: {
            isVerified: true,
            [Op.or]: [
                { lastSyncCheckAt: { [Op.lt]: fifteenMinsAgo } },
                { lastSyncCheckAt: null }
            ]
        },
        limit: 100
    };

    const providers = [
        { model: GmailSender, type: 'gmail' },
        { model: OutlookSender, type: 'outlook' },
        { model: SmtpSender, type: 'smtp', where: { ...queryOptions.where, isActive: true } }
    ];

    for (const p of providers) {
        const batch = await sequelize.transaction(async (t) => {
            const results = await p.model.findAll({
                where: p.where || queryOptions.where,
                limit: queryOptions.limit,
                lock: true,
                skipLocked: true,
                transaction: t
            });

            if (results.length > 0) {
                await p.model.update(
                    { lastSyncCheckAt: DateTime.now().toJSDate() },
                    { 
                        where: { id: { [Op.in]: results.map(r => r.id) } },
                        transaction: t 
                    }
                );
            }
            return results;
        });

        if (batch.length > 0) {
            log("INFO", `🔓 Leased ${batch.length} ${p.type} mailboxes for sync`);
            for (const m of batch) {
                queueMailboxSync(m.id, p.type);
            }
        }
    }
  } catch (err) {
    log("ERROR", "Failed to schedule batch syncs", { error: err.message });
  }
}

(async () => {
  log("INFO", "Mailbox Sync Worker booting (Distributed Mode)...");

  const channel = await getRabbitChannel();
  if (!channel) {
    log("CRITICAL", "Could not connect to RabbitMQ");
    process.exit(1);
  }

  await channel.assertQueue(QUEUES.MAILBOX_SYNC, { durable: true });
  channel.prefetch(5); // Process up to 5 in parallel per worker process

  log("INFO", "Listening for mailbox sync tasks", { queue: QUEUES.MAILBOX_SYNC });

  channel.consume(QUEUES.MAILBOX_SYNC, (msg) => {
    if (msg) processMailboxSync(msg, channel);
  });

  // Smooth polling: check for due syncs every minute
  scheduleBatchSyncs();
  setInterval(() => {
    scheduleBatchSyncs();
  }, 60 * 1000); 

})();
