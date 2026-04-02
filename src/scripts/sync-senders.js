/**
 * backend/src/scripts/sync-senders.js
 *
 * One-time script to iterate through all Senders in Postgres (Gmail, Outlook, SMTP)
 * and index them into Elasticsearch.
 */

import "../models/index.js";
import { initGlobalErrorHandlers } from "../utils/error-handler.js";
initGlobalErrorHandlers();

import GmailSender from "../models/gmail-sender.model.js";
import OutlookSender from "../models/outlook-sender.model.js";
import SmtpSender from "../models/smtp-sender.model.js";
import { INDICES, initIndices, upsertDocument } from "../services/elasticsearch.service.js";

async function syncAll() {
  console.log("🚀 Starting Bulk ES Sender Sync...");
  
  try {
    // Ensure index exists
    await initIndices();

    const syncBatch = async (instances, type) => {
      console.log(`📡 Syncing ${instances.length} ${type} senders...`);
      for (const sender of instances) {
        const doc = {
          id: sender.id,
          userId: sender.userId,
          email: sender.email,
          displayName: sender.displayName,
          domain: sender.domain,
          type: type,
          isVerified: sender.isVerified,
          warmupEnabled: sender.warmupEnabled,
          lastInboxSyncAt: sender.lastInboxSyncAt,
          dailySentCount: sender.dailySentCount,
          createdAt: sender.createdAt,
        };
        await upsertDocument(INDICES.SENDERS, sender.id, doc);
      }
    };

    const [gmails, outlooks, smtps] = await Promise.all([
      GmailSender.findAll(),
      OutlookSender.findAll(),
      SmtpSender.findAll(),
    ]);

    await syncBatch(gmails, "gmail");
    await syncBatch(outlooks, "outlook");
    await syncBatch(smtps, "smtp");

    console.log("✅ Bulk ES Sender Sync complete!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Bulk sync failed:", err.message);
    process.exit(1);
  }
}

syncAll();
