import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";

const WarmupMessage = sequelize.define(
  "WarmupMessage",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    senderId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    senderEmail: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    recipientId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    recipientEmail: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    subject: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    body: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    providerMessageId: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    providerThreadId: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    status: {
      type: DataTypes.STRING,
      defaultValue: "sent", // sent | rescued | read | replied
    },
    sentAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    lastActionAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "warmup_messages",
    timestamps: true,
  }
);

export default WarmupMessage;
