import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";

const Campaign = sequelize.define(
  "Campaign",
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

    senderId: {
      type: DataTypes.UUID,
      allowNull: false,
    },

    senderIds: {
      type: DataTypes.JSON,
      defaultValue: [],
    },

    isMultiSender: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    subject: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    htmlBody: {
      type: DataTypes.TEXT,
    },

    textBody: {
      type: DataTypes.TEXT,
    },
    listBatchId: {
      type: DataTypes.UUID,
      allowNull: true,
    },

    status: {
      type: DataTypes.ENUM(
        "draft",
        "scheduled",
        "running",
        "sending",
        "completed",
        "paused",
      ),
      allowNull: false,
      defaultValue: "draft",
    },

    scheduledAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    startedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    // 👇 ADD THESE TRACKING FIELDS
    trackOpens: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    trackClicks: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    unsubscribeLink: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },

    // Stats fields
    totalSent: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    totalReplied: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    totalOpens: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    totalClicks: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    totalBounces: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    // Alias used by email-sender worker (kept in sync with totalBounces)
    totalBounced: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    totalSenderBounced: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    totalUnsubscribed: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    totalPositiveReplied: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },

    completedAt: {
      type: DataTypes.DATE,
    },

    // Auto-pause: written when the campaign is paused automatically
    pauseReason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    // When false (default) risky-verified emails are allowed through.
    // Set to true to hard-block any email whose verification status = 'risky'.
    blockRiskyEmails: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    timezone: {
      type: DataTypes.STRING,
      defaultValue: "UTC",
    },
    maxFollowUps: {
      type: DataTypes.INTEGER,
      defaultValue: 3,
    },

    throttlePerMinute: {
      type: DataTypes.INTEGER,
      defaultValue: 20,
    },
    // Add senderType field
    senderType: {
      type: DataTypes.ENUM("gmail", "outlook", "smtp"),
      allowNull: false,
      defaultValue: "smtp",
    },

    // New Scheduling Fields
    sendingDays: {
      type: DataTypes.JSON,
      defaultValue: ["monday", "tuesday", "wednesday", "thursday", "friday"],
    },
    startTime: {
      type: DataTypes.STRING,
      defaultValue: "09:00",
    },
    endTime: {
      type: DataTypes.STRING,
      defaultValue: "18:00",
    },
    sendingInterval: {
      type: DataTypes.INTEGER,
      defaultValue: 20, // minutes
    },
    maxLeadsPerDay: {
      type: DataTypes.INTEGER,
      defaultValue: 100,
    },
    startDate: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    // Tracking for scalable distributed scheduler
    lastScheduledCheckAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "campaigns",
    timestamps: true,
    paranoid: true,
    indexes: [
      { fields: ["userId"] },
      { fields: ["senderId"] },
      { fields: ["status"] },
      { fields: ["scheduledAt"] },
      // Add composite index for sender lookup
      { fields: ["senderId", "senderType"] },
      { fields: ["lastScheduledCheckAt"] },
    ],
  },
);

export default Campaign;
