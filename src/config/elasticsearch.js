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

  // Basic Auth
  const username = process.env.ELASTICSEARCH_USERNAME || "elastic";
  const password = process.env.ELASTICSEARCH_PASSWORD;

  const options = {
    node: url,
    requestTimeout: 60000,
    maxRetries: 3,
    sniffOnStart: false,
    sniffOnConnectionFault: false,
    agent: false,
    ssl: { rejectUnauthorized: false },
    // 🛡️ DEFINITIVE COMPATIBILITY HEADERS
    headers: {
      "x-elastic-product-origin": "elasticsearch",
      "Accept": "application/vnd.elasticsearch+json; compatible-with=7",
      "Content-Type": "application/json",
    },
    // Bypass internal product checks for official client v7.14+
    enableMetaHeader: false,
  };

  if (username && password) {
    options.auth = { username, password };
    // Brute-force auth header failsafe
    const authBuffer = Buffer.from(`${username}:${password}`).toString("base64");
    options.headers["Authorization"] = `Basic ${authBuffer}`;

    const maskedPass = (password || "").substring(0, 2) + "***";
    console.log(`🔑 ES Auth detected: user=${username}, pass=${maskedPass}`);
  }

  client = new Client(options);
  console.log("🔍 Elasticsearch client initialized →", url.includes("@") ? url.split("@")[1] : url);
  return client;
}

export default getElasticsearchClient;
