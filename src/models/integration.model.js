import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";

const Integration = sequelize.define(
  "Integration",
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
    service: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: "e.g., hubspot, salesforce, apollo",
    },
    type: {
      type: DataTypes.ENUM("crm", "data", "outreach"),
      allowNull: false,
    },
    authType: {
      type: DataTypes.ENUM("oauth", "api_key"),
      allowNull: false,
    },
    credentials: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
      comment: "Stores encrypted tokens or API keys",
    },
    status: {
      type: DataTypes.ENUM("connected", "disconnected"),
      defaultValue: "connected",
      allowNull: false,
    },
    lastSyncAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "integrations",
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ["userId", "service"],
      },
    ],
  }
);

export default Integration;
