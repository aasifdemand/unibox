import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";

const OutlookSender = sequelize.define(
  "OutlookSender",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    userId: {
      type: DataTypes.UUID,
      allowNull: false,
    },

    email: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: false,
      validate: {
        isEmail: true,
      },
    },

    displayName: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    domain: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    /* =========================
       MICROSOFT OAUTH TOKENS
    ========================= */
    microsoftId: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    tenantId: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    accessToken: {
      type: DataTypes.TEXT,
      allowNull: false,
    },

    refreshToken: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },

    /* =========================
       MICROSOFT API SCOPES
    ========================= */
    scopes: {
      type: DataTypes.JSON,
      defaultValue: ["User.Read", "Mail.Send", "Mail.Read"],
    },

    /* =========================
       STATE & METADATA
    ========================= */
    isVerified: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },

    lastUsedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    lastInboxSyncAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    lastSentSyncAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    lastDraftsSyncAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    dailySentCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },

    dailySentResetAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },

    /* =========================
       MICROSOFT SPECIFIC FIELDS
    ========================= */
    microsoftProfile: {
      type: DataTypes.JSON,
      allowNull: true,
    },

    jobTitle: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    companyName: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    // Add to GmailSender, OutlookSender, and SmtpSender models
    lastReplyCheckAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    /* =========================
       ACTIVE WARMUP SETTINGS
    ========================= */
    warmupEnabled: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    warmupStatus: {
      type: DataTypes.ENUM("active", "paused", "disabled"),
      defaultValue: "disabled",
    },

    warmupDailyLimit: {
      type: DataTypes.INTEGER,
      defaultValue: 20,
    },

    warmupCurrentSent: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },

    warmupReplyRate: {
      type: DataTypes.FLOAT,
      defaultValue: 0.3,
    },

    warmupDaysActive: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },

    warmupInitialLimit: {
      type: DataTypes.INTEGER,
      defaultValue: 2,
    },

    warmupIncrementBy: {
      type: DataTypes.INTEGER,
      defaultValue: 2,
    },

    warmupMaxLimit: {
      type: DataTypes.INTEGER,
      defaultValue: 50,
    },

    isSystemAccount: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    warmupLastResetDate: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: "Last date (YYYY-MM-DD) the daily count was reset in user timezone",
    },

    lastWarmupCheckAt: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: "Last time this mailbox was processed by the warmup worker",
    },

    lastWarmupRescueAt: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: "Last time this mailbox was processed by the warmup monitor worker",
    },

    // Tracking for scalable distributed sync
    lastSyncCheckAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    /* =========================
       CONFIGURATION & REFRESH
    ========================= */
    minTimeGap: {
      type: DataTypes.INTEGER,
      defaultValue: 1,
    },

    signature: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    bccEmail: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    replyToAddress: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    useCustomTrackingDomain: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    customTrackingDomain: {
      type: DataTypes.STRING,
      allowNull: true,
    },
  },
  {
    tableName: "outlook_senders",
    timestamps: true,
    paranoid: true,
    indexes: [
      { unique: true, fields: ["email", "userId"] },
      { fields: ["userId"] },
      { fields: ["microsoftId"] },
      { fields: ["isVerified"] },
      { fields: ["lastSyncCheckAt"] },
    ],
  },
);

export default OutlookSender;
