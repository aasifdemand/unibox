import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";

const CrmStage = sequelize.define(
  "CrmStage",
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
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    color: {
      type: DataTypes.STRING,
      defaultValue: "#64748b", // slate-500
    },
    position: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    type: {
      type: DataTypes.ENUM("system", "custom"),
      defaultValue: "custom",
    },
    replyCategory: {
      type: DataTypes.STRING,
      allowNull: true,
    },
  },
  {
    tableName: "crm_stages",
    timestamps: true,
    indexes: [
      { fields: ["userId"] },
      { fields: ["position"] },
    ],
  }
);

export default CrmStage;
