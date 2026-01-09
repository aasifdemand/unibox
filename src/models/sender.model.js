import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";

const Sender = sequelize.define(
  "senders",
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
      unique: true,
    },

    displayName: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    domain: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    
   

    provider: {
      type: DataTypes.ENUM("smtp", "gmail", "ses"),
      defaultValue: "smtp",
    },

    smtpHost: DataTypes.STRING,
    smtpPort: DataTypes.INTEGER,
    smtpSecure: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    smtpUser: DataTypes.STRING,
    smtpPass: DataTypes.STRING, // 🔐 encrypt later

    
    
  },
  {
    tableName: "senders",
    timestamps: true,
    paranoid: true,
    indexes: [
      { fields: ["email"], unique: true },
    ],
  }
);

export default Sender;
