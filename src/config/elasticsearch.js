import { Client } from "@elastic/elasticsearch";

let client = null;

export function getElasticsearchClient() {
  if (client) return client;

  const url = process.env.ELASTICSEARCH_URL;

  if (!url) {
    console.warn("⚠️  ELASTICSEARCH_URL not set — search features disabled.");
    return null;
  }

  const options = {
    node: url,
    requestTimeout: 60000,
    sniffOnStart: false,
    sniffOnConnectionFault: false,
    ssl: {
      rejectUnauthorized: false,
    },
    headers: {
      "x-elastic-product-origin": "elasticsearch",
    },
  };

  // Optional basic auth — set ELASTICSEARCH_USERNAME + ELASTICSEARCH_PASSWORD in .env
  const username = process.env.ELASTICSEARCH_USERNAME || "elastic";
  const password = process.env.ELASTICSEARCH_PASSWORD;
  if (username && password) {
    options.auth = { username, password };
    // Manual Authorization header failsafe
    const authBuffer = Buffer.from(`${username}:${password}`).toString("base64");
    options.headers["Authorization"] = `Basic ${authBuffer}`;
  }

  // Optional API key auth (for Elastic Cloud)
  const apiKey = process.env.ELASTICSEARCH_API_KEY;
  if (apiKey) {
    options.auth = { apiKey };
  }

  client = new Client(options);
  console.log("🔍 Elasticsearch client initialized →", url);
  return client;
}

export default getElasticsearchClient;
