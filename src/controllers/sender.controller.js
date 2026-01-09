import Sender from "../models/sender.model.js";
import { asyncHandler } from "../helpers/async-handler.js";
import AppError from "../utils/app-error.js";

export const createSender = asyncHandler(async (req, res) => {
  const {
    email,
    displayName,
    provider,
    smtpHost,
    smtpPort,
    smtpSecure,
    smtpUser,
    smtpPassword,
  } = req.body;

  if (!email || !provider) {
    throw new AppError("Email and provider are required", 400);
  }

  const sender = await Sender.create({
    userId: req.user.id,
    email,
    displayName,
    domain: email.split("@")[1],
    provider,
    smtpHost,
    smtpPort,
    smtpSecure,
    smtpUser,
    smtpPass:smtpPassword,
   
  });

  res.status(201).json({
    success: true,
    data: sender,
  });
});

export const listSenders = asyncHandler(async (req, res) => {
  const senders = await Sender.findAll({
    where: { userId: req.user.id },
    order: [["createdAt", "DESC"]],
  });

  res.json({ success: true, data: senders });
});

