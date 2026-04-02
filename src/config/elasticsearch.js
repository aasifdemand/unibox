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
  
  if (url && username && password) {
    // Inject auth directly into URL format: http://user:pass@host:port
    const protocol = url.split("://")[0];
    const hostPort = url.split("://")[1];
    url = `${protocol}://${username}:${encodeURIComponent(password)}@${hostPort}`;
  }

  const options = {
    node: url,
    requestTimeout: 60000,
    maxRetries: 3,
    sniffOnStart: false,
    sniffOnConnectionFault: false,
    agent: false,
    ssl: { rejectUnauthorized: false },
    headers: {
      "x-elastic-product-origin": "elasticsearch",
    },
  };

  if (username && password) {
    const maskedPass = (password || "").substring(0, 2) + "***";
    console.log(`🔑 ES Auth detected: user=${username}, pass=${maskedPass}`);
  }

  // Optional API key auth (for Elastic Cloud)
  const apiKey = process.env.ELASTICSEARCH_API_KEY;
  if (apiKey) {
    options.auth = { apiKey };
  }

  client = new Client(options);
  console.log("🔍 Elasticsearch client initialized →", url.includes("@") ? url.split("@")[1] : url);
  return client;
}

export default getElasticsearchClient;
