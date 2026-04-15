import crypto from "crypto";
import fs from "fs";
import { promises as fsPromises } from "fs";
import path from "path";
import csv from "csv-parser";
import XLSX from "xlsx";
import ListUploadBatch from "../models/list-upload-batch.model.js";
import ListUploadRecord from "../models/list-upload-record.model.js";
import GlobalEmailRegistry from "../models/global-email-registry.model.js";
import { Op, fn, literal } from "sequelize";
import { asyncHandler } from "../helpers/async-handler.js";
import sequelize from "../config/db.js";
import { extractDomain, getEmailProvider, isValidEmail, normalizeEmail } from "../utils/email-processor.js";
import { enqueueEmailVerification } from "../helpers/enqueue-email-verifier.js";
import { emitToUser } from "../utils/event-broadcaster.js";
import { enrichContact as enrichContactData } from "../services/enrichment.service.js";

// Ensure uploads directory exists
const ensureUploadsDir = async () => {
  const uploadsDir = path.join(process.cwd(), "src/uploads");
  try {
    await fsPromises.access(uploadsDir);
  } catch {
    await fsPromises.mkdir(uploadsDir, { recursive: true });
  }
  return uploadsDir;
};

const slugify = (text) => {
  if (!text) return "";
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_") // Replace spaces with _
    .replace(/[^\w-]+/g, "") // Remove all non-word chars
    .replace(/--+/g, "-") // Replace multiple - with single -
    .replace(/^-+/, "") // Trim - from start of text
    .replace(/-+$/, ""); // Trim - from end of text
};

const calculateChecksum = (filePath) => {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (data) => hash.update(data));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", (err) => reject(err));
  });
};

export const uploadList = async (req, res) => {
  try {
    // Ensure upload directory exists
    await ensureUploadsDir();

    const file = req.file;
    const userId = req.user.id;

    if (!file) {
      return res.status(400).json({
        success: false,
        message: "File required",
      });
    }

    console.log(`📁 File uploaded: ${file.originalname}, path: ${file.path}`);

    // Check if file exists
    if (!fs.existsSync(file.path)) {
      return res.status(500).json({
        success: false,
        message: "File not saved properly",
      });
    }

    // 🛡️ Calculate checksum (Streaming)
    const checksum = await calculateChecksum(file.path);

    // Check for duplicate upload
    const existingBatch = await ListUploadBatch.findOne({
      where: {
        userId,
        checksum,
        status: { [Op.ne]: "failed" },
      },
    });

    if (existingBatch) {
      // Clean up uploaded file
      try {
        fs.unlinkSync(file.path);
      } catch (cleanupError) {
        console.error("Failed to cleanup duplicate file:", cleanupError);
      }

      return res.status(409).json({
        success: false,
        message: "Duplicate upload detected",
        batchId: existingBatch.id,
      });
    }

    // Capture mapping if provided
    let mapping = null;
    if (req.body.mapping) {
      try {
        mapping = typeof req.body.mapping === "string" ? JSON.parse(req.body.mapping) : req.body.mapping;
      } catch (e) {
        console.warn("Failed to parse mapping JSON:", e.message);
      }
    }

    // Create batch record
    const batch = await ListUploadBatch.create({
      userId,
      originalFilename: file.originalname,
      storagePath: file.path,
      fileType: file.originalname.split(".").pop().toLowerCase(),
      checksum,
      status: "uploaded",
      mapping, // Store the user's manual mapping
    });

    console.log(`✅ Batch created: ${batch.id}`);

    // Parse and process immediately (non-blocking)
    // We pass the userId and batchId, enforcement of 10k limit will happen inside
    processUploadedFile(batch.id).catch((error) => {
      console.error(`❌ Failed to process batch ${batch.id}:`, error);
    });

    return res.status(202).json({
      success: true,
      batchId: batch.id,
      status: "uploaded",
      message: "File accepted and processing started. (Limit: 10,000 leads)",
    });
  } catch (error) {
    console.error("Upload error:", error);

    // Clean up file if exists
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (cleanupError) {
        console.error("Failed to cleanup error file:", cleanupError);
      }
    }

    return res.status(500).json({
      success: false,
      message: "Upload failed",
      error: error.message,
    });
  }
};



// Parse Excel
const parseXLSX = (filePath) => {
  try {
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const records = XLSX.utils.sheet_to_json(worksheet);

    // Normalize header names
    return records.map((record) => {
      const normalizedRecord = {};
      Object.keys(record).forEach((key) => {
        if (record[key] !== undefined && record[key] !== null) {
          const normalizedKey = slugify(key);
          normalizedRecord[normalizedKey] = record[key];
        }
      });
      return normalizedRecord;
    });
  } catch (error) {
    console.error("Excel parsing error:", error);
    throw new Error(`Failed to parse Excel file: ${error.message}`);
  }
};

// Parse TXT
const parseTXT = (filePath) => {
  const content = fs.readFileSync(filePath, "utf-8");
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.includes(",") && !trimmed.includes("@")) {
        const parts = trimmed.split(",");
        if (parts.length > 1 && parts[0].includes("@")) {
          return { email: parts[0].trim() };
        }
      }
      return { email: trimmed };
    });
};

// Find email field in record
const findEmailField = (record) => {
  if (!record) return null;

  const possibleEmailFields = [
    "email",
    "emailaddress",
    "mail",
    "e-mail",
    "e_mail",
    "emailid",
    "useremail",
    "username",
    "contactemail",
    "primaryemail",
  ];

  // Check exact matches first
  for (const field of possibleEmailFields) {
    if (
      record[field] !== undefined &&
      record[field] !== null &&
      record[field] !== ""
    ) {
      return String(record[field]).trim();
    }
  }

  // Check if any key contains "email"
  for (const key in record) {
    if (
      key.toLowerCase().includes("email") &&
      record[key] !== undefined &&
      record[key] !== null &&
      record[key] !== ""
    ) {
      return String(record[key]).trim();
    }
  }

  // Check first column
  const firstKey = Object.keys(record)[0];
  if (firstKey && record[firstKey]) {
    const value = String(record[firstKey]).trim();
    if (value.includes("@")) {
      return value;
    }
  }

  // Check all values
  for (const key in record) {
    const value = String(record[key]).trim();
    if (value.includes("@") && value.includes(".")) {
      return value;
    }
  }

  return null;
};

// Find name field in record
const findNameField = (record) => {
  if (!record) return null;

  const possibleNameFields = [
    "name",
    "fullname",
    "full_name",
    "firstname",
    "first_name",
    "lastname",
    "last_name",
    "username",
    "displayname",
    "contactname",
    "personname",
  ];

  for (const field of possibleNameFields) {
    if (
      record[field] !== undefined &&
      record[field] !== null &&
      record[field] !== ""
    ) {
      return String(record[field]).trim();
    }
  }

  // Check if any key contains "name"
  for (const key in record) {
    if (
      key.toLowerCase().includes("name") &&
      record[key] !== undefined &&
      record[key] !== null &&
      record[key] !== ""
    ) {
      return String(record[key]).trim();
    }
  }

  return null;
};

// Streaming process
const processUploadedFile = async (batchId) => {
  let batch;
  const LIMIT = 10000;
  try {
    batch = await ListUploadBatch.findByPk(batchId);
    if (!batch) return;

    await batch.update({ status: "parsing" });

    const allHeaders = new Set();
    const batchRecords = [];
    const uniqueEmailsInBatch = new Set();

    let totalProcessed = 0;
    let validCount = 0;
    let duplicateCount = 0;

    const t = await sequelize.transaction();

    try {
      if (batch.fileType === "csv") {
        await new Promise((resolve, reject) => {
          fs.createReadStream(batch.storagePath)
            .pipe(csv())
            .on("headers", (headers) => {
              headers.forEach(h => allHeaders.add(h));
            })
            .on("data", (row) => {
              totalProcessed++;
              if (totalProcessed > LIMIT) {
                // We'll handle the overflow in the 'end' or here
                return;
              }

              const data = transformRow(row, batch.mapping);
              if (data && !uniqueEmailsInBatch.has(data.normalizedEmail)) {
                uniqueEmailsInBatch.add(data.normalizedEmail);
                batchRecords.push({ ...data, batchId: batch.id });
              }
            })
            .on("end", resolve)
            .on("error", reject);
        });
      } else {
        // Fallback for XLSX/TXT for now (can be optimized later if needed)
        const records = batch.fileType === "xlsx" ? parseXLSX(batch.storagePath) : parseTXT(batch.storagePath);
        totalProcessed = records.length;

        if (totalProcessed <= LIMIT) {
          for (const row of records) {
            Object.keys(row).forEach(h => allHeaders.add(h));
            const data = transformRow(row, batch.mapping);
            if (data && !uniqueEmailsInBatch.has(data.normalizedEmail)) {
              uniqueEmailsInBatch.add(data.normalizedEmail);
              batchRecords.push({ ...data, batchId: batch.id });
            }
          }
        }
      }

      if (totalProcessed > LIMIT) {
        throw new Error(`File exceeds the maximum limit of ${LIMIT} leads.`);
      }

      // Step 2: Deduplicate against Global Registry
      const uniqueEmails = Array.from(uniqueEmailsInBatch);
      const existingEntries = await GlobalEmailRegistry.findAll({
        where: { 
          normalizedEmail: uniqueEmails,
          userId: batch.userId
        },
        attributes: ["normalizedEmail"],
        transaction: t
      });
      const existingSet = new Set(existingEntries.map(e => e.normalizedEmail));

      // Step 3: Prepare entities
      const recordsToInsert = [];
      const registryToCreate = [];

      for (const record of batchRecords) {
        const isNew = !existingSet.has(record.normalizedEmail);
        if (isNew) validCount++; else duplicateCount++;

        recordsToInsert.push({
          batchId: batch.id,
          rawEmail: record.rawEmail,
          normalizedEmail: record.normalizedEmail,
          domain: record.domain,
          name: record.name,
          metadata: record.metadata,
          status: isNew ? "parsed" : "duplicate"
        });

        if (isNew) {
          registryToCreate.push({
            normalizedEmail: record.normalizedEmail,
            userId: batch.userId,
            domain: record.domain,
            emailProvider: getEmailProvider(record.domain),
            firstSeenAt: new Date(),
            lastSeenAt: new Date()
          });
        }
      }

      // Step 4: Bulk Operations
      if (registryToCreate.length > 0) {
        await GlobalEmailRegistry.bulkCreate(registryToCreate, { ignoreDuplicates: true, transaction: t });
      }

      const CHUNK_SIZE = 1000;
      for (let i = 0; i < recordsToInsert.length; i += CHUNK_SIZE) {
        await ListUploadRecord.bulkCreate(recordsToInsert.slice(i, i + CHUNK_SIZE), { transaction: t });
      }

      await batch.update({
        status: "completed",
        totalRecords: totalProcessed,
        validRecords: validCount,
        duplicateRecords: duplicateCount,
        mapping: Array.from(allHeaders).reduce((acc, h) => ({ ...acc, [slugify(h)]: h }), {}),
        processedAt: new Date()
      }, { transaction: t });

      await t.commit();

      // Finalize
      await enqueueEmailVerification(batch.id);
      emitToUser(batch.userId, "notification", {
        type: "success",
        title: "Import Successful",
        message: `${validCount} leads imported from ${batch.originalFilename}.`
      });

    } catch (err) {
      await t.rollback();
      throw err;
    }

  } catch (error) {
    console.error(`❌ Batch ${batchId} failed:`, error.message);
    if (batch) await batch.update({ status: "failed", errorReason: error.message });
  } finally {
    if (batch?.storagePath && fs.existsSync(batch.storagePath)) fs.unlinkSync(batch.storagePath);
  }
};

const transformRow = (record, mapping = {}) => {
  try {
    // 1. Extract Email (Mapping -> Slugified Mapping -> Guessing)
    let emailValue = null;
    if (mapping.email) {
      emailValue = record[mapping.email] || record[slugify(mapping.email)];
    }
    if (!emailValue) emailValue = findEmailField(record);

    if (!emailValue || !isValidEmail(emailValue)) return null;

    const normalizedEmail = normalizeEmail(emailValue);
    if (!normalizedEmail) return null;

    const domain = extractDomain(normalizedEmail);
    if (!domain) return null;

    // 2. Extract Name (try firstName+lastName combination first, then dedicated name column)
    let name = null;
    if (mapping.name) {
      name = record[mapping.name] || record[slugify(mapping.name)];
    }
    // Try to build name from firstName/lastName columns
    if (!name) {
      const firstNameKey = Object.keys(record).find(k => slugify(k) === "firstname");
      const lastNameKey = Object.keys(record).find(k => slugify(k) === "lastname");
      const firstName = firstNameKey ? String(record[firstNameKey]).trim() : "";
      const lastName = lastNameKey ? String(record[lastNameKey]).trim() : "";
      if (firstName || lastName) name = [firstName, lastName].filter(Boolean).join(" ");
    }
    if (!name) name = findNameField(record);

    // 3. Build metadata: store ALL columns under their slugified key.
    //    This ensures every CSV column (role, goal, resourceLink, firstName, etc.)
    //    is available as a {{placeholder}} at send-time via recipient.metadata.
    const metadata = {};

    Object.keys(record).forEach((key) => {
      const slg = slugify(key);
      const val = record[key];
      if (val === undefined || val === null || String(val).trim() === "") return;
      // Skip pure email columns (avoid duplicating the email address in metadata)
      if (slg === "email" || slg === "emailaddress" || slg === "mail") return;
      metadata[slg] = String(val).trim();
    });

    // Add convenient underscore aliases so {{first_name}} works alongside {{firstname}}
    if (metadata.firstname && !metadata.first_name) metadata.first_name = metadata.firstname;
    if (metadata.lastname && !metadata.last_name) metadata.last_name = metadata.lastname;

    return {
      rawEmail: emailValue,
      normalizedEmail,
      domain,
      name,
      metadata: Object.keys(metadata).length > 0 ? metadata : null
    };
  } catch (error) {
    console.error("Row transformation error:", error);
    return null;
  }
};

export const getBatchVerificationStats = async (batchId) => {
  try {
    const rows = await ListUploadRecord.findAll({
      where: {
        batchId,
        normalizedEmail: { [Op.ne]: null },
      },
      include: [
        {
          model: GlobalEmailRegistry,
          required: false,
          attributes: [],
        },
      ],
      attributes: [
        [
          fn(
            "SUM",
            literal(
              'CASE WHEN "GlobalEmailRegistry"."verificationStatus" = \'valid\' THEN 1 ELSE 0 END',
            ),
          ),
          "validCount",
        ],
        [
          fn(
            "SUM",
            literal(
              'CASE WHEN "GlobalEmailRegistry"."verificationStatus" = \'invalid\' THEN 1 ELSE 0 END',
            ),
          ),
          "invalidCount",
        ],
        [
          fn(
            "SUM",
            literal(
              'CASE WHEN "GlobalEmailRegistry"."verificationStatus" = \'risky\' THEN 1 ELSE 0 END',
            ),
          ),
          "riskyCount",
        ],
        [
          fn(
            "SUM",
            literal(
              `CASE 
                WHEN "GlobalEmailRegistry"."verificationStatus" IS NULL
                OR "GlobalEmailRegistry"."verificationStatus" IN ('unknown','verifying')
                THEN 1 ELSE 0 END`,
            ),
          ),
          "unverifiedCount",
        ],
      ],
      raw: true,
    });

    return {
      valid: Number(rows[0]?.validCount || 0),
      invalid: Number(rows[0]?.invalidCount || 0),
      risky: Number(rows[0]?.riskyCount || 0),
      unverified: Number(rows[0]?.unverifiedCount || 0),
    };
  } catch (error) {
    console.error(
      `Error getting verification stats for batch ${batchId}:`,
      error,
    );
    return {
      valid: 0,
      invalid: 0,
      risky: 0,
      unverified: 0,
    };
  }
};

// Get batch status with verification results
export const getBatchStatus = asyncHandler(async (req, res) => {
  const batch = await ListUploadBatch.findOne({
    where: {
      id: req.params.batchId,
      userId: req.user.id,
    },
  });

  if (!batch) {
    return res.status(404).json({
      success: false,
      message: "Batch not found",
    });
  }

  // Get verification stats
  const verificationStats = await getBatchVerificationStats(batch.id);

  // Get record counts
  const counts = await ListUploadRecord.findAll({
    attributes: [
      "status",
      [sequelize.fn("COUNT", sequelize.col("id")), "count"],
    ],
    where: { batchId: batch.id },
    group: ["status"],
  });

  const countsMap = {};
  counts.forEach((item) => {
    countsMap[item.status] = parseInt(item.dataValues.count);
  });

  // In getBatchStatus function, replace the sampleRecords query:
  const sampleRecords = await ListUploadRecord.findAll({
    where: { batchId: batch.id },
    include: [
      {
        model: GlobalEmailRegistry,
        attributes: [
          "verificationStatus",
          "verifiedAt",
          "verificationMeta",
          "unsubscribed",
          "blacklisted",
          "unsubscribedAt",
          "blacklistedAt",
        ],
      },
    ],
    attributes: [
      "id",
      "status",
      "rawEmail",
      "normalizedEmail",
      "name",
      "metadata",
      "failureReason",
      "createdAt",
    ],
    order: [["createdAt", "DESC"]],
    limit: 10,
  });

  // 🚀 OPTIMIZATION: Paginated verified records
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const offset = (page - 1) * limit;

  const { count: totalVerified, rows: allVerifiedRecords } =
    await ListUploadRecord.findAndCountAll({
      where: {
        batchId: batch.id,
        normalizedEmail: { [Op.ne]: null },
      },
      include: [
        {
          model: GlobalEmailRegistry,
          attributes: ["verificationStatus", "verifiedAt", "verificationMeta", "unsubscribed", "blacklisted", "unsubscribedAt", "blacklistedAt"],
        },
      ],
      attributes: [
        "id",
        "status",
        "rawEmail",
        "normalizedEmail",
        "name",
        "metadata",
        "failureReason",
        "createdAt",
      ],
      order: [["createdAt", "DESC"]],
      limit,
      offset,
    });

  // Update the mapped records to use correct field names:
  const mappedSampleRecords = sampleRecords.map((record) => ({
    id: record.id,
    status: record.status,
    email: record.normalizedEmail || record.rawEmail,
    name: record.name,
    metadata: record.metadata || {},
    failureReason: record.failureReason,
    verificationStatus: record.GlobalEmailRegistry?.verificationStatus,
    verifiedAt: record.GlobalEmailRegistry?.verifiedAt,
    verificationReason: record.GlobalEmailRegistry?.verificationMeta,
    unsubscribed: record.GlobalEmailRegistry?.unsubscribed,
    blacklisted: record.GlobalEmailRegistry?.blacklisted,
    unsubscribedAt: record.GlobalEmailRegistry?.unsubscribedAt,
    blacklistedAt: record.GlobalEmailRegistry?.blacklistedAt,
    createdAt: record.createdAt,
  }));

  // Update the mappedAllRecords similarly:
  const mappedAllRecords = allVerifiedRecords.map((record) => ({
    id: record.id,
    status: record.status,
    email: record.normalizedEmail || record.rawEmail,
    name: record.name,
    metadata: record.metadata || {},
    failureReason: record.failureReason,
    verificationStatus: record.GlobalEmailRegistry?.verificationStatus,
    verifiedAt: record.GlobalEmailRegistry?.verifiedAt,
    verificationReason: record.GlobalEmailRegistry?.verificationMeta,
    unsubscribed: record.GlobalEmailRegistry?.unsubscribed,
    blacklisted: record.GlobalEmailRegistry?.blacklisted,
    unsubscribedAt: record.GlobalEmailRegistry?.unsubscribedAt,
    blacklistedAt: record.GlobalEmailRegistry?.blacklistedAt,
    createdAt: record.createdAt,
  }));

  const verificationBreakdown = await ListUploadRecord.findAll({
    where: {
      batchId: batch.id,
      normalizedEmail: { [Op.ne]: null },
    },
    include: [
      {
        model: GlobalEmailRegistry,
        required: false,
        attributes: [],
      },
    ],
    attributes: [
      [
        literal(
          'COALESCE("GlobalEmailRegistry"."verificationStatus", \'unknown\')',
        ),
        "verificationStatus",
      ],
      [sequelize.fn("COUNT", sequelize.col("ListUploadRecord.id")), "count"],
    ],
    group: [
      literal(
        'COALESCE("GlobalEmailRegistry"."verificationStatus", \'unknown\')',
      ),
    ],
    raw: true,
  });

  const verificationBreakdownMap = {};
  verificationBreakdown.forEach((item) => {
    verificationBreakdownMap[item.verificationStatus] = parseInt(item.count);
  });

  res.json({
    success: true,
    data: {
      batch: {
        id: batch.id,
        originalFilename: batch.originalFilename,
        fileType: batch.fileType,
        status: batch.status,
        totalRecords: batch.totalRecords,
        validRecords: batch.validRecords,
        failedRecords: batch.failedRecords,
        checksum: batch.checksum,
        mapping: batch.mapping || {},
        errorReason: batch.errorReason,
        createdAt: batch.createdAt,
        updatedAt: batch.updatedAt,
        verification: verificationStats,
      },
      counts: countsMap,
      verification: verificationStats,
      verificationBreakdown: verificationBreakdownMap,
      sampleRecords: mappedSampleRecords,
      allRecords: mappedAllRecords,
      pagination: {
        total: totalVerified,
        page,
        limit,
        pages: Math.ceil(totalVerified / limit),
      },
    },
  });
});
// Get user's batches
export const getUserBatches = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;

  const { count, rows: batches } = await ListUploadBatch.findAndCountAll({
    where: { userId: req.user.id },
    order: [["createdAt", "DESC"]],
    limit,
    offset,
    attributes: [
      "id",
      "originalFilename",
      "fileType",
      "status",
      "totalRecords",
      "validRecords",
      "duplicateRecords",
      "failedRecords",
      "mapping",
      "createdAt",
      "updatedAt",
    ],
  });

  // 🔹 Add verification stats per batch
  const enrichedBatches = await Promise.all(
    batches.map(async (batch) => {
      const verification = await getBatchVerificationStats(batch.id);

      return {
        ...batch.toJSON(),
        verification, // ✅ verified / invalid / unverified
      };
    }),
  );

  res.status(200).json({
    success: true,
    data: enrichedBatches,
    pagination: {
      page,
      limit,
      total: count,
      pages: Math.ceil(count / limit),
    },
  });
});

// Delete batch
export const deleteBatch = asyncHandler(async (req, res) => {
  const batch = await ListUploadBatch.findOne({
    where: {
      id: req.params.batchId,
      userId: req.user.id,
    },
  });

  if (!batch) {
    return res.status(404).json({
      success: false,
      message: "Batch not found",
    });
  }

  // Delete associated records
  await ListUploadRecord.destroy({
    where: { batchId: batch.id },
  });

  // Delete batch
  await batch.destroy();

  res.json({
    success: true,
    message: "Batch deleted successfully",
  });
});

// Delete individual contact
export const deleteContact = asyncHandler(async (req, res) => {
  const record = await ListUploadRecord.findOne({
    where: { id: req.params.recordId },
    include: [{
      model: ListUploadBatch,
      where: { userId: req.user.id }
    }]
  });

  if (!record) {
    return res.status(404).json({
      success: false,
      message: "Contact not found or unauthorized",
    });
  }

  await record.destroy();

  res.json({
    success: true,
    message: "Contact deleted successfully",
  });
});

// Retry batch
export const retryBatch = asyncHandler(async (req, res) => {
  const batch = await ListUploadBatch.findOne({
    where: {
      id: req.params.batchId,
      userId: req.user.id,
      status: "failed",
    },
  });

  if (!batch) {
    return res.status(404).json({
      success: false,
      message: "Failed batch not found",
    });
  }

  // Reset batch status
  await batch.update({
    status: "uploaded",
    errorReason: null,
  });

  // Reprocess the file
  await processUploadedFile(batch.id, req.user.id);

  res.json({
    success: true,
    message: "Batch retry initiated",
  });
});

// Helper to convert data to CSV
const convertToCSV = (data) => {
  if (!data || data.length === 0) return "";
  const headers = Object.keys(data[0].get ? data[0].get({ plain: true }) : data[0]);
  const rows = data.map((item) => {
    const rawData = item.get ? item.get({ plain: true }) : item;
    return headers
      .map((header) => {
        const value = rawData[header];
        return typeof value === "string" ? `"${value.replace(/"/g, '""')}"` : value;
      })
      .join(",");
  });
  return [headers.join(","), ...rows].join("\n");
};

// Helper to convert data to XLSX
const convertToXLSX = (data) => {
  const jsonData = data.map((item) =>
    item.get ? item.get({ plain: true }) : item,
  );
  const worksheet = XLSX.utils.json_to_sheet(jsonData);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Export");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
};

// Export batch
export const exportBatch = asyncHandler(async (req, res) => {
  const { format = "csv" } = req.query;
  const batchId = req.params.batchId;

  const batch = await ListUploadBatch.findOne({
    where: {
      id: batchId,
      userId: req.user.id,
    },
  });

  if (!batch) {
    return res.status(404).json({
      success: false,
      message: "Batch not found",
    });
  }

  const records = await ListUploadRecord.findAll({
    where: { batchId },
    include: [
      {
        model: GlobalEmailRegistry,
        attributes: ["verificationStatus", "unsubscribed", "blacklisted"],
      },
    ],
    attributes: ["normalizedEmail", "name", "status", "createdAt"],
  });

  const mappedRecords = records.map((r) => ({
    email: r.normalizedEmail,
    name: r.name,
    status: r.status,
    verificationStatus: r.GlobalEmailRegistry?.verificationStatus || 'unverified',
    unsubscribed: r.GlobalEmailRegistry?.unsubscribed || false,
    blacklisted: r.GlobalEmailRegistry?.blacklisted || false,
    createdAt: r.createdAt
  }));

  // Convert to requested format
  let content, contentType, extension;

  switch (format.toLowerCase()) {
    case "csv":
      content = convertToCSV(mappedRecords);
      contentType = "text/csv";
      extension = "csv";
      break;
    case "json":
      content = JSON.stringify(mappedRecords, null, 2);
      contentType = "application/json";
      extension = "json";
      break;
    case "xlsx":
      content = convertToXLSX(mappedRecords);
      contentType =
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      extension = "xlsx";
      break;
    default:
      return res.status(400).json({
        success: false,
        message: "Unsupported export format",
      });
  }

  res.setHeader("Content-Type", contentType);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=batch-${batchId}.${extension}`,
  );
  res.send(content);
});

// Export all contacts matching filter across all batches for the user
export const exportAllUserContacts = asyncHandler(async (req, res) => {
  const format = req.query.format || "csv";
  const searchTerm = req.query.searchTerm || "";
  const filterStatus = req.query.filterStatus || "all";

  // Build where clause for filtering records
  const recordWhere = {
    normalizedEmail: { [Op.ne]: null },
  };

  if (searchTerm) {
    recordWhere[Op.or] = [
      { normalizedEmail: { [Op.iLike]: `%${searchTerm}%` } },
      { name: { [Op.iLike]: `%${searchTerm}%` } },
    ];
  }

  // Build where clause for global registry if filtering by status
  const registryWhere = {};
  if (filterStatus && filterStatus !== "all") {
    const statuses = filterStatus.split(',').map(s => s.trim()).filter(Boolean);
    if (statuses.length > 0) {
      registryWhere.verificationStatus = { [Op.in]: statuses };
    }
  }

  // Find all batches belonging to this user
  const userBatches = await ListUploadBatch.findAll({
    where: { userId: req.user.id },
    attributes: ["id", "originalFilename"],
  });

  const batchIds = userBatches.map(b => b.id);

  if (batchIds.length === 0) {
    return res.status(404).json({ success: false, message: "No contacts to export" });
  }

  recordWhere.batchId = { [Op.in]: batchIds };

  // Query records (no limit/offset for export)
  const records = await ListUploadRecord.findAll({
    where: recordWhere,
    include: [
      {
        model: GlobalEmailRegistry,
        where: Object.keys(registryWhere).length > 0 ? registryWhere : undefined,
        required: Object.keys(registryWhere).length > 0,
        attributes: ["verificationStatus", "verifiedAt", "verificationMeta", "unsubscribed", "blacklisted", "unsubscribedAt", "blacklistedAt"],
      },
    ],
    attributes: [
      "normalizedEmail",
      "name",
      "status",
      "metadata",
      "createdAt",
    ],
    order: [["createdAt", "DESC"]],
  });

  // Transform data for export
  const exportData = records.map(r => {
    const main = {
      email: r.normalizedEmail,
      name: r.name,
      status: r.status,
      verificationStatus: r.GlobalEmailRegistry?.verificationStatus || 'unverified',
      unsubscribed: r.GlobalEmailRegistry?.unsubscribed || false,
      blacklisted: r.GlobalEmailRegistry?.blacklisted || false,
      createdAt: r.createdAt
    };
    // Flatten metadata
    const meta = r.metadata || {};
    return { ...main, ...meta };
  });

  // Convert to requested format
  let content, contentType, extension;

  switch (format.toLowerCase()) {
    case "csv":
      content = convertToCSV(exportData);
      contentType = "text/csv";
      extension = "csv";
      break;
    case "json":
      content = JSON.stringify(exportData, null, 2);
      contentType = "application/json";
      extension = "json";
      break;
    case "xlsx":
      content = convertToXLSX(exportData);
      contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      extension = "xlsx";
      break;
    default:
      return res.status(400).json({ success: false, message: "Unsupported format" });
  }

  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename=audience-export-${new Date().toISOString().split('T')[0]}.${extension}`);
  res.send(content);
});

// Get all contacts across all batches for the user
export const getAllUserContacts = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const offset = (page - 1) * limit;

  const searchTerm = req.query.searchTerm || "";
  const filterStatus = req.query.filterStatus || "all";

  // Build where clause for filtering records
  const recordWhere = {
    normalizedEmail: { [Op.ne]: null },
  };

  if (searchTerm) {
    recordWhere[Op.or] = [
      { normalizedEmail: { [Op.iLike]: `%${searchTerm}%` } },
      { name: { [Op.iLike]: `%${searchTerm}%` } },
    ];
  }

  // Build where clause for global registry if filtering by status
  const registryWhere = {};
  if (filterStatus && filterStatus !== "all") {
    const statuses = filterStatus.split(',').map(s => s.trim()).filter(Boolean);
    if (statuses.length > 0) {
      registryWhere.verificationStatus = { [Op.in]: statuses };
    }
  }

  // Find all batches belonging to this user
  const userBatches = await ListUploadBatch.findAll({
    where: { userId: req.user.id },
    attributes: ["id", "originalFilename"],
  });

  const batchIds = userBatches.map(b => b.id);

  if (batchIds.length === 0) {
    return res.json({
      success: true,
      data: {
        contacts: [],
        pagination: {
          total: 0,
          page,
          limit,
          pages: 0,
        },
      },
    });
  }

  recordWhere.batchId = { [Op.in]: batchIds };

  // Query records
  const { count, rows: records } = await ListUploadRecord.findAndCountAll({
    where: recordWhere,
    include: [
      {
        model: GlobalEmailRegistry,
        where: Object.keys(registryWhere).length > 0 ? registryWhere : undefined,
        required: Object.keys(registryWhere).length > 0, // Only inner join if filtering by status
        attributes: ["verificationStatus", "verifiedAt", "verificationMeta", "unsubscribed", "blacklisted", "unsubscribedAt", "blacklistedAt"],
      },
    ],
    attributes: [
      "id",
      "batchId",
      "status",
      "rawEmail",
      "normalizedEmail",
      "name",
      "metadata",
      "failureReason",
      "createdAt",
    ],
    order: [["createdAt", "DESC"]],
    limit,
    offset,
  });

  // Map batch IDs back to filenames for frontend convenience
  const batchMap = {};
  userBatches.forEach(b => {
    batchMap[b.id] = b.originalFilename;
  });

  const mappedRecords = records.map((record) => ({
    id: record.id,
    sourceBatch: batchMap[record.batchId] || "Unknown",
    status: record.status,
    email: record.normalizedEmail || record.rawEmail,
    name: record.name,
    metadata: record.metadata || {},
    failureReason: record.failureReason,
    verificationStatus: record.GlobalEmailRegistry?.verificationStatus,
    verifiedAt: record.GlobalEmailRegistry?.verifiedAt,
    verificationReason: record.GlobalEmailRegistry?.verificationMeta,
    unsubscribed: record.GlobalEmailRegistry?.unsubscribed,
    blacklisted: record.GlobalEmailRegistry?.blacklisted,
    unsubscribedAt: record.GlobalEmailRegistry?.unsubscribedAt,
    blacklistedAt: record.GlobalEmailRegistry?.blacklistedAt,
    createdAt: record.createdAt,
  }));

  res.json({
    success: true,
    data: {
      contacts: mappedRecords,
      pagination: {
        total: count,
        page,
        limit,
        pages: Math.ceil(count / limit),
      },
    },
  });
});

/**
 * Enrich a single contact using Apollo or Leadmagic
 * POST /api/v1/lists/contact/:contactId/enrich
 */
export const enrichContact = asyncHandler(async (req, res) => {
  const { contactId } = req.params;
  const userId = req.user.id;

  const record = await ListUploadRecord.findByPk(contactId);
  if (!record) {
    return res.status(404).json({ success: false, message: "Contact not found" });
  }

  const email = record.normalizedEmail || record.rawEmail;
  if (!email) {
    return res.status(400).json({ success: false, message: "Contact has no email" });
  }

  const enriched = await enrichContactData(userId, email);

  if (!enriched) {
    return res.status(404).json({ success: false, message: "No enrichment data found for this contact." });
  }

  // Merge enriched data into existing metadata (only fill missing fields)
  const existingMetadata = record.metadata || {};
  const merged = {
    ...existingMetadata,
    // Only overwrite if currently empty/missing
    ...(enriched.company && !existingMetadata.company ? { company: enriched.company } : {}),
    ...(enriched.jobTitle && !existingMetadata.jobtitle && !existingMetadata.job_title ? { job_title: enriched.jobTitle } : {}),
    ...(enriched.phone && !existingMetadata.phone ? { phone: enriched.phone } : {}),
    ...(enriched.city && !existingMetadata.city ? { city: enriched.city } : {}),
    ...(enriched.country && !existingMetadata.country ? { country: enriched.country } : {}),
    ...(enriched.website && !existingMetadata.website ? { website: enriched.website } : {}),
    ...(enriched.linkedin && !existingMetadata.linkedin ? { linkedin: enriched.linkedin } : {}),
    _enrichedAt: new Date().toISOString(),
    _enrichedBy: enriched.sources || enriched.source,
  };

  // Update name too if missing
  const updates = { metadata: merged };
  if (enriched.name && !record.name) {
    updates.name = enriched.name;
  }

  await record.update(updates);

  res.json({
    success: true,
    message: `Contact enriched via ${Array.isArray(enriched.sources) ? enriched.sources.join(' + ') : enriched.source}`,
    data: {
      id: record.id,
      email,
      name: updates.name || record.name,
      metadata: merged,
      enrichedFields: Object.keys(enriched).filter(k => !['source', 'sources'].includes(k) && enriched[k]),
    },
  });
});
