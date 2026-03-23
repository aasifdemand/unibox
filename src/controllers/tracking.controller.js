import { asyncHandler } from "../helpers/async-handler.js";
import Email from "../models/email.model.js";
import Campaign from "../models/campaign.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import CampaignSend from "../models/campaign-send.model.js";
import GlobalEmailRegistry from "../models/global-email-registry.model.js";
import sequelize from "../config/db.js";

export const trackOpen = asyncHandler(async (req, res) => {
  const { emailId } = req.params;

  try {
    // Find the email and update openedAt
    const email = await Email.findByPk(emailId);

    if (email) {
      // Always track the individual email event
      if (!email.openedAt) {
        await email.update({
          openedAt: new Date(),
          userAgent: req.headers["user-agent"],
          ipAddress: req.ip,
        });

        // Update CampaignSend record for orchestration
        await CampaignSend.update(
          { openedAt: new Date() },
          { where: { emailId: email.id } }
        );
      }

      // Check if this is the first open for the Recipient to keep campaign metrics unique
      if (email.recipientId) {
        const recipient = await CampaignRecipient.findByPk(email.recipientId);
        if (recipient && !recipient.metadata?.opened) {
          await recipient.update({
            metadata: { ...recipient.metadata, opened: true, openedAt: new Date() }
          });

          // Update overall campaign stats ONLY once per recipient
          await Campaign.increment("totalOpens", {
            by: 1,
            where: { id: email.campaignId },
          });
        }
      }

      console.log(`✅ Open tracked for email ${emailId}`);
    }

    // Return 1x1 transparent GIF
    res.writeHead(200, {
      "Content-Type": "image/gif",
      "Content-Length": "43",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    });
    res.end(
      Buffer.from(
        "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        "base64",
      ),
    );
  } catch (error) {
    console.error("Error tracking open:", error);
    // Still return the pixel even if tracking fails
    res.writeHead(200, {
      "Content-Type": "image/gif",
      "Content-Length": "43",
    });
    res.end(
      Buffer.from(
        "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        "base64",
      ),
    );
  }
});
export const trackClick = asyncHandler(async (req, res) => {
  const { emailId } = req.params;
  const { url } = req.query;

  if (!url) return res.redirect("/");

  const decodedUrl = decodeURIComponent(url);

  try {
    // Find the email and update clickedAt
    const email = await Email.findByPk(emailId);

    if (email) {
      // Always track the individual email click event
      await email.update({
        clickedAt: email.clickedAt || new Date(),
        clickCount: sequelize.literal("clickCount + 1"),
        userAgent: req.headers["user-agent"],
        ipAddress: req.ip,
      });

      // Update CampaignSend record for orchestration
      await CampaignSend.update(
        { clickedAt: new Date() },
        { where: { emailId: email.id } }
      );

      // Check if this is the first click for the Recipient to keep campaign metrics unique
      if (email.recipientId) {
        const recipient = await CampaignRecipient.findByPk(email.recipientId);
        if (recipient && !recipient.metadata?.clicked) {
          await recipient.update({
            metadata: { ...recipient.metadata, clicked: true, clickedAt: new Date() }
          });

          // Update overall campaign stats ONLY once per recipient
          await Campaign.increment("totalClicks", {
            by: 1,
            where: { id: email.campaignId },
          });
        }
      }

      console.log(`✅ Click tracked for email ${emailId} to ${decodedUrl}`);
    }
  } catch (error) {
    console.error("Error tracking click:", error);
    // Still redirect even if tracking fails
  }

  // Redirect to original URL
  res.redirect(302, decodedUrl);
});

export const trackUnsubscribe = asyncHandler(async (req, res) => {
  const { emailId } = req.params;

  try {
    const email = await Email.findByPk(emailId);
    if (email && email.recipientId) {
      // Find the recipient in the campaign
      const recipient = await CampaignRecipient.findByPk(email.recipientId);
      
      if (recipient && recipient.status !== "stopped" && recipient.status !== "completed") {
        await recipient.update({
          status: "stopped",
          nextRunAt: null,
          metadata: { ...recipient.metadata, unsubscribed: true, unsubscribedAt: new Date() }
        });
        
        // Update campaign stats
        if (email.campaignId) {
          await Campaign.increment("totalUnsubscribed", {
            where: { id: email.campaignId },
          });
        }
        
        // 🔹 Mark globally unsubscribed in GlobalEmailRegistry
        if (email.recipientEmail) {
          const normalizedEmail = email.recipientEmail.toLowerCase().trim();
          await GlobalEmailRegistry.upsert({
            normalizedEmail,
            unsubscribed: true,
            unsubscribedAt: new Date(),
            lastSeenAt: new Date()
          });
        }
        
        console.log(`🚫 Unsubscribe tracked for email ${emailId}`);
      }
    }
  } catch (error) {
    console.error("Error tracking unsubscribe:", error);
  }

  // Return a simple HTML message for GET requests
  res.send(`
    <html>
      <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
        <h2>You have been successfully unsubscribed.</h2>
        <p>You will no longer receive emails from this campaign.</p>
      </body>
    </html>
  `);
});
