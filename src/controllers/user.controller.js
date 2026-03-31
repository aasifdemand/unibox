import { asyncHandler } from "../helpers/async-handler.js";
import AppError from "../utils/app-error.js";
import User from "../models/user.model.js";
import Campaign from "../models/campaign.model.js";
import { Op } from "sequelize";
import { comparePassword, hashPassword } from "../helpers/hash-password.js";

export const getProfile = asyncHandler(async (req, res) => {
  res.ok({
    data: {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
      designation: req.user.designation,
      timezone: req.user.timezone,
      isVerified: req.user.isVerified,
      googleId: req.user.googleId,
    },
  });
});

export const updateProfile = asyncHandler(async (req, res) => {
  const { name, email, designation, timezone } = req.body;

  if (!name && !email && !designation && !timezone) {
    throw new AppError("At least one field is required to update", 400);
  }

  const user = await User.findByPk(req.user.id);

  if (!user) {
    throw new AppError("User not found", 404);
  }

  if (email && email !== user.email) {
    const emailExists = await User.findOne({ where: { email } });
    if (emailExists) {
      throw new AppError("Email already in use", 409);
    }
  }

  const oldTimezone = user.timezone;

  if (name) user.name = name;
  if (email) user.email = email;
  if (designation !== undefined) user.designation = designation;
  if (timezone) user.timezone = timezone;

  await user.save();

  // PROACTIVE SYNC: Update draft and paused campaigns if timezone changed
  if (timezone && timezone !== oldTimezone) {
    await Campaign.update(
      { timezone: user.timezone },
      {
        where: {
          userId: user.id,
          status: { [Op.in]: ["draft", "paused"] },
        },
      },
    );
  }

  res.ok({
    message: "Profile updated successfully",
    data: {
      id: user.id,
      name: user.name,
      email: user.email,
      designation: user.designation,
      timezone: user.timezone,
      isVerified: user.isVerified,
    },
  });
});

export const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    throw new AppError("Current password and new password are required", 400);
  }
  const userId = req.user.id;
  const user = await User.findByPk(userId);

  if (!user) {
    throw new AppError("User not found", 404);
  }

  const isMatch = await comparePassword(currentPassword, user.password);

  if (!isMatch) {
    throw new AppError("Current password is incorrect", 400);
  }

  const hashedPass = await hashPassword(newPassword);

  user.password = hashedPass;
  await user.save();

  res.ok({
    message: "Password changed successfully",
  });
});
