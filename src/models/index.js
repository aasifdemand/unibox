import User from "./user.model.js";
import GmailSender from "./gmail-sender.model.js";
import OutlookSender from "./outlook-sender.model.js";
import SmtpSender from "./smtp-sender.model.js";
import Campaign from "./campaign.model.js";
import CampaignStep from "./campaign-step.model.js";
import CampaignRecipient from "./campaign-recipient.model.js";
import CampaignSend from "./campaign-send.model.js";

import Email from "./email.model.js";
import EmailEvent from "./email-event.model.js";
import ReplyEvent from "./reply-event.model.js";
import BounceEvent from "./bounce-event.model.js";

import ListUploadBatch from "./list-upload-batch.model.js";
import ListUploadRecord from "./list-upload-record.model.js";
import GlobalEmailRegistry from "./global-email-registry.model.js";
import SenderHealth from "./sender-health.model.js";
import Notification from "./notification.model.js";
import CrmStage from "./crm-stage.model.js";
import Lead from "./lead.model.js";
import Integration from "./integration.model.js";
import MailboxFolder from "./mailbox-folder.model.js";
import MailboxMessage from "./mailbox-message.model.js";
import WarmupMessage from "./warmup-message.model.js";
import { INDICES, upsertDocument, deleteDocument } from "../services/elasticsearch.service.js";
import { getRabbitChannel } from "../queues/rabbit.js";
import { QUEUES } from "../queues/queues.js";
/* =====================================================
   USER OWNERSHIP
===================================================== */

// User → GmailSenders
User.hasMany(GmailSender, { foreignKey: "userId", onDelete: "CASCADE" });
GmailSender.belongsTo(User, { foreignKey: "userId" });

// User → OutlookSenders
User.hasMany(OutlookSender, { foreignKey: "userId", onDelete: "CASCADE" });
OutlookSender.belongsTo(User, { foreignKey: "userId" });

// User → SmtpSenders
User.hasMany(SmtpSender, { foreignKey: "userId", onDelete: "CASCADE" });
SmtpSender.belongsTo(User, { foreignKey: "userId" });

// User → Campaigns
User.hasMany(Campaign, { foreignKey: "userId", onDelete: "CASCADE" });
Campaign.belongsTo(User, { foreignKey: "userId" });

// User → Emails
User.hasMany(Email, { foreignKey: "userId", onDelete: "CASCADE" });
Email.belongsTo(User, { foreignKey: "userId" });

// User → List Upload Batches
User.hasMany(ListUploadBatch, { foreignKey: "userId", onDelete: "CASCADE" });
ListUploadBatch.belongsTo(User, { foreignKey: "userId" });

/* =====================================================
   POLYMORPHIC SENDER RELATIONSHIPS
   IMPORTANT: constraints: false everywhere
===================================================== */

/* ---------- Campaign ↔ Sender ---------- */

GmailSender.hasMany(Campaign, {
  foreignKey: "senderId",
  constraints: false,
});
Campaign.belongsTo(GmailSender, {
  foreignKey: "senderId",
  constraints: false,
});

OutlookSender.hasMany(Campaign, {
  foreignKey: "senderId",
  constraints: false,
});
Campaign.belongsTo(OutlookSender, {
  foreignKey: "senderId",
  constraints: false,
});

SmtpSender.hasMany(Campaign, {
  foreignKey: "senderId",
  constraints: false,
});
Campaign.belongsTo(SmtpSender, {
  foreignKey: "senderId",
  constraints: false,
});

/* ---------- Email ↔ Sender ---------- */

GmailSender.hasMany(Email, {
  foreignKey: "senderId",
  constraints: false,
});
Email.belongsTo(GmailSender, {
  foreignKey: "senderId",
  constraints: false,
});

OutlookSender.hasMany(Email, {
  foreignKey: "senderId",
  constraints: false,
});
Email.belongsTo(OutlookSender, {
  foreignKey: "senderId",
  constraints: false,
});

SmtpSender.hasMany(Email, {
  foreignKey: "senderId",
  constraints: false,
});
Email.belongsTo(SmtpSender, {
  foreignKey: "senderId",
  constraints: false,
});

/* ---------- CampaignSend ↔ Sender ---------- */

GmailSender.hasMany(CampaignSend, {
  foreignKey: "senderId",
  constraints: false,
});
CampaignSend.belongsTo(GmailSender, {
  foreignKey: "senderId",
  constraints: false,
});

OutlookSender.hasMany(CampaignSend, {
  foreignKey: "senderId",
  constraints: false,
});
CampaignSend.belongsTo(OutlookSender, {
  foreignKey: "senderId",
  constraints: false,
});

SmtpSender.hasMany(CampaignSend, {
  foreignKey: "senderId",
  constraints: false,
});
CampaignSend.belongsTo(SmtpSender, {
  foreignKey: "senderId",
  constraints: false,
});

/* =====================================================
   CAMPAIGN CORE
===================================================== */

// Campaign → Steps
Campaign.hasMany(CampaignStep, {
  foreignKey: "campaignId",
  onDelete: "CASCADE",
});
CampaignStep.belongsTo(Campaign, {
  foreignKey: "campaignId",
});

// Campaign → Recipients
Campaign.hasMany(CampaignRecipient, {
  foreignKey: "campaignId",
  onDelete: "CASCADE",
});
CampaignRecipient.belongsTo(Campaign, {
  foreignKey: "campaignId",
});

// Campaign → Sends
Campaign.hasMany(CampaignSend, {
  foreignKey: "campaignId",
  onDelete: "CASCADE",
});
CampaignSend.belongsTo(Campaign, {
  foreignKey: "campaignId",
});

/* =====================================================
   CAMPAIGN RECIPIENT LINKS
===================================================== */

CampaignRecipient.hasMany(CampaignSend, {
  foreignKey: "recipientId",
  onDelete: "CASCADE",
});
CampaignSend.belongsTo(CampaignRecipient, {
  foreignKey: "recipientId",
});

CampaignSend.belongsTo(Email, {
  foreignKey: "emailId",
  as: "email",
  onDelete: "SET NULL",
});

/* =====================================================
   EMAIL LIFECYCLE
===================================================== */

Campaign.hasMany(Email, {
  foreignKey: "campaignId",
  onDelete: "SET NULL",
});
Email.belongsTo(Campaign, {
  foreignKey: "campaignId",
});

Email.hasMany(EmailEvent, {
  foreignKey: "emailId",
  onDelete: "CASCADE",
});
EmailEvent.belongsTo(Email, {
  foreignKey: "emailId",
});

Email.hasMany(ReplyEvent, {
  foreignKey: "emailId",
  as: "replies",
  onDelete: "CASCADE",
});
ReplyEvent.belongsTo(Email, {
  foreignKey: "emailId",
  as: "email",
});

Email.hasMany(BounceEvent, {
  foreignKey: "emailId",
  as: "bounces",
  onDelete: "CASCADE",
});
BounceEvent.belongsTo(Email, {
  foreignKey: "emailId",
  as: "email",
});

/* =====================================================
   LIST UPLOAD PIPELINE
===================================================== */

ListUploadBatch.hasMany(ListUploadRecord, {
  foreignKey: "batchId",
  onDelete: "CASCADE",
});
ListUploadRecord.belongsTo(ListUploadBatch, {
  foreignKey: "batchId",
  as: "batch",
});

Campaign.belongsTo(ListUploadBatch, {
  foreignKey: "listBatchId",
  onDelete: "SET NULL",
});
ListUploadBatch.hasMany(Campaign, {
  foreignKey: "listBatchId",
});

/* =====================================================
   EMAIL VERIFICATION LINK
===================================================== */

CampaignRecipient.hasOne(GlobalEmailRegistry, {
  sourceKey: "email",
  foreignKey: "normalizedEmail",
  constraints: false,
});

GlobalEmailRegistry.belongsTo(CampaignRecipient, {
  targetKey: "email",
  foreignKey: "normalizedEmail",
  constraints: false,
});

ListUploadRecord.hasOne(GlobalEmailRegistry, {
  sourceKey: "normalizedEmail",
  foreignKey: "normalizedEmail",
  constraints: false,
});

GlobalEmailRegistry.belongsTo(ListUploadRecord, {
  targetKey: "normalizedEmail",
  foreignKey: "normalizedEmail",
  constraints: false,
});



Email.belongsTo(CampaignRecipient, {
  foreignKey: "recipientId",
  as: "recipient",
});
CampaignRecipient.hasMany(Email, { foreignKey: "recipientId", as: "emails" });

SmtpSender.hasOne(SenderHealth, {
  foreignKey: "mailboxId",
  onDelete: "CASCADE",
  constraints: false,
});

GmailSender.hasOne(SenderHealth, {
  foreignKey: "mailboxId",
  constraints: false,
});

OutlookSender.hasOne(SenderHealth, {
  foreignKey: "mailboxId",
  constraints: false,
});

/* =====================================================
   CRM & PIPELINE
===================================================== */

// User → CRM Stages
User.hasMany(CrmStage, { foreignKey: "userId", onDelete: "CASCADE" });
CrmStage.belongsTo(User, { foreignKey: "userId" });

// User → Leads
User.hasMany(Lead, { foreignKey: "userId", onDelete: "CASCADE" });
Lead.belongsTo(User, { foreignKey: "userId" });

// User → Integrations
User.hasMany(Integration, { foreignKey: "userId", onDelete: "CASCADE" });
Integration.belongsTo(User, { foreignKey: "userId" });

// Stage → Leads
CrmStage.hasMany(Lead, { foreignKey: "stageId", onDelete: "CASCADE" });
Lead.belongsTo(CrmStage, { foreignKey: "stageId" });

// Contact → Lead
ListUploadRecord.hasOne(Lead, { foreignKey: "contactId", onDelete: "CASCADE" });
Lead.belongsTo(ListUploadRecord, { foreignKey: "contactId", as: "contact" });

/* =====================================================
   MAILBOX SYNC ENGINE RELATIONSHIPS
===================================================== */

// Folders ↔ Messages
MailboxFolder.hasMany(MailboxMessage, {
  foreignKey: "folderId",
  onDelete: "CASCADE",
});
MailboxMessage.belongsTo(MailboxFolder, {
  foreignKey: "folderId",
});

// Senders ↔ Folders/Messages (Polymorphic)
const senderModels = [GmailSender, OutlookSender, SmtpSender];

senderModels.forEach((Model) => {
  Model.hasMany(MailboxFolder, {
    foreignKey: "senderId",
    constraints: false,
    as: "folders",
  });
  MailboxFolder.belongsTo(Model, {
    foreignKey: "senderId",
    constraints: false,
  });

  Model.hasMany(MailboxMessage, {
    foreignKey: "senderId",
    constraints: false,
    as: "mailboxMessages",
  });
  MailboxMessage.belongsTo(Model, {
    foreignKey: "senderId",
    constraints: false,
  });
});
/* =====================================================
   HELPER FUNCTIONS
===================================================== */

export async function getSenderWithType(senderId, senderType) {
  switch (senderType) {
    case "gmail":
      return await GmailSender.findByPk(senderId);
    case "outlook":
      return await OutlookSender.findByPk(senderId);
    case "smtp":
      return await SmtpSender.findByPk(senderId);
    default:
      throw new Error(`Unknown sender type: ${senderType}`);
  }
}

export async function getUserSenders(userId) {
  const [gmailSenders, outlookSenders, smtpSenders] = await Promise.all([
    GmailSender.findAll({ where: { userId } }),
    OutlookSender.findAll({ where: { userId } }),
    SmtpSender.findAll({ where: { userId } }),
  ]);

  return {
    gmail: gmailSenders,
    outlook: outlookSenders,
    smtp: smtpSenders,
    all: [...gmailSenders, ...outlookSenders, ...smtpSenders],
  };
}

/* =====================================================
   ELASTICSEARCH SYNC HOOKS
   Fire-and-forget: push a lightweight sync event to the ES_SYNC queue.
   The es-sync worker handles the actual indexing asynchronously.
===================================================== */




function publishEsSync(action, index, id, doc = null) {
  // Non-blocking — never throw into the model lifecycle
  getRabbitChannel()
    .then((ch) => {
      const payload = { action, index, id, doc };
      ch.sendToQueue(QUEUES.ES_SYNC, Buffer.from(JSON.stringify(payload)), { persistent: true });
    })
    .catch((err) => console.error("❌ ES sync publish failed:", err.message));
}

// ── MailboxMessage hooks ──────────────────────────────────────────────────────
MailboxMessage.addHook("afterCreate", "esSyncCreate", (instance) => {
  if (!instance.userId) return; // skip legacy rows without userId
  publishEsSync("upsert", INDICES.MESSAGES, instance.id, {
    id: instance.id,
    userId: instance.userId,
    senderId: instance.senderId,
    senderType: instance.senderType,
    folderId: instance.folderId,
    providerMessageId: instance.providerMessageId,
    providerThreadId: instance.providerThreadId,
    subject: instance.subject,
    from: instance.from,
    to: instance.to,
    snippet: instance.snippet,
    isRead: instance.isRead,
    hasAttachments: instance.hasAttachments,
    date: instance.date,
    createdAt: instance.createdAt,
  });
});

MailboxMessage.addHook("afterUpdate", "esSyncUpdate", (instance) => {
  if (!instance.userId) return; // skip legacy rows without userId
  publishEsSync("upsert", INDICES.MESSAGES, instance.id, {
    id: instance.id,
    userId: instance.userId,
    senderId: instance.senderId,
    senderType: instance.senderType,
    folderId: instance.folderId,
    providerMessageId: instance.providerMessageId,
    providerThreadId: instance.providerThreadId,
    subject: instance.subject,
    from: instance.from,
    to: instance.to,
    snippet: instance.snippet,
    isRead: instance.isRead,
    hasAttachments: instance.hasAttachments,
    date: instance.date,
    createdAt: instance.createdAt,
  });
});

MailboxMessage.addHook("afterDestroy", "esSyncDelete", (instance) => {
  publishEsSync("delete", INDICES.MESSAGES, instance.id);
});

// ── Email hooks (sent campaign emails) ───────────────────────────────────────
Email.addHook("afterUpdate", "esSyncEmailUpdate", (instance) => {
  // Only index once email is sent — avoids indexing drafts/queued records
  if (!["sent", "opened", "clicked", "replied"].includes(instance.status)) return;
  publishEsSync("upsert", INDICES.EMAILS, instance.id, {
    id: instance.id,
    userId: instance.userId,
    campaignId: instance.campaignId,
    senderId: instance.senderId,
    senderType: instance.senderType,
    recipientEmail: instance.recipientEmail,
    subject: instance.subject,
    textBody: instance.textBody,
    status: instance.status,
    sentAt: instance.sentAt,
    openedAt: instance.openedAt,
    clickedAt: instance.clickedAt,
    repliedAt: instance.repliedAt,
    createdAt: instance.createdAt,
  });
});

// ── ListUploadRecord hooks (Contacts / Audience) ──────────────────────────────
ListUploadRecord.addHook("afterCreate", "esSyncContactCreate", async (instance) => {
  const batch = await ListUploadBatch.findByPk(instance.batchId);
  if (!batch) return;
  upsertDocument(INDICES.CONTACTS, instance.id, {
    id: instance.id,
    userId: batch.userId,
    batchId: instance.batchId,
    rawEmail: instance.rawEmail,
    normalizedEmail: instance.normalizedEmail,
    domain: instance.domain,
    name: instance.name,
    status: instance.status,
    company: instance.metadata?.company || null,
    phone: instance.metadata?.phone || null,
    title: instance.metadata?.title || null,
    createdAt: instance.createdAt,
  });
});

ListUploadRecord.addHook("afterUpdate", "esSyncContactUpdate", async (instance) => {
  const batch = await ListUploadBatch.findByPk(instance.batchId);
  if (!batch) return;

  upsertDocument(INDICES.CONTACTS, instance.id, {
    id: instance.id,
    userId: batch.userId,
    batchId: instance.batchId,
    rawEmail: instance.rawEmail,
    normalizedEmail: instance.normalizedEmail,
    domain: instance.domain,
    name: instance.name,
    status: instance.status,
    company: instance.metadata?.company || null,
    phone: instance.metadata?.phone || null,
    title: instance.metadata?.title || null,
    createdAt: instance.createdAt,
  });
});

ListUploadRecord.addHook("afterDestroy", "esSyncContactDelete", (instance) => {
  deleteDocument(INDICES.CONTACTS, instance.id);
});

// ── Lead hooks ────────────────────────────────────────────────────────────────
Lead.addHook("afterCreate", "esSyncLeadCreate", (instance) => {
  upsertDocument(INDICES.LEADS, instance.id, {
    id: instance.id,
    userId: instance.userId,
    contactId: instance.contactId,
    stageId: instance.stageId,
    value: instance.value,
    // Denormalise contact fields from metadata (populated at lead creation in service layer)
    email: instance.metadata?.email || null,
    name: instance.metadata?.name || null,
    company: instance.metadata?.company || null,
    stageName: instance.metadata?.stageName || null,
    lastActivityAt: instance.lastActivityAt,
    createdAt: instance.createdAt,
  });
});

Lead.addHook("afterUpdate", "esSyncLeadUpdate", (instance) => {
  upsertDocument(INDICES.LEADS, instance.id, {
    id: instance.id,
    userId: instance.userId,
    contactId: instance.contactId,
    stageId: instance.stageId,
    value: instance.value,
    email: instance.metadata?.email || null,
    name: instance.metadata?.name || null,
    company: instance.metadata?.company || null,
    stageName: instance.metadata?.stageName || null,
    lastActivityAt: instance.lastActivityAt,
    createdAt: instance.createdAt,
  });
});

Lead.addHook("afterDestroy", "esSyncLeadDelete", (instance) => {
  deleteDocument(INDICES.LEADS, instance.id);
});

// ── Campaign hooks ────────────────────────────────────────────────────────────
Campaign.addHook("afterCreate", "esSyncCampaignCreate", (instance) => {
  upsertDocument(INDICES.CAMPAIGNS, instance.id, {
    id: instance.id,
    userId: instance.userId,
    name: instance.name,
    subject: instance.subject,
    textBody: instance.textBody,
    status: instance.status,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  });
});

Campaign.addHook("afterUpdate", "esSyncCampaignUpdate", (instance) => {
  upsertDocument(INDICES.CAMPAIGNS, instance.id, {
    id: instance.id,
    userId: instance.userId,
    name: instance.name,
    subject: instance.subject,
    textBody: instance.textBody,
    status: instance.status,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  });
});

Campaign.addHook("afterDestroy", "esSyncCampaignDelete", (instance) => {
  deleteDocument(INDICES.CAMPAIGNS, instance.id);
});

export {
  User,
  GmailSender,
  OutlookSender,
  SmtpSender,
  Campaign,
  CampaignStep,
  CampaignRecipient,
  CampaignSend,
  Email,
  EmailEvent,
  ReplyEvent,
  BounceEvent,
  ListUploadBatch,
  ListUploadRecord,
  GlobalEmailRegistry,
  SenderHealth,
  Notification,
  CrmStage,
  Lead,
  Integration,
  MailboxFolder,
  MailboxMessage,
  WarmupMessage,
};

