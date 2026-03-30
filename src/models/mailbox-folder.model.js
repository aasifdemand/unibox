import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";

const MailboxFolder = sequelize.define(
  "MailboxFolder",
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
    senderType: {
      type: DataTypes.ENUM("gmail", "outlook", "smtp"),
      allowNull: false,
    },
    providerFolderId: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    folderType: {
      type: DataTypes.STRING, // inbox, sent, trash, etc.
      allowNull: true,
    },
    unreadCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    totalCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    lastSyncAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "mailbox_folders",
    timestamps: true,
    indexes: [
      {
        fields: ["senderId", "senderType", "providerFolderId"],
        unique: true,
      },
    ],
  }
);

export default MailboxFolder;
