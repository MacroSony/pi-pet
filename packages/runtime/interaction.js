"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_TTL_MS = 30000;
const MIN_TTL_MS = 1000;
const MAX_TTL_MS = 300000;
const MAX_ENVELOPE_SIZE = 16384; // 16 KiB
const MAX_TEXT_LENGTH = 2000;
const MAX_ID_LENGTH = 64;
const GC_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

const VALID_EMOTIONS = Object.freeze(["happy", "shy", "shocked", "sad", "celebrate"]);
const VALID_EMOTIONS_SET = new Set(VALID_EMOTIONS);

const { derivePetId, isSafePetId } = require("./identity");

function validateExpression(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "Payload must be an object" };
  }

  const { text, emotion } = payload;

  if (text === undefined && emotion === undefined) {
    return { ok: false, reason: "At least one of text or emotion is required" };
  }

  if (text !== undefined) {
    if (typeof text !== "string") {
      return { ok: false, reason: "text must be a string" };
    }
    if (text.length < 1 || text.length > MAX_TEXT_LENGTH) {
      return { ok: false, reason: `text length must be between 1 and ${MAX_TEXT_LENGTH} characters` };
    }
  }

  if (emotion !== undefined) {
    if (typeof emotion !== "string" || !VALID_EMOTIONS_SET.has(emotion)) {
      return {
        ok: false,
        reason: `Invalid emotion: "${emotion}". Must be one of: ${VALID_EMOTIONS.join(", ")}`,
      };
    }
  }

  return { ok: true };
}

function atomicWriteJson(targetPath, data, fsApi = fs) {
  const dir = path.dirname(targetPath);
  fsApi.mkdirSync(dir, { recursive: true });
  const content = `${JSON.stringify(data, null, 2)}\n`;
  const temporaryPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fsApi.writeFileSync(temporaryPath, content, "utf8");
  try {
    fsApi.renameSync(temporaryPath, targetPath);
  } catch {
    fsApi.writeFileSync(targetPath, content, "utf8");
    try { fsApi.unlinkSync(temporaryPath); } catch {}
  }
}

function expressExpression(options = {}) {
  const fsApi = options.fsApi || fs;
  const env = options.env || process.env;
  const nowMs = typeof options.now === "function" ? options.now() : Date.now();
  const createdAtMs = typeof options.createdAtMs === "number" ? options.createdAtMs : nowMs;

  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return {
      schemaVersion: "1",
      commandId: null,
      dedupKey: null,
      petId: null,
      status: "rejected",
      reason: "SchemaValidationError: options must be an object",
      createdAtMs,
      updatedAtMs: nowMs,
    };
  }

  // 1. Validate envelope size
  let serializedSize;
  try {
    serializedSize = Buffer.byteLength(JSON.stringify(options), "utf8");
  } catch {
    return {
      schemaVersion: "1",
      commandId: options.commandId || null,
      dedupKey: options.dedupKey || null,
      petId: null,
      status: "rejected",
      reason: "SchemaValidationError: options cannot be serialized to JSON",
      createdAtMs,
      updatedAtMs: nowMs,
    };
  }

  if (serializedSize > MAX_ENVELOPE_SIZE) {
    return {
      schemaVersion: "1",
      commandId: options.commandId || null,
      dedupKey: options.dedupKey || null,
      petId: null,
      status: "rejected",
      reason: "SchemaValidationError: payload exceeds maximum envelope size of 16 KiB",
      createdAtMs,
      updatedAtMs: nowMs,
    };
  }

  // 2. Validate expression payload
  const validation = validateExpression({ text: options.text, emotion: options.emotion });
  if (!validation.ok) {
    return {
      schemaVersion: "1",
      commandId: options.commandId || null,
      dedupKey: options.dedupKey || null,
      petId: null,
      status: "rejected",
      reason: `SchemaValidationError: ${validation.reason}`,
      createdAtMs,
      updatedAtMs: nowMs,
    };
  }

  // 3. Validate TTL
  const ttlMs = options.ttlMs === undefined ? DEFAULT_TTL_MS : options.ttlMs;
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) {
    return {
      schemaVersion: "1",
      commandId: options.commandId || null,
      dedupKey: options.dedupKey || null,
      petId: null,
      status: "rejected",
      reason: `SchemaValidationError: ttlMs must be a number between ${MIN_TTL_MS} and ${MAX_TTL_MS}`,
      createdAtMs,
      updatedAtMs: nowMs,
    };
  }

  // 4. Validate identifier fields if supplied
  if (options.dedupKey !== undefined && (typeof options.dedupKey !== "string" || options.dedupKey.length > MAX_ID_LENGTH || options.dedupKey.length === 0)) {
    return {
      schemaVersion: "1",
      commandId: options.commandId || null,
      dedupKey: null,
      petId: null,
      status: "rejected",
      reason: `SchemaValidationError: dedupKey must be a non-empty string up to ${MAX_ID_LENGTH} characters`,
      createdAtMs,
      updatedAtMs: nowMs,
    };
  }

  if (options.commandId !== undefined && (typeof options.commandId !== "string" || options.commandId.length > MAX_ID_LENGTH || options.commandId.length === 0)) {
    return {
      schemaVersion: "1",
      commandId: null,
      dedupKey: options.dedupKey || null,
      petId: null,
      status: "rejected",
      reason: `SchemaValidationError: commandId must be a non-empty string up to ${MAX_ID_LENGTH} characters`,
      createdAtMs,
      updatedAtMs: nowMs,
    };
  }

  // 5. Derive or validate petId
  let petId;
  if (options.petId) {
    petId = options.petId;
  } else if (options.rawSessionId || options.id || options.agentId || options.profileId) {
    if (!options.rawSessionId && !options.id) {
      return {
        schemaVersion: "1",
        commandId: options.commandId || null,
        dedupKey: options.dedupKey || null,
        petId: null,
        status: "rejected",
        reason: "InvalidPetIdentity: rawSessionId is required to derive petId",
        createdAtMs,
        updatedAtMs: nowMs,
      };
    }
    petId = derivePetId({
      profileId: options.profileId,
      agentId: options.agentId,
      rawSessionId: options.rawSessionId || options.id,
    });
  } else {
    return {
      schemaVersion: "1",
      commandId: options.commandId || null,
      dedupKey: options.dedupKey || null,
      petId: null,
      status: "rejected",
      reason: "InvalidPetIdentity: session identity is required",
      createdAtMs,
      updatedAtMs: nowMs,
    };
  }

  if (!isSafePetId(petId)) {
    return {
      schemaVersion: "1",
      commandId: options.commandId || null,
      dedupKey: options.dedupKey || null,
      petId: String(petId).slice(0, MAX_ID_LENGTH),
      status: "rejected",
      reason: "InvalidPetIdentity: malformed petId or path traversal detected",
      createdAtMs,
      updatedAtMs: nowMs,
    };
  }

  // 6. Resolve data directory
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const dataDir = options.dataDir || env.PI_PET_DATA_DIR || path.join(home, ".pi-pet");
  const statusDir = path.join(dataDir, "status");
  const eventsDir = path.join(dataDir, "events");
  const receiptsDir = path.join(dataDir, "receipts");

  // 7. Active session verification
  const statusPath = path.join(statusDir, `status-${petId}.json`);
  if (!fsApi.existsSync(statusPath)) {
    return {
      schemaVersion: "1",
      commandId: options.commandId || null,
      dedupKey: options.dedupKey || null,
      petId,
      status: "rejected",
      reason: `UnknownPetIdentity: active session status file not found for ${petId}`,
      createdAtMs,
      updatedAtMs: nowMs,
    };
  }

  let statusData;
  try {
    const rawStatus = fsApi.readFileSync(statusPath, "utf8");
    statusData = JSON.parse(rawStatus);
  } catch (err) {
    return {
      schemaVersion: "1",
      commandId: options.commandId || null,
      dedupKey: options.dedupKey || null,
      petId,
      status: "rejected",
      reason: `UnknownPetIdentity: failed to parse active session status file: ${err.message}`,
      createdAtMs,
      updatedAtMs: nowMs,
    };
  }

  if (!statusData || statusData.state === "closed") {
    return {
      schemaVersion: "1",
      commandId: options.commandId || null,
      dedupKey: options.dedupKey || null,
      petId,
      status: "rejected",
      reason: "SessionClosed: session is closed",
      createdAtMs,
      updatedAtMs: nowMs,
    };
  }

  // 8. Check TTL expiration at ingestion
  if (createdAtMs + ttlMs < nowMs) {
    return {
      schemaVersion: "1",
      commandId: options.commandId || null,
      dedupKey: options.dedupKey || null,
      petId,
      status: "expired",
      reason: "Command expired before processing",
      createdAtMs,
      updatedAtMs: nowMs,
    };
  }

  // 9. Command & dedup identity
  const commandId = options.commandId || crypto.randomUUID();
  const dedupKey = options.dedupKey || commandId;

  // 10. Opportunistic GC & Deduplication check
  try {
    fsApi.mkdirSync(receiptsDir, { recursive: true });
    const entries = fsApi.readdirSync(receiptsDir);
    for (const file of entries) {
      if (!file.startsWith("rcpt-") || !file.endsWith(".json")) continue;
      const filePath = path.join(receiptsDir, file);
      try {
        const content = fsApi.readFileSync(filePath, "utf8");
        const rcpt = JSON.parse(content);

        const rcptTime = rcpt.createdAtMs || rcpt.updatedAtMs || 0;
        if (rcptTime > 0 && nowMs - rcptTime > GC_WINDOW_MS) {
          try { fsApi.unlinkSync(filePath); } catch {}
          continue;
        }

        if (
          (rcpt.petId === petId && rcpt.dedupKey === dedupKey) ||
          file === `rcpt-${commandId}.json` ||
          rcpt.commandId === commandId
        ) {
          return rcpt;
        }
      } catch {
        // Skip malformed/unreadable receipts during scan
      }
    }
  } catch {
    // Ignore directory scan errors
  }

  // 11. Construct PetEvent and DeliveryReceipt
  const payloadEcho = {};
  if (options.text !== undefined) payloadEcho.text = options.text;
  if (options.emotion !== undefined) payloadEcho.emotion = options.emotion;

  const eventPayload = {
    ...payloadEcho,
    speak: false,
    priority: 3,
    durationMs: 2500,
  };

  const petEvent = {
    schemaVersion: "1",
    eventId: commandId,
    petId,
    kind: "expression",
    payload: eventPayload,
    createdAtMs,
    expiresAtMs: createdAtMs + ttlMs,
  };

  const receipt = {
    schemaVersion: "1",
    commandId,
    dedupKey,
    petId,
    status: "delivered",
    reason: null,
    payloadEcho,
    createdAtMs,
    updatedAtMs: nowMs,
  };

  // 12. Atomic persistence
  try {
    const eventPath = path.join(eventsDir, `event-${petId}.json`);
    atomicWriteJson(eventPath, petEvent, fsApi);

    const receiptPath = path.join(receiptsDir, `rcpt-${commandId}.json`);
    atomicWriteJson(receiptPath, receipt, fsApi);
  } catch (err) {
    return {
      schemaVersion: "1",
      commandId,
      dedupKey,
      petId,
      status: "failed",
      reason: `IO failure: ${err.message}`,
      createdAtMs,
      updatedAtMs: nowMs,
    };
  }

  return receipt;
}

module.exports = {
  DEFAULT_TTL_MS,
  MAX_ENVELOPE_SIZE,
  MAX_TEXT_LENGTH,
  MAX_TTL_MS,
  MIN_TTL_MS,
  VALID_EMOTIONS,
  derivePetId,
  expressExpression,
  isSafePetId,
  validateExpression,
};
