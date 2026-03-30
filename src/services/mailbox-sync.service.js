import { google } from "googleapis";
import axios from "axios";
import { MailboxFolder, MailboxMessage, GmailSender, OutlookSender, SmtpSender } from "../models/index.js";
import { refreshGoogleToken } from "../utils/refresh-google-token.js";
import { getValidMicrosoftToken } from "../utils/get-valid-microsoft-token.js";
import { emitToUser } from "../utils/event-broadcaster.js";
import { createImapConnection, flattenBoxes } from "../utils/imap-helper.js";
import { simpleParser } from "mailparser";
import util from "util";

/**
 * MailboxSyncService
 * Handles background synchronization of mailbox data (folders and message metadata)
 * for Gmail, Outlook, and SMTP/IMAP providers.
 */
class MailboxSyncService {
  /**
   * Main entry point to sync a mailbox
   * @param {string} senderId 
   * @param {string} senderType - 'gmail' | 'outlook' | 'smtp'
   */
  async syncMailbox(senderId, senderType) {
    console.log(`[MailboxSync] Starting sync for ${senderType}:${senderId}`);
    
    try {
      let sender;
      if (senderType === 'gmail') sender = await GmailSender.findByPk(senderId);
      else if (senderType === 'outlook') sender = await OutlookSender.findByPk(senderId);
      else if (senderType === 'smtp') sender = await SmtpSender.findByPk(senderId);

      if (!sender || !sender.isVerified) {
        console.error(`[MailboxSync] Sender ${senderId} not found or not verified`);
        return;
      }

      // 1. Sync Folders
      const folders = await this.syncFolders(sender, senderType);
      
      // 2. Sync Messages for each folder (Prioritizing INBOX)
      if (folders && folders.length > 0) {
        // Prioritize inbox for immediate UI feedback
        const inbox = folders.find(f => f.folderType === 'inbox' || f.name.toLowerCase() === 'inbox');
        if (inbox) {
          await this.syncMessages(sender, senderType, inbox);
        }

        // Then sync other common folders
        for (const folder of folders) {
          if (folder.id !== inbox?.id) {
            await this.syncMessages(sender, senderType, folder);
          }
        }
      }

      console.log(`[MailboxSync] Sync completed for ${senderType}:${senderId}`);
      
      // Notify UI
      emitToUser(sender.userId, 'mailbox_synced', {
        senderId: sender.id,
        senderType
      });

    } catch (error) {
      console.error(`[MailboxSync] Error syncing ${senderType}:${senderId}:`, error.message);
    }
  }

  /**
   * Sync Folders/Labels from provider to local DB
   */
  async syncFolders(sender, senderType) {
    if (senderType === 'gmail') return this.syncGmailFolders(sender);
    if (senderType === 'outlook') return this.syncOutlookFolders(sender);
    if (senderType === 'smtp') return this.syncImapFolders(sender);
    return [];
  }

  /**
   * Sync Message metadata from provider to local DB
   */
  async syncMessages(sender, senderType, folder) {
    if (senderType === 'gmail') return this.syncGmailMessages(sender, folder);
    if (senderType === 'outlook') return this.syncOutlookMessages(sender, folder);
    if (senderType === 'smtp') return this.syncImapMessages(sender, folder);
    return [];
  }

  /* =========================
     GMAIL SYNC LOGIC
  ========================= */

  async syncGmailFolders(sender) {
    const tokenData = await refreshGoogleToken(sender);
    if (!tokenData) return [];

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_CALLBACK_URL_SENDER
    );
    oauth2Client.setCredentials({ access_token: tokenData.accessToken });
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    const response = await gmail.users.labels.list({ userId: "me" });
    const labels = response.data.labels || [];

    const syncedFolders = [];
    for (const label of labels) {
      const [folder] = await MailboxFolder.upsert({
        senderId: sender.id,
        senderType: 'gmail',
        providerFolderId: label.id,
        name: label.name,
        folderType: this.mapGmailLabelToFolderType(label.id),
      });
      syncedFolders.push(folder);
    }
    return syncedFolders;
  }

  async syncGmailMessages(sender, folder) {
    const tokenData = await refreshGoogleToken(sender);
    if (!tokenData) return;

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_CALLBACK_URL_SENDER
    );
    oauth2Client.setCredentials({ access_token: tokenData.accessToken });
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    // Fetch message list for this label
    const response = await gmail.users.messages.list({
      userId: "me",
      labelIds: [folder.providerFolderId],
      maxResults: 50, // Initial sync limit
    });

    const messages = response.data.messages || [];
    for (const msg of messages) {
      // Check if already exists to skip full fetch
      const exists = await MailboxMessage.findOne({
        where: { senderId: sender.id, providerMessageId: msg.id }
      });
      if (exists) continue;

      // Fetch metadata
      const full = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"],
      });

      const headers = {};
      (full.data.payload?.headers || []).forEach(h => { headers[h.name] = h.value; });

      await MailboxMessage.create({
        senderId: sender.id,
        senderType: 'gmail',
        folderId: folder.id,
        providerMessageId: msg.id,
        providerThreadId: full.data.threadId,
        subject: headers["Subject"] || "",
        from: headers["From"] || "",
        to: headers["To"] || "",
        date: new Date(headers["Date"] || Date.now()),
        snippet: full.data.snippet || "",
        isRead: !full.data.labelIds?.includes("UNREAD"),
      });
    }
  }

  /* =========================
     OUTLOOK SYNC LOGIC
  ========================= */

  async syncOutlookFolders(sender) {
    const token = await getValidMicrosoftToken(sender);
    if (!token) return [];

    console.log(`[MailboxSync] Fetching Outlook folders for ${sender.email}`);

    const fetchFolders = async (url = "https://graph.microsoft.com/v1.0/me/mailFolders") => {
      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        params: { 
          $top: 100,
          $expand: "childFolders($select=id,displayName,unreadItemCount,totalItemCount,childFolderCount)"
        }
      });
      return response.data.value || [];
    };

    const allFolders = await fetchFolders();
    const syncedFolders = [];

    const processFolders = async (folders) => {
      for (const f of folders) {
        console.log(`[MailboxSync] Syncing Outlook folder: ${f.displayName}`);
        const [folder] = await MailboxFolder.upsert({
          senderId: sender.id,
          senderType: 'outlook',
          providerFolderId: f.id,
          name: f.displayName,
          folderType: this.mapOutlookFolderToType(f.id, f.displayName),
          unreadCount: f.unreadItemCount || 0,
          totalCount: f.totalItemCount || 0,
        });
        syncedFolders.push(folder);

        if (f.childFolders && f.childFolders.length > 0) {
          await processFolders(f.childFolders);
        }
      }
    };

    await processFolders(allFolders);
    return syncedFolders;
  }

  async syncOutlookMessages(sender, folder) {
    const token = await getValidMicrosoftToken(sender);
    if (!token) return;

    const response = await axios.get(
      `https://graph.microsoft.com/v1.0/me/mailFolders/${folder.providerFolderId}/messages`,
      {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          $top: 50,
          $select: "id,subject,from,toRecipients,receivedDateTime,isRead,bodyPreview,conversationId",
        }
      }
    );

    const messages = response.data.value || [];
    for (const msg of messages) {
      await MailboxMessage.upsert({
        senderId: sender.id,
        senderType: 'outlook',
        folderId: folder.id,
        providerMessageId: msg.id,
        providerThreadId: msg.conversationId,
        subject: msg.subject || "",
        from: msg.from?.emailAddress?.address || "",
        to: msg.toRecipients?.map(r => r.emailAddress?.address).join(", ") || "",
        date: new Date(msg.receivedDateTime),
        snippet: msg.bodyPreview || "",
        isRead: msg.isRead,
      });
    }

    // Update folder sync timestamp
    if (folder.update) {
      await folder.update({ lastSyncAt: new Date() });
    }
  }

  /* =========================
     IMAP SYNC LOGIC (SMTP)
  ========================= */

  async syncImapFolders(sender) {
    const imap = await createImapConnection(sender);
    const getBoxes = util.promisify(imap.getBoxes).bind(imap);
    
    try {
      const boxes = await getBoxes();
      const flatBoxes = flattenBoxes(boxes);
      const syncedFolders = [];

      for (const boxName of flatBoxes) {
        const [folder] = await MailboxFolder.upsert({
          senderId: sender.id,
          senderType: 'smtp',
          providerFolderId: boxName,
          name: boxName,
          folderType: this.mapImapFolderToType(boxName),
        });
        syncedFolders.push(folder);
      }
      return syncedFolders;
    } finally {
      imap.end();
    }
  }

  async syncImapMessages(sender, folder) {
    const imap = await createImapConnection(sender);
    
    return new Promise((resolve, reject) => {
      imap.openBox(folder.providerFolderId, true, (err, box) => {
        if (err) {
          imap.end();
          return reject(err);
        }

        const total = box.messages.total;
        if (total === 0) {
          imap.end();
          return resolve();
        }

        // Fetch last 50 messages
        const start = Math.max(1, total - 49);
        const f = imap.seq.fetch(`${start}:${total}`, { bodies: 'HEADER.FIELDS (FROM TO SUBJECT DATE)' });

        f.on('message', (msg, seqno) => {
          let attributes;
          msg.on('body', (stream) => {
            let buffer = '';
            stream.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
            stream.once('end', async () => {
              try {
                const parsed = await simpleParser(buffer);
                
                await MailboxMessage.upsert({
                  senderId: sender.id,
                  senderType: 'smtp',
                  folderId: folder.id,
                  providerMessageId: `imap-${sender.id}-${seqno}`,
                  subject: parsed.subject || "",
                  from: parsed.from?.text || "",
                  to: parsed.to?.text || "",
                  date: parsed.date || new Date(),
                  snippet: "",
                  isRead: (attributes?.flags || []).includes('\\Seen'),
                });
              } catch (parseErr) {
                console.error("[MailboxSync] IMAP parse error:", parseErr.message);
              }
            });
          });
          msg.once('attributes', (attrs) => { attributes = attrs; });
        });

        f.once('error', (err) => {
          imap.end();
          reject(err);
        });

        f.once('end', () => {
          imap.end();
          resolve();
        });
      });
    });
  }

  /* =========================
     HELPERS
  ========================= */

  mapGmailLabelToFolderType(labelId) {
    const map = { INBOX: 'inbox', SENT: 'sent', TRASH: 'trash', SPAM: 'spam', DRAFT: 'draft' };
    return map[labelId] || 'custom';
  }

  mapOutlookFolderToType(id, name) {
    const n = name.toLowerCase();
    if (n.includes('inbox')) return 'inbox';
    if (n.includes('sent')) return 'sent';
    if (n.includes('deleted') || n.includes('trash')) return 'trash';
    if (n.includes('junk') || n.includes('spam')) return 'spam';
    if (n.includes('drafts')) return 'draft';
    return 'custom';
  }

  mapImapFolderToType(name) {
    const n = name.toLowerCase();
    if (n.includes('inbox')) return 'inbox';
    if (n.includes('sent')) return 'sent';
    if (n.includes('trash') || n.includes('deleted')) return 'trash';
    if (n.includes('spam') || n.includes('junk')) return 'spam';
    if (n.includes('draft')) return 'draft';
    return 'custom';
  }
}

export default new MailboxSyncService();
