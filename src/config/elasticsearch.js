import { Client } from "@elastic/elasticsearch";

let client = null;

export function getElasticsearchClient() {
  if (client) return client;

  const url = process.env.ELASTICSEARCH_URL;

  if (!url) {
    console.warn("⚠️  ELASTICSEARCH_URL not set — search features disabled.");
    return null;
  }

  client = new Client({
    node: url,
    auth: process.env.ELASTICSEARCH_API_KEY
      ? { apiKey: process.env.ELASTICSEARCH_API_KEY }
      : undefined,
    tls: {
      rejectUnauthorized: process.env.NODE_ENV === "production",
    },
  });

  console.log("🔍 Elasticsearch client initialized →", url);
  return client;
}

export default getElasticsearchClient;
