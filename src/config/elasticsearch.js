import { Client } from "@elastic/elasticsearch";

let client = null;

export function getElasticsearchClient() {
  if (client) return client;

  let url = process.env.ELASTICSEARCH_URL;
  if (url && url.includes("localhost")) {
    url = url.replace("localhost", "127.0.0.1");
  }

  if (!url) {
    console.warn("⚠️  ELASTICSEARCH_URL not set — search features disabled.");
    return null;
  }

  // Basic Auth - Brute Force Header Injection for Docker
  const username = process.env.ELASTICSEARCH_USERNAME || "elastic";
  let rawPassword = process.env.ELASTICSEARCH_PASSWORD || "";
  let password = rawPassword;
  try {
    if (rawPassword.includes("%")) password = decodeURIComponent(rawPassword);
  } catch (err) { /* ignore */ }

  const authBuffer = Buffer.from(`${username}:${password}`).toString("base64");

  const options = {
    node: url,
    requestTimeout: 60000,
    maxRetries: 3,
    sniffOnStart: false,
    sniffOnConnectionFault: false,
    agent: false,
    ssl: { rejectUnauthorized: false },
    headers: {
      "Authorization": `Basic ${authBuffer}`,
      "x-elastic-product-origin": "elasticsearch",
      "Accept": "application/vnd.elasticsearch+json; compatible-with=7",
      "Content-Type": "application/json",
    },
    enableMetaHeader: false,
  };

  if (password) {
    const maskedPass = password.substring(0, 2) + "***";
    console.log(`📡 ES Docker Auth: user=${username}, pass=${maskedPass}, target=${url}`);
  }

  client = new Client(options);
  console.log("🔍 Elasticsearch client initialized →", url.includes("@") ? url.split("@")[1] : url);
  return client;
}

export default getElasticsearchClient;
