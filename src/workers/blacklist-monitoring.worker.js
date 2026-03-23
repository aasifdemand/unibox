import { initGlobalErrorHandlers } from "../utils/error-handler.js";
initGlobalErrorHandlers();
import { SmtpSender, GmailSender, OutlookSender } from "../models/index.js";
import { senderHealthService } from "../services/sender-health.service.js";

(async () => {
  console.log("🚀 Advanced Health & Blacklist Monitor Started");

  setInterval(
    async () => {
      try {
        const [smtp, gmail, outlook] = await Promise.all([
          SmtpSender.findAll({ where: { isVerified: true } }),
          GmailSender.findAll({ where: { isVerified: true } }),
          OutlookSender.findAll({ where: { isVerified: true } }),
        ]);

        const allSenders = [
          ...smtp.map(s => ({ ...s.get(), type: 'smtp' })),
          ...gmail.map(s => ({ ...s.get(), type: 'gmail' })),
          ...outlook.map(s => ({ ...s.get(), type: 'outlook' })),
        ];

        console.log(`🔍 Starting full health evaluation for ${allSenders.length} senders...`);

        // 🚀 Process in parallel batches
        const BATCH_SIZE = 5;
        for (let i = 0; i < allSenders.length; i += BATCH_SIZE) {
          const batch = allSenders.slice(i, i + BATCH_SIZE);

          await Promise.allSettled(
            batch.map(async (sender) => {
              try {
                // Pass type to evaluateSender if needed, or let it handle it
                const score = await senderHealthService.evaluateSender(sender.id, sender.type);
                console.log(`✅ Sender [${sender.type}] ${sender.email} evaluated. Score: ${score}/100`);
              } catch (err) {
                console.error(`❌ Health evaluation failed for ${sender.email}:`, err);
              }
            }),
          );
        }
        console.log("🏁 Health evaluation cycle complete");
      } catch (err) {
        console.error("❌ Fatal error in health monitor cycle:", err);
      }
    },
    60 * 60 * 1000, // hourly
  );
})();
