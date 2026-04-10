import "../models/index.js";
import { initGlobalErrorHandlers } from "../utils/error-handler.js";
initGlobalErrorHandlers();

import { DateTime } from "luxon";
import { Op } from "sequelize";
import Email from "../models/email.model.js";
import ReplyEvent from "../models/reply-event.model.js";
import BounceEvent from "../models/bounce-event.model.js";

const log = (level, message, meta = {}) =>
  console.log(
    JSON.stringify({
      ts: DateTime.now().toISO(),
      service: "maintenance",
      level,
      message,
      ...meta,
    })
  );

const RETENTION_DAYS = 90;
const PURGE_BATCH_SIZE = 5000;

async function purgeOldRecords() {
  log("INFO", "🧹 Starting daily maintenance purge", { retentionDays: RETENTION_DAYS });

  const threshold = DateTime.now().minus({ days: RETENTION_DAYS }).toJSDate();

  const models = [
    { name: "Email", model: Email, dateField: "createdAt" },
    { name: "ReplyEvent", model: ReplyEvent, dateField: "createdAt" },
    { name: "BounceEvent", model: BounceEvent, dateField: "createdAt" }
  ];

  for (const m of models) {
    let totalDeleted = 0;
    let deletedInBatch = 1;

    try {
      while (deletedInBatch > 0) {
        deletedInBatch = await m.model.destroy({
          where: {
            [m.dateField]: { [Op.lt]: threshold }
          },
          limit: PURGE_BATCH_SIZE
        });
        totalDeleted += deletedInBatch;
        if (deletedInBatch > 0) {
            log("DEBUG", `🗑️ [${m.name}] Purged ${deletedInBatch} records...`, { totalDeleted });
            await new Promise(r => setTimeout(r, 1000));
        }
      }
      log("INFO", `✅ Finished purging ${m.name}`, { totalDeleted });
    } catch (err) {
      log("ERROR", `❌ Failed to purge ${m.name}`, { error: err.message });
    }
  }

  log("INFO", "✨ Maintenance cycle complete");
}

(async () => {
    log("INFO", "🚀 Maintenance worker started");
    await purgeOldRecords();
    setInterval(async () => {
        await purgeOldRecords();
    }, 24 * 60 * 60 * 1000);
})();
