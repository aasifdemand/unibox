import fs from "fs/promises";
import path from "path";
import { getCachedData, setCachedData, deleteCachedData } from "./redis-client.js";

const STICKY_TTL = 86400; // 24 hours (86,400 seconds)
const PROXIES_FILE = path.join(process.cwd(), "proxies.json");

/**
 * SAMPLE PROXY FORMAT for proxies.json:
 * [
 *   "socks5://username:password@ip:port",
 *   "socks5://user2:pass2@1.2.3.4:1080"
 * ]
 */

/**
 * Resolves a SOCKS5 proxy for a given email address from proxies.json with 24h sticky sessions.
 * 1. Checks Redis for a sticky IP assigned to this email.
 * 2. If not found, loads from proxies.json.
 * 3. Assigns and caches the IP for 24h.
 * 
 * @param {string} email - Sender email
 * @returns {Promise<string|null>} socks5://user:pass@host:port
 */
export const getProxyForEmail = async (email) => {
  if (!email) return null;
  const emailLower = email.toLowerCase();
  const cacheKey = `proxy:sticky:${emailLower}`;

  try {
    // 1️⃣ Check Redis for sticky session (24h window)
    const existingProxy = await getCachedData(cacheKey);
    if (existingProxy) {
      return existingProxy;
    }

    // 2️⃣ Load pool from proxies.json
    let proxyPool = [];
    try {
      const fileData = await fs.readFile(PROXIES_FILE, "utf8");
      proxyPool = JSON.parse(fileData);
    } catch {
      // File missing or empty
    }

    if (!proxyPool || proxyPool.length === 0) {
      console.warn(`⚠️ No proxies available in proxies.json for ${emailLower}. Falling back to server IP.`);
      return null;
    }

    // 3️⃣ Selection logic: Randomized for load balancing
    const selectedProxy = proxyPool[Math.floor(Math.random() * proxyPool.length)];

    // 4️⃣ Stick this IP to the user for 24h
    await setCachedData(cacheKey, selectedProxy, STICKY_TTL);

    console.log(`✅ Assigned new SOCKS5 proxy to ${emailLower} (Sticky for 24h)`);
    return selectedProxy;
  } catch (error) {
    console.error("❌ Proxy resolution error:", error.message);
    return null;
  }
};

/**
 * Forcefully flushes a sticky proxy (Self-Healing).
 * Used when a worker detects a dead or blocked proxy IP.
 */
export const deleteProxySticky = async (email) => {
  if (!email) return;
  const cacheKey = `proxy:sticky:${email.toLowerCase()}`;
  try {
    await deleteCachedData(cacheKey);
    console.log(`♻️ Flushed dead proxy for ${email}. Next send will rotate.`);
  } catch (error) {
    console.error("❌ Failed to flush sticky proxy:", error.message);
  }
};
