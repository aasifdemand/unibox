import sequelize from "../src/config/db.js";

async function renameColumnSurgically() {
  try {
    console.log("🛠️ Starting surgical column rename for 'sender_health'...");
    
    // 1. Drop the constraint if it still exists (it's the root of the crash)
    await sequelize.query('ALTER TABLE "sender_health" DROP CONSTRAINT IF EXISTS "sender_health_senderId_fkey" CASCADE');
    console.log("✅ Dropped constraint 'sender_health_senderId_fkey'.");
    
    // 2. Rename the column from senderId to mailboxId
    // In Postgres, renaming a column doesn't lose data.
    await sequelize.query('ALTER TABLE "sender_health" RENAME COLUMN "senderId" TO "mailboxId"');
    console.log("✅ Renamed column 'senderId' to 'mailboxId'.");
    
    console.log("✨ Migration complete! Your server should now start without crashing.");
    process.exit(0);
  } catch (error) {
    if (error.message.includes("does not exist")) {
        console.log("⚠️ Column 'senderId' might already be renamed or missing. Skipping.");
        process.exit(0);
    }
    console.error("❌ Migration failed:", error.message);
    process.exit(1);
  }
}

renameColumnSurgically();
