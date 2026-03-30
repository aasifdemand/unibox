import { getRabbitChannel } from "./rabbit.js";

const QUEUE = "campaign.tick";

export async function publishCampaignTick(campaignId) {
  const channel = await getRabbitChannel();
  await channel.assertQueue(QUEUE, { durable: true });

  channel.sendToQueue(
    QUEUE,
    Buffer.from(JSON.stringify({ campaignId })),
    { persistent: true }
  );
}
