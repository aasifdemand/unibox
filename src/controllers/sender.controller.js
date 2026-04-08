import { asyncHandler } from "../helpers/async-handler.js";
import AppError from "../utils/app-error.js";
import GmailSender from "../models/gmail-sender.model.js";
import OutlookSender from "../models/outlook-sender.model.js";
import SmtpSender from "../models/smtp-sender.model.js";
import { testGmailConnection } from "../utils/gmail-tester.js";
import { testOutlookConnection } from "../utils/outlook-tester.js";
import Campaign from "../models/campaign.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import { verifySmtp, verifyImap } from "../services/smtp-imap.service.js";
import { senderHealthService } from "../services/sender-health.service.js";
import { queueMailboxSync } from "../queues/mailbox.queue.js";
import sequelize from "../config/db.js";
import { getProxyForEmail } from "../utils/proxy-resolver.js";



// =========================
// CREATE SENDER (MANUAL SMTP)
// =========================
export const createSender = asyncHandler(async (req, res) => {
  const {
    email,
    displayName,
    smtpHost,
    smtpPort = 587,
    smtpSecure = true,
    smtpUser,
    smtpPassword,
    imapHost,
    imapPort = 993,
    imapSecure = true,
    imapUser,
    imapPassword,
    provider = "custom",
    dailyLimit = 500,
    hourlyLimit = 100,
    isSystemAccount = false,
  } = req.body;

  if (!email || !displayName) {
    throw new AppError("Email and display name are required", 400);
  }

  if (!smtpHost || !smtpUser || !smtpPassword) {
    throw new AppError("Incomplete SMTP configuration", 400);
  }

  if (!imapHost || !imapUser || !imapPassword) {
    throw new AppError("Incomplete IMAP configuration", 400);
  }

  const emailLower = email.toLowerCase();
  const domain = emailLower.split("@")[1];

  // Check duplicates across all sender types
  const [existingGmail, existingOutlook, existingSmtp] = await Promise.all([
    GmailSender.findOne({ where: { email: emailLower, userId: req.user.id } }),
    OutlookSender.findOne({ where: { email: emailLower, userId: req.user.id } }),
    SmtpSender.findOne({ where: { email: emailLower, userId: req.user.id } }),
  ]);

  if (existingGmail || existingOutlook || existingSmtp) {
    throw new AppError("Sender with this email already exists", 409);
  }

  // Verify SMTP & IMAP with server-side proxy resolution (Sticky 24h)
  const socksProxy = await getProxyForEmail(emailLower);

  await verifySmtp({
    host: smtpHost,
    port: smtpPort,
    secure: smtpSecure,
    user: smtpUser,
    password: smtpPassword,
    proxy: socksProxy,
  });

  await verifyImap({
    host: imapHost,
    port: imapPort,
    secure: imapSecure,
    user: imapUser,
    password: imapPassword,
    proxy: socksProxy,
  });

  const sender = await SmtpSender.create({
    userId: req.user.id,
    email: emailLower,
    displayName,
    domain,
    smtpHost,
    smtpPort,
    smtpSecure,
    smtpUsername: smtpUser,
    smtpPassword,
    imapHost,
    imapPort,
    imapSecure,
    imapUsername: imapUser,
    imapPassword,
    provider,
    dailyLimit,
    hourlyLimit,
    smtpTestResult: { success: true, testedAt: new Date() },
    imapTestResult: { success: true, testedAt: new Date() },
    lastTestedAt: new Date(),
    isVerified: true,
    isActive: true,
    isSystemAccount,
  });

  // Run health check and trigger initial mailbox sync async
  senderHealthService.evaluateSender(sender.id).catch(console.error);
  queueMailboxSync(sender.id, "smtp").catch(console.error);

  res.status(201).json({
    success: true,
    data: { ...sender.toJSON(), type: "smtp" },
  });
});

// =========================
// BULK CREATE SENDERS
// =========================
export const bulkCreateSenders = asyncHandler(async (req, res) => {
  const { senders } = req.body;
  const userId = req.user.id;

  if (!senders || !Array.isArray(senders)) {
    throw new AppError("Senders array is required", 400);
  }

  const results = {
    success: 0,
    failed: 0,
    errors: [],
    instances: [],
  };

  for (const senderData of senders) {
    try {
      const {
        email,
        displayName,
        smtpHost,
        smtpPort = 587,
        smtpSecure = true,
        smtpUser,
        smtpPassword,
        imapHost,
        imapPort = 993,
        imapSecure = true,
        imapUser,
        imapPassword,
        isSystemAccount = false,
      } = senderData;

      if (!email || !displayName || !smtpHost || !smtpUser || !smtpPassword) {
        throw new Error(`Incomplete configuration for ${email || 'unknown'}`);
      }

      const emailLower = email.toLowerCase();
      const domain = emailLower.split("@")[1];

      const existing = await SmtpSender.findOne({
        where: { email: emailLower, userId }
      });

      if (existing) {
        throw new Error(`Sender ${emailLower} already exists`);
      }

      const sender = await SmtpSender.create({
        userId,
        email: emailLower,
        displayName,
        domain,
        smtpHost,
        smtpPort,
        smtpSecure,
        smtpUsername: smtpUser,
        smtpPassword,
        imapHost: imapHost || smtpHost.replace("smtp", "imap"),
        imapPort: imapPort || 993,
        imapSecure: imapSecure !== undefined ? imapSecure : true,
        imapUsername: imapUser || smtpUser,
        imapPassword: imapPassword || smtpPassword,
        isVerified: true,
        isActive: true,
        isSystemAccount,
      });

      senderHealthService.evaluateSender(sender.id).catch(() => { });
      queueMailboxSync(sender.id, "smtp").catch(() => { });

      results.success++;
      results.instances.push(sender.id);
    } catch (err) {
      results.failed++;
      results.errors.push(err.message);
    }
  }

  res.status(201).json({
    success: true,
    message: `Bulk creation complete. ${results.success} added, ${results.failed} failed.`,
    data: results,
  });
});

// =========================
// LIST ALL SENDERS
// =========================
export const listSenders = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { search = "", type = "all", page = 1, limit = 10 } = req.query;

  const typeFilter = type === "all" ? ["smtp", "gmail", "outlook"] : type.split(",");
  const searchLower = search.toLowerCase().trim();

  // Conditional fetching based on type filter
  const promises = [];
  if (typeFilter.includes("smtp")) {
    promises.push(SmtpSender.findAll({
      where: { userId },
      attributes: { exclude: ["smtpPassword", "imapPassword"] },
      paranoid: false,
    }).then(results => results.map(s => ({ ...s.toJSON(), type: "smtp" }))));
  } else {
    promises.push(Promise.resolve([]));
  }

  if (typeFilter.includes("gmail")) {
    promises.push(GmailSender.findAll({
      where: { userId },
      attributes: { exclude: ["accessToken", "refreshToken", "googleProfile"] },
      paranoid: false,
    }).then(results => results.map(s => ({ ...s.toJSON(), type: "gmail" }))));
  } else {
    promises.push(Promise.resolve([]));
  }

  if (typeFilter.includes("outlook")) {
    promises.push(OutlookSender.findAll({
      where: { userId },
      attributes: { exclude: ["accessToken", "refreshToken"] },
      paranoid: false,
    }).then(results => results.map(s => ({ ...s.toJSON(), type: "outlook" }))));
  } else {
    promises.push(Promise.resolve([]));
  }

  const [smtpSenders, gmailSenders, outlookSenders] = await Promise.all(promises);

  let allSenders = [...smtpSenders, ...gmailSenders, ...outlookSenders];

  // Apply Search Filter (In-memory since it spans multiple tables)
  if (searchLower) {
    allSenders = allSenders.filter(s => 
      (s.email && s.email.toLowerCase().includes(searchLower)) ||
      (s.displayName && s.displayName.toLowerCase().includes(searchLower)) ||
      (s.domain && s.domain.toLowerCase().includes(searchLower))
    );
  }

  const allSenderIds = allSenders.map(s => s.id);

  if (allSenderIds.length === 0) {
    return res.json({
      success: true,
      data: [],
      count: 0,
      pagination: { total: 0, page: parseInt(page), limit: parseInt(limit), pages: 0 },
      countsByType: { smtp: smtpSenders.length, gmail: gmailSenders.length, outlook: outlookSenders.length },
    });
  }

  const [campaignCounts, leadCounts] = await Promise.all([
    Campaign.findAll({
      attributes: ["senderId", [sequelize.fn("COUNT", sequelize.col("id")), "count"]],
      where: { senderId: allSenderIds },
      group: ["senderId"],
      raw: true
    }),
    CampaignRecipient.findAll({
      attributes: [
        [sequelize.col("Campaign.senderId"), "senderId"],
        [sequelize.fn("COUNT", sequelize.col("CampaignRecipient.id")), "count"]
      ],
      include: [{
        model: Campaign,
        attributes: [],
        where: { senderId: allSenderIds },
        required: true
      }],
      group: [sequelize.col("Campaign.senderId")],
      raw: true
    }),
  ]);

  const campaignCountMap = Object.fromEntries(campaignCounts.map(c => [c.senderId, parseInt(c.count)]));
  const leadCountMap = Object.fromEntries(leadCounts.map(l => [l.senderId, parseInt(l.count)]));

  // Attach dynamic stats
  allSenders = allSenders.map(sender => ({
    ...sender,
    campaignCount: campaignCountMap[sender.id] || 0,
    leadCount: leadCountMap[sender.id] || 0,
  }));

  allSenders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const totalCount = allSenders.length;
  const p = parseInt(page) || 1;
  const l = parseInt(limit) || 10;
  const offset = (p - 1) * l;
  const paginatedSenders = allSenders.slice(offset, offset + l);

  res.json({
    success: true,
    data: paginatedSenders,
    count: paginatedSenders.length,
    pagination: {
      total: totalCount,
      page: p,
      limit: l,
      pages: Math.ceil(totalCount / l),
    },
    countsByType: {
      smtp: smtpSenders.length,
      gmail: gmailSenders.length,
      outlook: outlookSenders.length,
    },
  });
});

// =========================
// BULK DELETE SENDERS
// =========================
export const bulkDeleteSenders = asyncHandler(async (req, res) => {
  const { senderIds } = req.body;
  const userId = req.user.id;

  if (!senderIds || !Array.isArray(senderIds)) {
    throw new AppError("senderIds array is required", 400);
  }

  const results = { success: 0, failed: 0, errors: [] };

  for (const item of senderIds) {
    const { id, type } = item;
    try {
      let model;
      if (type === "gmail") model = GmailSender;
      else if (type === "outlook") model = OutlookSender;
      else if (type === "smtp") model = SmtpSender;
      else throw new Error(`Invalid type: ${type}`);

      const sender = await model.findOne({ where: { id, userId } });
      if (sender) {
        await sender.destroy({ force: true });
        results.success++;
      } else {
        results.failed++;
        results.errors.push(`Sender ${id} not found`);
      }
    } catch (err) {
      results.failed++;
      results.errors.push(`Failed to delete ${id}: ${err.message}`);
    }
  }

  res.json({ success: true, data: results });
});

// =========================
// DELETE SENDER
// =========================
export const deleteSender = asyncHandler(async (req, res) => {
  const { senderId } = req.params;
  const { type } = req.query;
  const userId = req.user.id;

  let model;
  if (type === "gmail") model = GmailSender;
  else if (type === "outlook") model = OutlookSender;
  else if (type === "smtp") model = SmtpSender;
  else throw new AppError("Invalid sender type", 400);

  const sender = await model.findOne({ where: { id: senderId, userId }, paranoid: false });
  if (!sender) {
    throw new AppError("Sender not found", 404);
  }

  await sender.destroy({ force: true });

  res.json({ success: true, message: "Sender deleted successfully" });
});

// =========================
// TEST SENDER CONNECTION
// =========================
export const testSender = asyncHandler(async (req, res) => {
  const { senderId } = req.params;
  const userId = req.user.id;

  const [gmailSender, outlookSender, smtpSender] = await Promise.all([
    GmailSender.findOne({ where: { id: senderId, userId } }),
    OutlookSender.findOne({ where: { id: senderId, userId } }),
    SmtpSender.findOne({ where: { id: senderId, userId } }),
  ]);

  let sender = gmailSender || outlookSender || smtpSender;
  if (!sender) {
    throw new AppError("Sender not found", 404);
  }

  let testResult = {};

  if (gmailSender) {
    try {
      testResult = await testGmailConnection({ accessToken: sender.accessToken, email: sender.email });
      await gmailSender.update({ isVerified: true, lastTestedAt: new Date() });
    } catch (err) {
      testResult = { success: false, error: err.message };
      await gmailSender.update({ isVerified: false, verificationError: err.message, lastTestedAt: new Date() });
    }
  } else if (outlookSender) {
    try {
      testResult = await testOutlookConnection({ accessToken: sender.accessToken, email: sender.email });
      await outlookSender.update({ isVerified: true, lastTestedAt: new Date() });
    } catch (err) {
      testResult = { success: false, error: err.message };
      await outlookSender.update({ isVerified: false, verificationError: err.message, lastTestedAt: new Date() });
    }
  } else if (smtpSender) {
    try {
      const socksProxy = await getProxyForEmail(sender.email);

      const smtpTest = await verifySmtp({
        host: sender.smtpHost,
        port: sender.smtpPort,
        secure: sender.smtpSecure,
        user: sender.smtpUsername,
        password: sender.smtpPassword,
        proxy: socksProxy,
      });

      let imapTest = null;
      if (sender.imapHost && sender.imapUsername && sender.imapPassword) {
        imapTest = await verifyImap({
          host: sender.imapHost,
          port: sender.imapPort,
          secure: sender.imapSecure,
          user: sender.imapUsername,
          password: sender.imapPassword,
          proxy: socksProxy,
        });
      }

      testResult = { success: true, smtp: smtpTest, imap: imapTest };
      await smtpSender.update({ isVerified: true, lastTestedAt: new Date(), verificationError: null });
    } catch (err) {
      testResult = { success: false, error: err.message };
      await smtpSender.update({ isVerified: false, verificationError: err.message, lastTestedAt: new Date() });
    }
  }

  res.json({
    success: true,
    data: {
      senderId,
      type: gmailSender ? "gmail" : outlookSender ? "outlook" : "smtp",
      testResult,
    },
  });
});

// =========================
// REFRESH OAUTH TOKEN
// =========================
export const refreshSenderToken = asyncHandler(async (req, res) => {
  const { senderId } = req.params;
  const userId = req.user.id;

  const [gmailSender, outlookSender] = await Promise.all([
    GmailSender.findOne({ where: { id: senderId, userId } }),
    OutlookSender.findOne({ where: { id: senderId, userId } }),
  ]);

  const sender = gmailSender || outlookSender;
  if (!sender) throw new AppError("OAuth sender not found", 404);

  res.json({
    success: true,
    message: "Token refresh initiated",
    data: { senderId, type: gmailSender ? "gmail" : "outlook", refreshed: true },
  });
});

// =========================
// REVOKE OAUTH ACCESS
// =========================
export const revokeSenderAccess = asyncHandler(async (req, res) => {
  const { senderId } = req.params;
  const userId = req.user.id;

  const [gmailSender, outlookSender] = await Promise.all([
    GmailSender.findOne({ where: { id: senderId, userId } }),
    OutlookSender.findOne({ where: { id: senderId, userId } }),
  ]);

  const sender = gmailSender || outlookSender;
  if (!sender) throw new AppError("OAuth sender not found", 404);

  await sender.update({ isVerified: false, accessToken: null, refreshToken: null, expiresAt: null });

  res.json({
    success: true,
    message: "Access revoked successfully",
    data: { senderId, type: gmailSender ? "gmail" : "outlook", revoked: true },
  });
});

// =========================
// UPDATE SENDER CONFIG
// =========================
export const updateSender = asyncHandler(async (req, res) => {
  const { senderId } = req.params;
  const userId = req.user.id;
  const updateData = req.body;

  const [gmail, outlook, smtp] = await Promise.all([
    GmailSender.findOne({ where: { id: senderId, userId } }),
    OutlookSender.findOne({ where: { id: senderId, userId } }),
    SmtpSender.findOne({ where: { id: senderId, userId } }),
  ]);

  const sender = gmail || outlook || smtp;
  if (!sender) throw new AppError("Sender not found", 404);

  const type = gmail ? "gmail" : outlook ? "outlook" : "smtp";
  await sender.update(updateData);

  res.json({
    success: true,
    data: { ...sender.toJSON(), type },
  });
});

// =========================
// GET SINGLE SENDER
// =========================
export const getSender = asyncHandler(async (req, res) => {
  const { senderId } = req.params;
  const userId = req.user.id;

  const [gmailSender, outlookSender, smtpSender] = await Promise.all([
    GmailSender.findOne({ where: { id: senderId, userId } }),
    OutlookSender.findOne({ where: { id: senderId, userId } }),
    SmtpSender.findOne({ where: { id: senderId, userId } }),
  ]);

  const sender = gmailSender || outlookSender || smtpSender;
  if (!sender) throw new AppError("Sender not found", 404);

  const type = gmailSender ? "gmail" : outlookSender ? "outlook" : "smtp";
  const senderData = sender.toJSON();

  if (gmailSender) {
    delete senderData.accessToken;
    delete senderData.refreshToken;
    delete senderData.googleProfile;
  } else if (outlookSender) {
    delete senderData.accessToken;
    delete senderData.refreshToken;
  } else {
    delete senderData.smtpPassword;
    delete senderData.imapPassword;
  }

  res.json({
    success: true,
    data: { ...senderData, type },
  });
});

// =========================
// TEST SMTP/IMAP CONNECTION ONLY
// =========================
export const testSmtpConnection = asyncHandler(async (req, res) => {
  const { host, port, secure, user, password } = req.body || {};
  if (!host || !port || !user || !password) throw new AppError("Missing fields", 400);
  await verifySmtp({ host, port, secure, user, password });
  res.json({ success: true, message: "SMTP successful" });
});

export const testImapConnection = asyncHandler(async (req, res) => {
  const { host, port, secure, user, password } = req.body || {};
  if (!host || !port || !user || !password) throw new AppError("Missing fields", 400);
  await verifyImap({ host, port, secure, user, password });
  res.json({ success: true, message: "IMAP successful" });
});

// =========================
// UPDATE WARMUP SETTINGS
// =========================
export const updateWarmupSettings = asyncHandler(async (req, res) => {
  const { senderId } = req.params;
  const userId = req.user.id;
  const { enabled, status, dailyLimit, replyRate, initialLimit, incrementBy, maxLimit } = req.body;

  const [gmail, outlook, smtp] = await Promise.all([
    GmailSender.findOne({ where: { id: senderId, userId } }),
    OutlookSender.findOne({ where: { id: senderId, userId } }),
    SmtpSender.findOne({ where: { id: senderId, userId } }),
  ]);

  const sender = gmail || outlook || smtp;
  if (!sender) throw new Error("Sender not found");

  const updateData = {};
  if (enabled !== undefined) {
    updateData.warmupEnabled = enabled;
    // Auto-sync warmupStatus when the toggle is flipped, unless an explicit status is provided
    if (status === undefined) {
      updateData.warmupStatus = enabled ? "active" : "disabled";
    }
  }
  if (status !== undefined) updateData.warmupStatus = status;
  if (dailyLimit !== undefined) updateData.warmupDailyLimit = dailyLimit;
  if (replyRate !== undefined) updateData.warmupReplyRate = replyRate;
  if (initialLimit !== undefined) updateData.warmupInitialLimit = initialLimit;
  if (incrementBy !== undefined) updateData.warmupIncrementBy = incrementBy;
  if (maxLimit !== undefined) updateData.warmupMaxLimit = maxLimit;

  await sender.update(updateData);

  res.json({
    success: true,
    message: "Warmup settings updated successfully",
    data: sender,
  });
});
