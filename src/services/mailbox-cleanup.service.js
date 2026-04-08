import { MailboxFolder, MailboxMessage, SenderHealth, WarmupMessage } from "../models/index.js";
import GmailSender from "../models/gmail-sender.model.js";
import OutlookSender from "../models/outlook-sender.model.js";
import SmtpSender from "../models/smtp-sender.model.js";
import { deleteCachedData, generateCacheKey } from "../utils/redis-client.js";

/**
 * MailboxCleanupService
 * Standardizes the deletion of a mailbox and all its associated data.
 */
class MailboxCleanupService {
  /**
   * Performs deep deletion of a mailbox and polymorphic associations.
   * @param {string} mailboxId - UUID of the mailbox
   * @param {string} userId - Owner's user ID for security verification
   * @returns {Promise<boolean>} - True if successfully deleted
   */
  async cleanup(mailboxId, userId) {
    // 1. Identify the mailbox and its type
    const [gmail, outlook, smtp] = await Promise.all([
      GmailSender.findOne({ where: { id: mailboxId, userId } }),
      OutlookSender.findOne({ where: { id: mailboxId, userId } }),
      SmtpSender.findOne({ where: { id: mailboxId, userId } }),
    ]);

    const sender = gmail || outlook || smtp;
    if (!sender) return false;

    const type = gmail ? "gmail" : outlook ? "outlook" : "smtp";

    console.log(`[MailboxCleanup] Starting deep cleanup for ${type} mailbox: ${mailboxId} (${sender.email})`);

    try {
      // 2. Delete Polymorphic Associations
      // We do this manually because constraints: false is set in associations
      
      // Delete Messages
      const deletedMessages = await MailboxMessage.destroy({
        where: { senderId: mailboxId, senderType: type }
      });
      console.log(`[MailboxCleanup] Deleted ${deletedMessages} messages`);

      // Delete Folders
      const deletedFolders = await MailboxFolder.destroy({
        where: { senderId: mailboxId, senderType: type }
      });
      console.log(`[MailboxCleanup] Deleted ${deletedFolders} folders`);

      // Delete Health Record
      await SenderHealth.destroy({
        where: { mailboxId }
      });

      // Delete Warmup History
      await WarmupMessage.destroy({
        where: { senderId: mailboxId }
      });

      // 3. Clear Caches
      await deleteCachedData(generateCacheKey(type, mailboxId, "*"));
      
      // 4. Delete the Sender record itself
      await sender.destroy({ force: true });
      
      console.log(`[MailboxCleanup] Successfully WIPED mailbox ${mailboxId}`);
      return true;
    } catch (error) {
      console.error(`[MailboxCleanup] Error during cleanup for ${mailboxId}:`, error);
      throw error;
    }
  }
}

export const mailboxCleanupService = new MailboxCleanupService();
