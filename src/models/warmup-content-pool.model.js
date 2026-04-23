import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";

const WarmupContentPool = sequelize.define(
  "WarmupContentPool",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    subject: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    body: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    type: {
      type: DataTypes.ENUM("email", "reply"),
      defaultValue: "email",
    },
    isUsed: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    usedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "warmup_content_pool",
    timestamps: true,
    indexes: [
      {
        fields: ["isUsed", "type"],
      },
    ],
  }
);

export default WarmupContentPool;
