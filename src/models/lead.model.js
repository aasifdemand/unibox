import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";

const Lead = sequelize.define(
  "Lead",
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
    contactId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    stageId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    value: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0.0,
    },
    lastActivityAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    metadata: {
      type: DataTypes.JSONB,
      defaultValue: {},
    },
  },
  {
    tableName: "leads",
    timestamps: true,
    indexes: [
      { fields: ["userId"] },
      { fields: ["contactId"] },
      { fields: ["stageId"] },
      { unique: true, fields: ["userId", "contactId"] }, // One lead per contact per user
    ],
  }
);

export default Lead;
