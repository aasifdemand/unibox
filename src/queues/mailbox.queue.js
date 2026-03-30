import { getRabbitChannel } from "./rabbit.js";
import { QUEUES } from "./queues.js";

/**
 * Push a mailbox sync task to the queue
 * @param {string} senderId 
 * @param {string} senderType - 'gmail' | 'outlook' | 'smtp'
 */
export async function queueMailboxSync(senderId, senderType) {
  const channel = await getRabbitChannel();
  if (!channel) return;

  await channel.assertQueue(QUEUES.MAILBOX_SYNC, { durable: true });

  const payload = JSON.stringify({ senderId, senderType, timestamp: new Date() });
  channel.sendToQueue(QUEUES.MAILBOX_SYNC, Buffer.from(payload), {
    persistent: true,
  });

  console.log(`[MailboxQueue] Queued sync for ${senderType}:${senderId}`);
}
