import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";

const MailboxMessage = sequelize.define(
  "MailboxMessage",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: true, // nullable for backward compat with existing rows
    },
    senderId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    senderType: {
      type: DataTypes.ENUM("gmail", "outlook", "smtp"),
      allowNull: false,
    },
    folderId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    providerMessageId: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    providerThreadId: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    subject: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    from: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    to: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    date: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    snippet: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    isRead: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    hasAttachments: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    metadata: {
      type: DataTypes.JSONB,
      defaultValue: {},
    },
    size: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
  },
  {
    tableName: "mailbox_messages",
    timestamps: true,
    indexes: [
      {
        fields: ["senderId", "senderType", "providerMessageId"],
        unique: true,
      },
      {
        fields: ["senderId", "senderType", "folderId"],
      },
      {
        fields: ["date"],
      },
    ],
  }
);

export default MailboxMessage;
