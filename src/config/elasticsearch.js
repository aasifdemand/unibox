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
    requestTimeout: 10000,
    sniffOnStart: false,                // Don't sniff — avoids product check issues on shared clusters
    sniffOnConnectionFault: false,
  };

  // Optional basic auth — set ELASTICSEARCH_USERNAME + ELASTICSEARCH_PASSWORD in .env
  const username = process.env.ELASTICSEARCH_USERNAME;
  const password = process.env.ELASTICSEARCH_PASSWORD;
  if (username && password) {
    options.auth = { username, password };
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
