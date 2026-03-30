import amqp from "amqplib";

let connection;
let channel;

export async function getRabbitChannel() {
  if (channel && connection) {
    try {
      // Basic check if connection is still healthy
      return channel;
    } catch (e) {
      channel = null;
      connection = null;
    }
  }

  try {
    console.log("🐇 Connecting to RabbitMQ...");
    connection = await amqp.connect(process.env.RABBITMQ_URL);
    
    connection.on("error", (err) => {
      console.error("🐇 RabbitMQ Connection Error:", err);
      connection = null;
      channel = null;
    });
    
    connection.on("close", () => {
      console.error("🐇 RabbitMQ Connection Closed. Resetting channel.");
      connection = null;
      channel = null;
    });

    channel = await connection.createChannel();

    channel.on("error", (err) => {
      console.error("🐇 RabbitMQ Channel Error:", err);
      channel = null;
    });

    channel.on("close", () => {
      console.error("🐇 RabbitMQ Channel Closed. Resetting channel.");
      channel = null;
    });

    process.on("SIGINT", async () => {
      try {
        if (channel) await channel.close();
        if (connection) await connection.close();
      } catch (e) {
        console.error("🐇 Error during RabbitMQ disconnection:", e);
      }
      process.exit(0);
    });

    console.log("🐇 RabbitMQ Connected and Channel created.");
    return channel;
  } catch (error) {
    console.error("🐇 Failed to connect to RabbitMQ:", error);
    connection = null;
    channel = null;
    throw error;
  }
}
