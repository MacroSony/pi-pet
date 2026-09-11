"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  GC_WINDOW_MS,
  MAX_ENVELOPE_SIZE,
  MAX_ID_LENGTH,
  MAX_TEXT_LENGTH,
  atomicWriteJson,
  derivePetId,
  isSafePetId,
  resolvePetIdentity,
} = require("./internal");

const {
  CLAIM_TIMEOUT_MS,
  DEFAULT_USER_MESSAGE_TTL_MS,
  MAX_INBOX_QUEUE_CAPACITY,
  MAX_USER_MESSAGE_TTL_MS,
  MIN_USER_MESSAGE_TTL_MS,
  claimNextUserMessage,
  enqueueUserMessage,
  getUserMessageReceipt,
  settleUserMessage,
} = require("./inbox");

const {
  DEFAULT_PEER_MESSAGE_TTL_MS,
  MAX_PEER_INBOX_QUEUE_CAPACITY,
  MAX_PEER_MESSAGE_TTL_MS,
  MIN_PEER_MESSAGE_TTL_MS,
  PEER_CLAIM_TIMEOUT_MS,
  claimNextPeerMessage,
  enqueuePeerMessage,
  getPeerMessageReceipt,
  settlePeerMessage: coreSettlePeerMessage,
} = require("./peer-inbox");

const DEFAULT_TTL_MS = 30000;
const MIN_TTL_MS = 1000;
const MAX_TTL_MS = 300000;

const VALID_EMOTIONS = Object.freeze(["happy", "shy", "shocked", "sad", "celebrate"]);
const VALID_EMOTIONS_SET = new Set(VALID_EMOTIONS);

const EXPRESSION_WIRE_FIELDS = Object.freeze([
  "petId",
  "profileId",
  "agentId",
  "rawSessionId",
  "text",
  "emotion",
  "dedupKey",
  "commandId",
  "ttlMs",
  "createdAtMs",
]);

function extractWireEnvelope(options, allowedFields) {
  const envelope = {};
  for (const key of allowedFields) {
    if (options[key] !== undefined) {
      envelope[key] = options[key];
    }
  }
  return envelope;
}

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

function expressExpression(options = {}) {
  const fsApi = options?.fsApi || fs;
  const env = options?.env || process.env;
  const nowMs = typeof options?.now === "function" ? options.now() : Date.now();
  const createdAtMs = typeof options?.createdAtMs === "number" ? options.createdAtMs : nowMs;

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
  const envelope = extractWireEnvelope(options, EXPRESSION_WIRE_FIELDS);
  let serializedSize;
  try {
    serializedSize = Buffer.byteLength(JSON.stringify(envelope), "utf8");
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
  const idResult = resolvePetIdentity(options);
  if (!idResult.ok) {
    return {
      schemaVersion: "1",
      commandId: options.commandId || null,
      dedupKey: options.dedupKey || null,
      petId: idResult.petId,
      status: "rejected",
      reason: idResult.reason,
      createdAtMs,
      updatedAtMs: nowMs,
    };
  }
  const petId = idResult.petId;

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
      if (file.startsWith("rcpt-user-")) continue; // Avoid matching user receipts
      if (file.startsWith("rcpt-peer-")) continue; // Avoid matching peer receipts
      const filePath = path.join(receiptsDir, file);
      try {
        const content = fsApi.readFileSync(filePath, "utf8");
        const rcpt = JSON.parse(content);
        if (rcpt.kind === "user_message" || rcpt.kind === "peer_message") continue;

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

const INVISIBLE_AND_BIDI_RE = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\u200B-\u200D\u2060\uFEFF]/g;

function sanitizeProvenanceText(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  const cleaned = value
    .replace(INVISIBLE_AND_BIDI_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

function emitPeerSourceBubble(receipt, options = {}) {
  if (!receipt || typeof receipt !== "object" || !receipt.targetPetId || typeof receipt.targetPetId !== "string") {
    return;
  }

  const sourceDisplayName = sanitizeProvenanceText(receipt.sourceDisplayName, "Pi");
  const sourceHost = sanitizeProvenanceText(receipt.sourceHost, "local");
  const rawText = `Message from ${sourceDisplayName} @ ${sourceHost}`;

  const codePoints = Array.from(rawText);
  const text = codePoints.length > 120 ? codePoints.slice(0, 120).join("") : rawText;

  const messageId = receipt.messageId || "";
  const hash = crypto.createHash("sha256").update(String(messageId)).digest("hex");
  const commandId = `notice_${hash.slice(0, 40)}`;

  try {
    expressExpression({
      petId: receipt.targetPetId,
      text,
      commandId,
      dedupKey: commandId,
      ttlMs: 5000,
      ...(options.dataDir ? { dataDir: options.dataDir } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.fsApi ? { fsApi: options.fsApi } : {}),
      ...(typeof options.now === "function" ? { now: options.now } : {}),
    });
  } catch {
    // Best effort: rejected/failed expression receipt does not alter peer dispatched receipt
  }
}

function settlePeerMessage(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return coreSettlePeerMessage(options);
  }

  const callerOnDispatched = typeof options.onDispatched === "function" ? options.onDispatched : null;

  const wrappedOnDispatched = (receipt) => {
    if (callerOnDispatched) {
      try {
        const callerRes = callerOnDispatched(receipt);
        if (callerRes && typeof callerRes.then === "function") {
          if (typeof callerRes.catch === "function") {
            callerRes.catch(() => {});
          } else {
            callerRes.then(null, () => {});
          }
        }
      } catch {
        // Caller callback error must not alter settlement or throw
      }
    }

    try {
      emitPeerSourceBubble(receipt, options);
    } catch {
      // Bubble expression is best-effort
    }
  };

  return coreSettlePeerMessage({
    ...options,
    onDispatched: wrappedOnDispatched,
  });
}

module.exports = {
  CLAIM_TIMEOUT_MS,
  DEFAULT_PEER_MESSAGE_TTL_MS,
  DEFAULT_TTL_MS,
  DEFAULT_USER_MESSAGE_TTL_MS,
  MAX_ENVELOPE_SIZE,
  MAX_INBOX_QUEUE_CAPACITY,
  MAX_PEER_INBOX_QUEUE_CAPACITY,
  MAX_PEER_MESSAGE_TTL_MS,
  MAX_TEXT_LENGTH,
  MAX_TTL_MS,
  MAX_USER_MESSAGE_TTL_MS,
  MIN_PEER_MESSAGE_TTL_MS,
  MIN_TTL_MS,
  MIN_USER_MESSAGE_TTL_MS,
  PEER_CLAIM_TIMEOUT_MS,
  VALID_EMOTIONS,
  atomicWriteJson,
  claimNextPeerMessage,
  claimNextUserMessage,
  derivePetId,
  enqueuePeerMessage,
  enqueueUserMessage,
  expressExpression,
  getPeerMessageReceipt,
  getUserMessageReceipt,
  isSafePetId,
  settlePeerMessage,
  settleUserMessage,
  validateExpression,
};
