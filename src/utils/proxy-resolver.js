import fs from "fs/promises";
import path from "path";
import { getCachedData, setCachedData, deleteCachedData } from "./redis-client.js";
import crypto from "crypto";

const STICKY_TTL = 86400; // 24 hours (86,400 seconds)
const PROXIES_FILE = path.join(process.cwd(), "proxies.json");

/**
 * SAMPLE PROXY FORMAT for proxies.json:
 * [
 *   "socks5://username:password@ip:port",
 *   "socks5://user2:pass2@1.2.3.4:1080",
 *   "socks5://user:pass-{session}@ip:port"
 * ]
 */

/**
 * Resolves a SOCKS5 proxy for a given email address from proxies.json with 24h sticky sessions.
 * Supports "Smart Sessions" where a single rotating proxy endpoint can be used for 
 * unique IPs using {session} placeholder.
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
    let selectedProxy = proxyPool[Math.floor(Math.random() * proxyPool.length)];

    // 4️⃣ Smart Session Logic
    // If proxy contains {session}, replace it with a unique ID for this email
    if (selectedProxy.includes("{session}")) {
      const sessId = crypto.createHash("md5").update(emailLower).digest("hex").slice(0, 8);
      selectedProxy = selectedProxy.replace("{session}", sessId);
    }

    // 5️⃣ Stick this IP to the user for 24h
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
