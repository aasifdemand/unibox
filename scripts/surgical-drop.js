import sequelize from "../src/config/db.js";

async function dropSurgical() {
  try {
    console.log("🛠️ Starting surgical constraint removal...");

    // 1. Discover all FK constraints on sender_health
    const [results] = await sequelize.query(`
      SELECT conname
      FROM pg_constraint
      JOIN pg_class ON pg_class.oid = pg_constraint.conrelid
      WHERE relname = 'sender_health' AND contype = 'f';
    `);

    if (results.length === 0) {
      console.log("✅ No foreign keys found on 'sender_health'.");
      process.exit(0);
    }

    for (const r of results) {
      console.log(`🧹 Dropping constraint: "${r.conname}"...`);
      // Use double quotes for the constraint name to handle case sensitivity
      await sequelize.query(`ALTER TABLE "sender_health" DROP CONSTRAINT IF EXISTS "${r.conname}" CASCADE`);
      console.log("✅ Success.");
    }

    process.exit(0);
  } catch (error) {
    console.error("❌ Surgical removal failed:", error.message);
    process.exit(1);
  }
}

dropSurgical();
