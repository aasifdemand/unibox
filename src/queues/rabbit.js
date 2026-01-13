import amqp from "amqplib";

let connection;
let channel;

export async function getChannel() {
  if (channel) return channel;

  connection = await amqp.connect(process.env.RABBITMQ_URL);
  channel = await connection.createChannel();

  process.on("SIGINT", async () => {
    await channel.close();
    await connection.close();
    process.exit(0);
  });

  return channel;
}
