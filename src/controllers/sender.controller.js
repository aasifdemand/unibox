import { asyncHandler } from "../helpers/async-handler.js";
import AppError from "../utils/app-error.js";


import GmailSender from "../models/gmail-sender.model.js";
import OutlookSender from "../models/outlook-sender.model.js";
import SmtpSender from "../models/smtp-sender.model.js";

import { testGmailConnection } from "../utils/gmail-tester.js";
import { testOutlookConnection } from "../utils/outlook-tester.js";

import { verifySmtp, verifyImap } from "../services/smtp-imap.service.js";
import { senderHealthService } from "../services/sender-health.service.js";
import { queueMailboxSync } from "../queues/mailbox.queue.js";


export const createSender = asyncHandler(async (req, res) => {
  const {
    email,
    displayName,

    /* SMTP */
    smtpHost,
    smtpPort = 587,
    smtpSecure = true,
    smtpUser,
    smtpPassword,

    /* IMAP */
    imapHost,
    imapPort = 993,
    imapSecure = true,
    imapUser,
    imapPassword,

    /* Optional */
    provider = "custom",
    dailyLimit = 500,
    hourlyLimit = 100,
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



  // Verify SMTP
  await verifySmtp({
    host: smtpHost,
    port: smtpPort,
    secure: smtpSecure,
    user: smtpUser,
    password: smtpPassword,
    proxy: null,
  });

  // Verify IMAP
  await verifyImap({
    host: imapHost,
    port: imapPort,
    secure: imapSecure,
    user: imapUser,
    password: imapPassword,
    proxy: null,
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
// LIST ALL SENDERS
// =========================

// =========================
export const listSenders = asyncHandler(async (req, res) => {
  try {
    const userId = req.user.id;

    const [smtpSenders, gmailSenders, outlookSenders] = await Promise.all([
      SmtpSender.findAll({
        where: { userId },
        attributes: { exclude: ["smtpPassword", "imapPassword"] },
        paranoid: false,
      }),
      GmailSender.findAll({
        where: { userId },
        attributes: {
          exclude: ["accessToken", "refreshToken", "googleProfile"],
        },
        paranoid: false,
      }),
      OutlookSender.findAll({
        where: { userId },
        attributes: { exclude: ["accessToken", "refreshToken"] },
        paranoid: false,
      }),
    ]);

    const allSenders = [
      ...smtpSenders.map((sender) => ({
        id: sender.id,
        type: "smtp", // ✅ Include type
        email: sender.email,
        displayName: sender.displayName,
        isVerified: sender.isVerified,
        createdAt: sender.createdAt,
        lastUsedAt: sender.lastUsedAt,
        smtpHost: sender.smtpHost,
        smtpPort: sender.smtpPort,
        domain: sender.domain,
        /* DKIM & Reputation */
        dkimEnabled: sender.dkimEnabled,
        dkimSelector: sender.dkimSelector,
        dkimPrivateKey: sender.dkimPrivateKey,
        sendingIp: sender.sendingIp,
      })),
      ...gmailSenders.map((sender) => ({
        id: sender.id,
        type: "gmail", // ✅ Include type
        email: sender.email,
        displayName: sender.displayName,
        isVerified: sender.isVerified,
        createdAt: sender.createdAt,
        lastUsedAt: sender.lastUsedAt,
        googleId: sender.googleId,
        domain: sender.domain,
        expiresAt: sender.expiresAt,
        picture: sender.picture,
      })),
      ...outlookSenders.map((sender) => ({
        id: sender.id,
        type: "outlook", // ✅ Include type
        email: sender.email,
        displayName: sender.displayName,
        isVerified: sender.isVerified,
        createdAt: sender.createdAt,
        lastUsedAt: sender.lastUsedAt,
        microsoftId: sender.microsoftId,
        domain: sender.domain,
        expiresAt: sender.expiresAt,
      })),
    ];

    allSenders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const totalCount = allSenders.length;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const paginatedSenders = allSenders.slice(offset, offset + limit);

    res.json({
      success: true,
      data: paginatedSenders,
      count: paginatedSenders.length,
      pagination: {
        total: totalCount,
        page,
        limit,
        pages: Math.ceil(totalCount / limit),
      },
      countsByType: {
        smtp: smtpSenders.length,
        gmail: gmailSenders.length,
        outlook: outlookSenders.length,
      },
    });
  } catch (error) {
    console.error("Error listing senders:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch senders",
      error: error.message,
    });
  }
});
// =========================
// BULK DELETE SENDERS
// =========================
export const bulkDeleteSenders = asyncHandler(async (req, res) => {
  const { senderIds } = req.body; // Array of { id, type }
  const userId = req.user.id;

  if (!senderIds || !Array.isArray(senderIds)) {
    throw new AppError("senderIds array is required", 400);
  }

  const results = {
    success: 0,
    failed: 0,
    errors: [],
  };

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
        results.errors.push(`Sender ${id} of type ${type} not found`);
      }
    } catch (err) {
      results.failed++;
      results.errors.push(`Failed to delete ${id}: ${err.message}`);
    }
  }

  res.json({
    success: true,
    message: `Batch delete complete. ${results.success} deleted, ${results.failed} failed.`,
    data: results,
  });
});

// =========================
// DELETE SENDER - FORCE DELETE
// =========================
export const deleteSender = asyncHandler(async (req, res) => {
  const { senderId } = req.params;
  const { type } = req.query;
  const userId = req.user.id;

  let deleted = false;
  let deletedType = null;

  if (type === "outlook") {
    // 🔴 Find including soft-deleted
    const sender = await OutlookSender.findOne({
      where: {
        id: senderId,
        userId,
      },
      paranoid: false,
    });

    if (sender) {
      // 🔴 FORCE DELETE - completely remove from database
      await sender.destroy({ force: true });
      deleted = true;
      deletedType = "outlook";
      console.log(`✅ Outlook sender permanently deleted: ${sender.email}`);
    }
  }

  if (!deleted) {
    throw new AppError("Sender not found", 404);
  }

  res.json({
    success: true,
    message: `${deletedType} sender deleted successfully`,
  });
});
// =========================
// TEST SENDER CONNECTION
// =========================
export const testSender = asyncHandler(async (req, res) => {
  const { senderId } = req.params;
  const userId = req.user.id;

  // Try to find sender in each model
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

  // Test based on sender type
  if (gmailSender) {
    try {
      testResult = await testGmailConnection({
        accessToken: sender.accessToken,
        email: sender.email,
      });
      await gmailSender.update({
        isVerified: true,
        lastTestedAt: new Date(),
      });
    } catch (err) {
      testResult = { success: false, error: err.message };
      await gmailSender.update({
        isVerified: false,
        verificationError: err.message,
        lastTestedAt: new Date(),
      });
    }
  } else if (outlookSender) {
    try {
      testResult = await testOutlookConnection({
        accessToken: sender.accessToken,
        email: sender.email,
      });
      await outlookSender.update({
        isVerified: true,
        lastTestedAt: new Date(),
      });
    } catch (err) {
      testResult = { success: false, error: err.message };
      await outlookSender.update({
        isVerified: false,
        verificationError: err.message,
        lastTestedAt: new Date(),
      });
    }
  } else if (smtpSender) {
    try {
      // Test SMTP
      const smtpTest = await testSmtpConnection({
        smtpHost: sender.smtpHost,
        smtpPort: sender.smtpPort,
        smtpSecure: sender.smtpSecure,
        smtpUser: sender.smtpUsername,
        smtpPass: sender.smtpPassword,
      });

      // Test IMAP if configured
      let imapTest = null;
      if (sender.imapHost && sender.imapUsername && sender.imapPassword) {
        imapTest = await testImapConnection({
          imapHost: sender.imapHost,
          imapPort: sender.imapPort,
          imapSecure: sender.imapSecure,
          imapUser: sender.imapUsername,
          imapPass: sender.imapPassword,
        });
      }

      testResult = {
        success: true,
        smtp: smtpTest,
        imap: imapTest,
      };

      await smtpSender.update({
        isVerified: true,
        smtpTestResult: smtpTest,
        imapTestResult: imapTest,
        lastTestedAt: new Date(),
        verificationError: null,
      });
    } catch (err) {
      testResult = { success: false, error: err.message };
      await smtpSender.update({
        isVerified: false,
        verificationError: err.message,
        lastTestedAt: new Date(),
      });
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

  // Only applicable to OAuth senders
  const [gmailSender, outlookSender] = await Promise.all([
    GmailSender.findOne({ where: { id: senderId, userId } }),
    OutlookSender.findOne({ where: { id: senderId, userId } }),
  ]);

  const sender = gmailSender || outlookSender;
  if (!sender) {
    throw new AppError("OAuth sender not found", 404);
  }

  // In a real implementation, you would call Google/Microsoft API
  // to refresh the token using the refresh token
  // This is a simplified version
  res.json({
    success: true,
    message: "Token refresh initiated",
    data: {
      senderId,
      type: gmailSender ? "gmail" : "outlook",
      refreshed: true,
    },
  });
});

// =========================
// REVOKE OAUTH ACCESS
// =========================
export const revokeSenderAccess = asyncHandler(async (req, res) => {
  const { senderId } = req.params;
  const userId = req.user.id;

  // Only applicable to OAuth senders
  const [gmailSender, outlookSender] = await Promise.all([
    GmailSender.findOne({ where: { id: senderId, userId } }),
    OutlookSender.findOne({ where: { id: senderId, userId } }),
  ]);

  const sender = gmailSender || outlookSender;
  if (!sender) {
    throw new AppError("OAuth sender not found", 404);
  }

  // In a real implementation, you would call Google/Microsoft API
  // to revoke the token
  // For now, just mark as not verified
  await sender.update({
    isVerified: false,
    accessToken: null,
    refreshToken: null,
    expiresAt: null,
  });

  res.json({
    success: true,
    message: "Access revoked successfully",
    data: {
      senderId,
      type: gmailSender ? "gmail" : "outlook",
      revoked: true,
    },
  });
});

// =========================
// UPDATE SMTP SENDER
// =========================
export const updateSender = asyncHandler(async (req, res) => {
  const { senderId } = req.params;
  const userId = req.user.id;
  const updateData = req.body;

  // Only SMTP senders can be updated via API
  const smtpSender = await SmtpSender.findOne({
    where: {
      id: senderId,
      userId: userId,
    },
  });

  if (!smtpSender) {
    throw new AppError("SMTP sender not found", 404);
  }

  // Don't allow changing email
  if (updateData.email && updateData.email !== smtpSender.email) {
    throw new AppError("Email cannot be changed", 400);
  }

  // If updating SMTP credentials, test connection
  if (updateData.smtpPassword || updateData.smtpHost || updateData.smtpPort) {
    try {
      await testSmtpConnection({
        smtpHost: updateData.smtpHost || smtpSender.smtpHost,
        smtpPort: updateData.smtpPort || smtpSender.smtpPort,
        smtpSecure:
          updateData.smtpSecure !== undefined
            ? updateData.smtpSecure
            : smtpSender.smtpSecure,
        smtpUser: updateData.smtpUser || smtpSender.smtpUsername,
        smtpPass: updateData.smtpPassword || smtpSender.smtpPassword,
      });
    } catch (err) {
      throw new AppError(`SMTP connection failed: ${err.message}`, 400);
    }
  }

  // Update sender
  await smtpSender.update(updateData);

  res.json({
    success: true,
    data: {
      ...smtpSender.toJSON(),
      type: "smtp",
    },
  });
});

// =========================
// GET SINGLE SENDER
// =========================
// =========================
// GET SINGLE SENDER - IMPROVED
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
  if (!sender) {
    throw new AppError("Sender not found", 404);
  }

  let type;
  let senderData;

  if (gmailSender) {
    type = "gmail";
    senderData = gmailSender.toJSON();
    delete senderData.accessToken;
    delete senderData.refreshToken;
    delete senderData.googleProfile;
  } else if (outlookSender) {
    type = "outlook";
    senderData = outlookSender.toJSON();
    delete senderData.accessToken;
    delete senderData.refreshToken;
  } else {
    type = "smtp";
    senderData = smtpSender.toJSON();
    delete senderData.smtpPassword;
    delete senderData.imapPassword;
  }

  res.json({
    success: true,
    data: {
      ...senderData,
      type,
    },
  });
});

// =========================
// TEST SMTP CONNECTION ONLY
// =========================
export const testSmtpConnection = asyncHandler(async (req, res) => {
  const { host, port, secure, user, password } = req.body || {};

  if (!host || !port || !user || !password) {
    throw new AppError("Missing required SMTP fields", 400);
  }

  await verifySmtp({ host, port, secure, user, password });

  res.json({
    success: true,
    message: "SMTP connection successful",
  });
});

// =========================
// TEST IMAP CONNECTION ONLY
// =========================
export const testImapConnection = asyncHandler(async (req, res) => {
  const { host, port, secure, user, password } = req.body || {};

  if (!host || !port || !user || !password) {
    throw new AppError("Missing required IMAP fields", 400);
  }

  await verifyImap({ host, port, secure, user, password });

  res.json({
    success: true,
    message: "IMAP connection successful",
  });
});
