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
  isSafeId,
  isSafePetId,
} = require("./internal");

const DEFAULT_PEER_MESSAGE_TTL_MS = 60000; // 60s
const MIN_PEER_MESSAGE_TTL_MS = 1000; // 1s
const MAX_PEER_MESSAGE_TTL_MS = 300000; // 300s
const MAX_PEER_INBOX_QUEUE_CAPACITY = 16;
const PEER_CLAIM_TIMEOUT_MS = 60000; // 60s
const MAX_REASON_LENGTH = 1024;
const CREATED_AT_LOWER_BOUND_OFFSET_MS = 300000; // now - 300000
const CREATED_AT_UPPER_BOUND_OFFSET_MS = 10000; // now + 10000

const VALID_SETTLE_STATUSES = Object.freeze(new Set(["dispatched", "failed", "expired"]));

const PEER_ENQUEUE_WIRE_FIELDS = Object.freeze([
  "targetPetId",
  "sourcePetId",
  "sourceDisplayName",
  "sourceHost",
  "text",
  "deliverAs",
  "messageId",
  "dedupKey",
  "threadId",
  "hopCount",
  "maxHops",
  "replyHandle",
  "ttlMs",
  "createdAtMs",
]);

const PEER_SETTLE_WIRE_FIELDS = Object.freeze([
  "targetPetId",
  "messageId",
  "claimToken",
  "status",
  "reason",
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

function resolveDataDir(options, env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return options?.dataDir || env.PI_PET_DATA_DIR || path.join(home, ".pi-pet");
}

function buildPeerMessageReceipt({
  messageId = null,
  dedupKey = null,
  targetPetId = null,
  sourcePetId = null,
  sourceDisplayName = null,
  sourceHost = null,
  status,
  reason = null,
  text,
  deliverAs = "followUp",
  threadId = null,
  hopCount,
  maxHops,
  replyHandle,
  createdAtMs,
  updatedAtMs,
  expiresAtMs,
}) {
  const receipt = {
    schemaVersion: "1",
    kind: "peer_message",
    messageId: messageId || null,
    dedupKey: dedupKey || null,
    targetPetId: targetPetId || null,
    sourcePetId: sourcePetId || null,
    sourceDisplayName: sourceDisplayName || null,
    sourceHost: sourceHost || null,
    status,
    reason: reason || null,
  };

  if (text !== undefined) {
    receipt.text = text;
  }
  if (deliverAs !== undefined && status !== "rejected") {
    receipt.deliverAs = deliverAs;
  }
  if (threadId !== undefined && threadId !== null) {
    receipt.threadId = threadId;
  }
  if (hopCount !== undefined) {
    receipt.hopCount = hopCount;
  }
  if (maxHops !== undefined) {
    receipt.maxHops = maxHops;
  }
  if (replyHandle !== undefined) {
    receipt.replyHandle = replyHandle;
  }
  if (createdAtMs !== undefined) {
    receipt.createdAtMs = createdAtMs;
  }
  if (updatedAtMs !== undefined) {
    receipt.updatedAtMs = updatedAtMs;
  }
  if (expiresAtMs !== undefined) {
    receipt.expiresAtMs = expiresAtMs;
  }
  if (text !== undefined || (deliverAs !== undefined && status !== "rejected")) {
    receipt.payloadEcho = {
      ...(text !== undefined ? { text } : {}),
      ...(deliverAs !== undefined && status !== "rejected" ? { deliverAs } : {}),
      ...(threadId !== undefined && threadId !== null ? { threadId } : {}),
      ...(hopCount !== undefined ? { hopCount } : {}),
      ...(maxHops !== undefined ? { maxHops } : {}),
      ...(replyHandle !== undefined ? { replyHandle } : {}),
    };
  }

  return receipt;
}

function quarantinePendingCandidate(fsApi, pendingDir, entry) {
  try {
    const safeEntry = path.basename(entry);
    const sourcePath = path.join(pendingDir, safeEntry);
    const quarantinePath = path.join(
      pendingDir,
      `${safeEntry}.${crypto.randomUUID()}.quarantine`
    );
    fsApi.renameSync(sourcePath, quarantinePath);
  } catch {
    // Best-effort atomic quarantine; safely skip if it fails.
  }
}

function cleanupStalePeerClaims({ fsApi, claimedDir, receiptsDir, targetPetId, nowMs }) {
  try {
    if (!fsApi.existsSync(claimedDir)) return;
    const claimedEntries = fsApi.readdirSync(claimedDir);
    for (const file of claimedEntries) {
      if (!file.endsWith(".json") || file.endsWith(".tmp") || file.endsWith(".quarantine")) continue;
      const fileBase = path.basename(file, ".json");
      if (!isSafeId(fileBase)) continue;

      const claimedFilePath = path.join(claimedDir, file);
      try {
        const rawClaimed = fsApi.readFileSync(claimedFilePath, "utf8");
        const claimedMsg = JSON.parse(rawClaimed);
        if (!claimedMsg || typeof claimedMsg !== "object" || Array.isArray(claimedMsg)) continue;

        const candidateMessageId = typeof claimedMsg.messageId === "string" && isSafeId(claimedMsg.messageId)
          ? claimedMsg.messageId
          : fileBase;
        if (!isSafeId(candidateMessageId)) continue;

        const candidateTargetPetId = typeof claimedMsg.targetPetId === "string" && isSafePetId(claimedMsg.targetPetId)
          ? claimedMsg.targetPetId
          : targetPetId;
        if (!isSafePetId(candidateTargetPetId)) continue;

        // Skip missing or non-safe-integer claimedAtMs to prevent killing files in rename window
        if (
          typeof claimedMsg.claimedAtMs !== "number" ||
          !Number.isSafeInteger(claimedMsg.claimedAtMs) ||
          claimedMsg.claimedAtMs <= 0
        ) {
          continue;
        }

        const claimedAt = claimedMsg.claimedAtMs;

        if (nowMs - claimedAt > PEER_CLAIM_TIMEOUT_MS) {
          const rcptPath = path.join(receiptsDir, `rcpt-peer-${candidateMessageId}.json`);

          // Check if a terminal peer receipt already exists
          let existingTerminal = false;
          try {
            if (fsApi.existsSync(rcptPath)) {
              const existingRcpt = JSON.parse(fsApi.readFileSync(rcptPath, "utf8"));
              if (
                existingRcpt.status === "dispatched" ||
                existingRcpt.status === "failed" ||
                existingRcpt.status === "expired" ||
                existingRcpt.status === "rejected"
              ) {
                existingTerminal = true;
              }
            }
          } catch {}

          if (existingTerminal) {
            // Remove leftover claim without downgrading/overwriting terminal status
            try { fsApi.unlinkSync(claimedFilePath); } catch {}
          } else {
            // Persist terminal receipt before unlinking claim; if receipt write fails, leave claim
            const failedReceipt = buildPeerMessageReceipt({
              messageId: candidateMessageId,
              dedupKey: typeof claimedMsg.dedupKey === "string" && isSafeId(claimedMsg.dedupKey) ? claimedMsg.dedupKey : null,
              targetPetId: candidateTargetPetId,
              sourcePetId: typeof claimedMsg.sourcePetId === "string" && isSafePetId(claimedMsg.sourcePetId) ? claimedMsg.sourcePetId : null,
              sourceDisplayName: typeof claimedMsg.sourceDisplayName === "string" ? claimedMsg.sourceDisplayName : null,
              sourceHost: typeof claimedMsg.sourceHost === "string" ? claimedMsg.sourceHost : null,
              status: "failed",
              reason: "Claim expired: stale claimed item older than 60s (delivery-unknown)",
              text: typeof claimedMsg.text === "string" ? claimedMsg.text : "",
              deliverAs: "followUp",
              threadId: typeof claimedMsg.threadId === "string" ? claimedMsg.threadId : null,
              hopCount: typeof claimedMsg.hopCount === "number" ? claimedMsg.hopCount : 0,
              maxHops: typeof claimedMsg.maxHops === "number" ? claimedMsg.maxHops : 1,
              replyHandle: typeof claimedMsg.replyHandle === "string" ? claimedMsg.replyHandle : null,
              createdAtMs: typeof claimedMsg.createdAtMs === "number" ? claimedMsg.createdAtMs : nowMs,
              updatedAtMs: nowMs,
              expiresAtMs: typeof claimedMsg.expiresAtMs === "number" ? claimedMsg.expiresAtMs : undefined,
            });
            try {
              atomicWriteJson(rcptPath, failedReceipt, fsApi);
              try { fsApi.unlinkSync(claimedFilePath); } catch {}
            } catch {
              // Leave claim if receipt write fails (I/O evidence preservation)
            }
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {}
}

function enqueuePeerMessage(options = {}) {
  const fsApi = options?.fsApi || fs;
  const env = options?.env || process.env;
  const nowMs = typeof options?.now === "function" ? options.now() : Date.now();

  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return buildPeerMessageReceipt({
      messageId: null,
      dedupKey: null,
      targetPetId: null,
      sourcePetId: null,
      status: "rejected",
      reason: "SchemaValidationError: options must be an object",
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  }

  // Trusted test seam: validate createdAtMs safe integer and range [now - 300000, now + 10000]
  let createdAtMs = nowMs;
  if (options.createdAtMs !== undefined) {
    if (
      typeof options.createdAtMs !== "number" ||
      !Number.isSafeInteger(options.createdAtMs) ||
      options.createdAtMs < nowMs - CREATED_AT_LOWER_BOUND_OFFSET_MS ||
      options.createdAtMs > nowMs + CREATED_AT_UPPER_BOUND_OFFSET_MS
    ) {
      return buildPeerMessageReceipt({
        messageId: typeof options.messageId === "string" && isSafeId(options.messageId) ? options.messageId : null,
        dedupKey: typeof options.dedupKey === "string" && isSafeId(options.dedupKey) ? options.dedupKey : null,
        targetPetId: typeof options.targetPetId === "string" && isSafePetId(options.targetPetId) ? options.targetPetId : null,
        sourcePetId: typeof options.sourcePetId === "string" && isSafePetId(options.sourcePetId) ? options.sourcePetId : null,
        status: "rejected",
        reason: `SchemaValidationError: createdAtMs must be a safe integer within [now - ${CREATED_AT_LOWER_BOUND_OFFSET_MS}, now + ${CREATED_AT_UPPER_BOUND_OFFSET_MS}]`,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      });
    }
    createdAtMs = options.createdAtMs;
  }

  // 1. Validate envelope size (<= 16 KiB)
  const envelope = extractWireEnvelope(options, PEER_ENQUEUE_WIRE_FIELDS);
  let serializedSize;
  try {
    serializedSize = Buffer.byteLength(JSON.stringify(envelope), "utf8");
  } catch {
    return buildPeerMessageReceipt({
      messageId: typeof options.messageId === "string" && isSafeId(options.messageId) ? options.messageId : null,
      dedupKey: typeof options.dedupKey === "string" && isSafeId(options.dedupKey) ? options.dedupKey : null,
      targetPetId: typeof options.targetPetId === "string" && isSafePetId(options.targetPetId) ? options.targetPetId : null,
      sourcePetId: typeof options.sourcePetId === "string" && isSafePetId(options.sourcePetId) ? options.sourcePetId : null,
      status: "rejected",
      reason: "SchemaValidationError: options cannot be serialized to JSON",
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  if (serializedSize > MAX_ENVELOPE_SIZE) {
    return buildPeerMessageReceipt({
      messageId: typeof options.messageId === "string" && isSafeId(options.messageId) ? options.messageId : null,
      dedupKey: typeof options.dedupKey === "string" && isSafeId(options.dedupKey) ? options.dedupKey : null,
      targetPetId: typeof options.targetPetId === "string" && isSafePetId(options.targetPetId) ? options.targetPetId : null,
      sourcePetId: typeof options.sourcePetId === "string" && isSafePetId(options.sourcePetId) ? options.sourcePetId : null,
      status: "rejected",
      reason: "SchemaValidationError: payload exceeds maximum envelope size of 16 KiB",
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  // 2. Validate text (1..2000 characters)
  if (options.text === undefined || typeof options.text !== "string") {
    return buildPeerMessageReceipt({
      messageId: typeof options.messageId === "string" && isSafeId(options.messageId) ? options.messageId : null,
      dedupKey: typeof options.dedupKey === "string" && isSafeId(options.dedupKey) ? options.dedupKey : null,
      targetPetId: typeof options.targetPetId === "string" && isSafePetId(options.targetPetId) ? options.targetPetId : null,
      sourcePetId: typeof options.sourcePetId === "string" && isSafePetId(options.sourcePetId) ? options.sourcePetId : null,
      status: "rejected",
      reason: "SchemaValidationError: text must be a string",
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  if (options.text.length < 1 || options.text.length > MAX_TEXT_LENGTH) {
    return buildPeerMessageReceipt({
      messageId: typeof options.messageId === "string" && isSafeId(options.messageId) ? options.messageId : null,
      dedupKey: typeof options.dedupKey === "string" && isSafeId(options.dedupKey) ? options.dedupKey : null,
      targetPetId: typeof options.targetPetId === "string" && isSafePetId(options.targetPetId) ? options.targetPetId : null,
      sourcePetId: typeof options.sourcePetId === "string" && isSafePetId(options.sourcePetId) ? options.sourcePetId : null,
      status: "rejected",
      reason: `SchemaValidationError: text length must be between 1 and ${MAX_TEXT_LENGTH} characters`,
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  // 3. Validate deliverAs (fixed to 'followUp')
  if (options.deliverAs !== undefined && options.deliverAs !== "followUp") {
    return buildPeerMessageReceipt({
      messageId: typeof options.messageId === "string" && isSafeId(options.messageId) ? options.messageId : null,
      dedupKey: typeof options.dedupKey === "string" && isSafeId(options.dedupKey) ? options.dedupKey : null,
      targetPetId: typeof options.targetPetId === "string" && isSafePetId(options.targetPetId) ? options.targetPetId : null,
      sourcePetId: typeof options.sourcePetId === "string" && isSafePetId(options.sourcePetId) ? options.sourcePetId : null,
      status: "rejected",
      reason: "SchemaValidationError: deliverAs must be 'followUp'",
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  // 4. Validate TTL (1s..300s, default 60s)
  let ttlMs = DEFAULT_PEER_MESSAGE_TTL_MS;
  if (options.ttlMs !== undefined) {
    if (
      typeof options.ttlMs !== "number" ||
      !Number.isSafeInteger(options.ttlMs) ||
      options.ttlMs < MIN_PEER_MESSAGE_TTL_MS ||
      options.ttlMs > MAX_PEER_MESSAGE_TTL_MS
    ) {
      return buildPeerMessageReceipt({
        messageId: typeof options.messageId === "string" && isSafeId(options.messageId) ? options.messageId : null,
        dedupKey: typeof options.dedupKey === "string" && isSafeId(options.dedupKey) ? options.dedupKey : null,
        targetPetId: typeof options.targetPetId === "string" && isSafePetId(options.targetPetId) ? options.targetPetId : null,
        sourcePetId: typeof options.sourcePetId === "string" && isSafePetId(options.sourcePetId) ? options.sourcePetId : null,
        status: "rejected",
        reason: `SchemaValidationError: ttlMs must be a number between ${MIN_PEER_MESSAGE_TTL_MS} and ${MAX_PEER_MESSAGE_TTL_MS}`,
        createdAtMs,
        updatedAtMs: nowMs,
      });
    }
    ttlMs = options.ttlMs;
  }

  // 5. Validate identifier fields (messageId, dedupKey, threadId)
  if (options.messageId !== undefined && !isSafeId(options.messageId)) {
    return buildPeerMessageReceipt({
      messageId: null,
      dedupKey: typeof options.dedupKey === "string" && isSafeId(options.dedupKey) ? options.dedupKey : null,
      targetPetId: typeof options.targetPetId === "string" && isSafePetId(options.targetPetId) ? options.targetPetId : null,
      sourcePetId: typeof options.sourcePetId === "string" && isSafePetId(options.sourcePetId) ? options.sourcePetId : null,
      status: "rejected",
      reason: `SchemaValidationError: messageId must be a non-empty string up to ${MAX_ID_LENGTH} characters matching [A-Za-z0-9_-]`,
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  if (options.dedupKey !== undefined && !isSafeId(options.dedupKey)) {
    return buildPeerMessageReceipt({
      messageId: typeof options.messageId === "string" && isSafeId(options.messageId) ? options.messageId : null,
      dedupKey: null,
      targetPetId: typeof options.targetPetId === "string" && isSafePetId(options.targetPetId) ? options.targetPetId : null,
      sourcePetId: typeof options.sourcePetId === "string" && isSafePetId(options.sourcePetId) ? options.sourcePetId : null,
      status: "rejected",
      reason: `SchemaValidationError: dedupKey must be a non-empty string up to ${MAX_ID_LENGTH} characters matching [A-Za-z0-9_-]`,
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  if (options.threadId !== undefined && !isSafeId(options.threadId)) {
    return buildPeerMessageReceipt({
      messageId: typeof options.messageId === "string" && isSafeId(options.messageId) ? options.messageId : null,
      dedupKey: typeof options.dedupKey === "string" && isSafeId(options.dedupKey) ? options.dedupKey : null,
      targetPetId: typeof options.targetPetId === "string" && isSafePetId(options.targetPetId) ? options.targetPetId : null,
      sourcePetId: typeof options.sourcePetId === "string" && isSafePetId(options.sourcePetId) ? options.sourcePetId : null,
      status: "rejected",
      reason: `SchemaValidationError: threadId must be a non-empty string up to ${MAX_ID_LENGTH} characters matching [A-Za-z0-9_-]`,
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  // 6. Validate thread hop & coordinator fields (0 <= hopCount <= maxHops <= 1)
  const hopCount = options.hopCount !== undefined ? options.hopCount : 0;
  const maxHops = options.maxHops !== undefined ? options.maxHops : 1;

  if (
    typeof hopCount !== "number" ||
    !Number.isInteger(hopCount) ||
    typeof maxHops !== "number" ||
    !Number.isInteger(maxHops) ||
    hopCount < 0 ||
    hopCount > maxHops ||
    maxHops !== 1
  ) {
    return buildPeerMessageReceipt({
      messageId: typeof options.messageId === "string" && isSafeId(options.messageId) ? options.messageId : null,
      dedupKey: typeof options.dedupKey === "string" && isSafeId(options.dedupKey) ? options.dedupKey : null,
      targetPetId: typeof options.targetPetId === "string" && isSafePetId(options.targetPetId) ? options.targetPetId : null,
      sourcePetId: typeof options.sourcePetId === "string" && isSafePetId(options.sourcePetId) ? options.sourcePetId : null,
      status: "rejected",
      reason: "SchemaValidationError: hopCount and maxHops must satisfy 0 <= hopCount <= maxHops <= 1",
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  // Reply handle validation
  let replyHandle = null;
  if (options.replyHandle !== undefined && options.replyHandle !== null) {
    if (hopCount > 0) {
      return buildPeerMessageReceipt({
        messageId: typeof options.messageId === "string" && isSafeId(options.messageId) ? options.messageId : null,
        dedupKey: typeof options.dedupKey === "string" && isSafeId(options.dedupKey) ? options.dedupKey : null,
        targetPetId: typeof options.targetPetId === "string" && isSafePetId(options.targetPetId) ? options.targetPetId : null,
        sourcePetId: typeof options.sourcePetId === "string" && isSafePetId(options.sourcePetId) ? options.sourcePetId : null,
        status: "rejected",
        reason: "SchemaValidationError: reply message (hopCount > 0) cannot specify a replyHandle",
        createdAtMs,
        updatedAtMs: nowMs,
      });
    }
    if (
      typeof options.replyHandle !== "string"
      || !/^psh_[A-Za-z0-9_-]{1,124}$/.test(options.replyHandle)
    ) {
      return buildPeerMessageReceipt({
        messageId: typeof options.messageId === "string" && isSafeId(options.messageId) ? options.messageId : null,
        dedupKey: typeof options.dedupKey === "string" && isSafeId(options.dedupKey) ? options.dedupKey : null,
        targetPetId: typeof options.targetPetId === "string" && isSafePetId(options.targetPetId) ? options.targetPetId : null,
        sourcePetId: typeof options.sourcePetId === "string" && isSafePetId(options.sourcePetId) ? options.sourcePetId : null,
        status: "rejected",
        reason: "SchemaValidationError: replyHandle must be a safe psh_ opaque handle up to 128 characters or null",
        createdAtMs,
        updatedAtMs: nowMs,
      });
    }
    replyHandle = options.replyHandle;
  }

  // 7. Validate sender provenance (contract field sourcePetId, no aliases)
  if (!options.sourcePetId || typeof options.sourcePetId !== "string") {
    return buildPeerMessageReceipt({
      messageId: typeof options.messageId === "string" && isSafeId(options.messageId) ? options.messageId : null,
      dedupKey: typeof options.dedupKey === "string" && isSafeId(options.dedupKey) ? options.dedupKey : null,
      targetPetId: typeof options.targetPetId === "string" && isSafePetId(options.targetPetId) ? options.targetPetId : null,
      sourcePetId: null,
      status: "rejected",
      reason: "InvalidPetIdentity: source session identity is required",
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  if (!isSafePetId(options.sourcePetId)) {
    return buildPeerMessageReceipt({
      messageId: typeof options.messageId === "string" && isSafeId(options.messageId) ? options.messageId : null,
      dedupKey: typeof options.dedupKey === "string" && isSafeId(options.dedupKey) ? options.dedupKey : null,
      targetPetId: typeof options.targetPetId === "string" && isSafePetId(options.targetPetId) ? options.targetPetId : null,
      sourcePetId: String(options.sourcePetId).slice(0, MAX_ID_LENGTH),
      status: "rejected",
      reason: "InvalidPetIdentity: malformed source petId or path traversal detected",
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }
  const sourcePetId = options.sourcePetId;

  if (
    options.sourceDisplayName === undefined ||
    typeof options.sourceDisplayName !== "string" ||
    options.sourceDisplayName.trim().length < 1 ||
    options.sourceDisplayName.length > 128 ||
    /[\0\r\n]/.test(options.sourceDisplayName)
  ) {
    return buildPeerMessageReceipt({
      messageId: typeof options.messageId === "string" && isSafeId(options.messageId) ? options.messageId : null,
      dedupKey: typeof options.dedupKey === "string" && isSafeId(options.dedupKey) ? options.dedupKey : null,
      targetPetId: typeof options.targetPetId === "string" && isSafePetId(options.targetPetId) ? options.targetPetId : null,
      sourcePetId,
      status: "rejected",
      reason: "SchemaValidationError: sourceDisplayName must be a non-empty string up to 128 characters",
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }
  const sourceDisplayName = options.sourceDisplayName.trim();

  if (
    options.sourceHost === undefined ||
    typeof options.sourceHost !== "string" ||
    options.sourceHost.trim().length < 1 ||
    options.sourceHost.length > 128 ||
    /[\0\r\n]/.test(options.sourceHost)
  ) {
    return buildPeerMessageReceipt({
      messageId: typeof options.messageId === "string" && isSafeId(options.messageId) ? options.messageId : null,
      dedupKey: typeof options.dedupKey === "string" && isSafeId(options.dedupKey) ? options.dedupKey : null,
      targetPetId: typeof options.targetPetId === "string" && isSafePetId(options.targetPetId) ? options.targetPetId : null,
      sourcePetId,
      sourceDisplayName,
      status: "rejected",
      reason: "SchemaValidationError: sourceHost must be a non-empty string up to 128 characters",
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }
  const sourceHost = options.sourceHost.trim();

  // 8. Validate targetPetId (contract field targetPetId, no aliases)
  if (!options.targetPetId || typeof options.targetPetId !== "string") {
    return buildPeerMessageReceipt({
      messageId: typeof options.messageId === "string" && isSafeId(options.messageId) ? options.messageId : null,
      dedupKey: typeof options.dedupKey === "string" && isSafeId(options.dedupKey) ? options.dedupKey : null,
      targetPetId: null,
      sourcePetId,
      sourceDisplayName,
      sourceHost,
      status: "rejected",
      reason: "InvalidPetIdentity: target session identity is required",
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  if (!isSafePetId(options.targetPetId)) {
    return buildPeerMessageReceipt({
      messageId: typeof options.messageId === "string" && isSafeId(options.messageId) ? options.messageId : null,
      dedupKey: typeof options.dedupKey === "string" && isSafeId(options.dedupKey) ? options.dedupKey : null,
      targetPetId: String(options.targetPetId).slice(0, MAX_ID_LENGTH),
      sourcePetId,
      sourceDisplayName,
      sourceHost,
      status: "rejected",
      reason: "InvalidPetIdentity: malformed target petId or path traversal detected",
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }
  const targetPetId = options.targetPetId;
  if (targetPetId === sourcePetId) {
    return buildPeerMessageReceipt({
      messageId: typeof options.messageId === "string" && isSafeId(options.messageId) ? options.messageId : null,
      dedupKey: typeof options.dedupKey === "string" && isSafeId(options.dedupKey) ? options.dedupKey : null,
      targetPetId,
      sourcePetId,
      sourceDisplayName,
      sourceHost,
      status: "rejected",
      reason: "PeerSelfSendRejected: source and target must be different sessions",
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  // 9. Resolve directories
  const dataDir = resolveDataDir(options, env);
  const statusDir = path.join(dataDir, "status");
  const receiptsDir = path.join(dataDir, "receipts");
  const peerInboxPetDir = path.join(dataDir, "peer-inbox", targetPetId);
  const pendingDir = path.join(peerInboxPetDir, "pending");
  const claimedDir = path.join(peerInboxPetDir, "claimed");

  // 10. Active session verification (target status)
  const statusPath = path.join(statusDir, `status-${targetPetId}.json`);
  if (!fsApi.existsSync(statusPath)) {
    return buildPeerMessageReceipt({
      messageId: typeof options.messageId === "string" && isSafeId(options.messageId) ? options.messageId : null,
      dedupKey: typeof options.dedupKey === "string" && isSafeId(options.dedupKey) ? options.dedupKey : null,
      targetPetId,
      sourcePetId,
      sourceDisplayName,
      sourceHost,
      status: "rejected",
      reason: `UnknownPetIdentity: active session status file not found for ${targetPetId}`,
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  let statusData;
  try {
    const rawStatus = fsApi.readFileSync(statusPath, "utf8");
    statusData = JSON.parse(rawStatus);
  } catch (err) {
    return buildPeerMessageReceipt({
      messageId: typeof options.messageId === "string" && isSafeId(options.messageId) ? options.messageId : null,
      dedupKey: typeof options.dedupKey === "string" && isSafeId(options.dedupKey) ? options.dedupKey : null,
      targetPetId,
      sourcePetId,
      sourceDisplayName,
      sourceHost,
      status: "rejected",
      reason: `UnknownPetIdentity: failed to parse active session status file: ${err.message}`,
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  if (!statusData || statusData.state === "closed") {
    return buildPeerMessageReceipt({
      messageId: typeof options.messageId === "string" && isSafeId(options.messageId) ? options.messageId : null,
      dedupKey: typeof options.dedupKey === "string" && isSafeId(options.dedupKey) ? options.dedupKey : null,
      targetPetId,
      sourcePetId,
      sourceDisplayName,
      sourceHost,
      status: "rejected",
      reason: "SessionClosed: session is closed",
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  if (statusData.state === "offline") {
    return buildPeerMessageReceipt({
      messageId: typeof options.messageId === "string" && isSafeId(options.messageId) ? options.messageId : null,
      dedupKey: typeof options.dedupKey === "string" && isSafeId(options.dedupKey) ? options.dedupKey : null,
      targetPetId,
      sourcePetId,
      sourceDisplayName,
      sourceHost,
      status: "rejected",
      reason: "SessionOffline: session is offline",
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  // 11. Check TTL expiration at ingestion
  if (createdAtMs + ttlMs < nowMs) {
    return buildPeerMessageReceipt({
      messageId: typeof options.messageId === "string" && isSafeId(options.messageId) ? options.messageId : null,
      dedupKey: typeof options.dedupKey === "string" && isSafeId(options.dedupKey) ? options.dedupKey : null,
      targetPetId,
      sourcePetId,
      sourceDisplayName,
      sourceHost,
      status: "expired",
      reason: "Message expired before processing",
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  // 12. Message & dedup identity & threadId
  const messageId = options.messageId || crypto.randomUUID();
  const dedupKey = options.dedupKey || messageId;
  const threadId = options.threadId || `thr_${messageId}`;

  // 13. Deduplication check against persisted peer-message receipts (rcpt-peer-* ONLY)
  // Strict triplet binding (sourcePetId, targetPetId, dedupKey) and messageId conflict
  try {
    fsApi.mkdirSync(receiptsDir, { recursive: true });
    const entries = fsApi.readdirSync(receiptsDir);
    for (const file of entries) {
      if (!file.startsWith("rcpt-peer-") || !file.endsWith(".json")) continue;
      const filePath = path.join(receiptsDir, file);
      try {
        const content = fsApi.readFileSync(filePath, "utf8");
        const rcpt = JSON.parse(content);

        const rcptTime = rcpt.createdAtMs || rcpt.updatedAtMs || 0;
        if (rcptTime > 0 && nowMs - rcptTime > GC_WINDOW_MS) {
          try { fsApi.unlinkSync(filePath); } catch {}
          continue;
        }

        // MessageId conflict check
        if (file === `rcpt-peer-${messageId}.json` || rcpt.messageId === messageId) {
          if (rcpt.sourcePetId !== sourcePetId || rcpt.targetPetId !== targetPetId) {
            return buildPeerMessageReceipt({
              messageId,
              dedupKey,
              targetPetId,
              sourcePetId,
              sourceDisplayName,
              sourceHost,
              status: "rejected",
              reason: `MessageIdConflict: messageId "${messageId}" already exists for a different source or target pet`,
              createdAtMs,
              updatedAtMs: nowMs,
            });
          }
          return rcpt;
        }

        // Triplet dedup check: (source, target, dedupKey)
        if (
          rcpt.sourcePetId === sourcePetId &&
          rcpt.targetPetId === targetPetId &&
          rcpt.dedupKey === dedupKey
        ) {
          return rcpt;
        }
      } catch {
        // Skip unreadable receipts
      }
    }
  } catch {
    // Ignore scan errors
  }

  // 14. Check peer inbox queue capacity (cap pending + claimed at 16, reject newest)
  fsApi.mkdirSync(pendingDir, { recursive: true });
  fsApi.mkdirSync(claimedDir, { recursive: true });

  let pendingCount = 0;
  let claimedCount = 0;
  try {
    const pendingEntries = fsApi.readdirSync(pendingDir);
    pendingCount = pendingEntries.filter((f) => f.endsWith(".json") && !f.endsWith(".tmp") && !f.endsWith(".quarantine")).length;
  } catch {}

  try {
    const claimedEntries = fsApi.readdirSync(claimedDir);
    claimedCount = claimedEntries.filter((f) => f.endsWith(".json") && !f.endsWith(".tmp")).length;
  } catch {}

  if (pendingCount + claimedCount >= MAX_PEER_INBOX_QUEUE_CAPACITY) {
    return buildPeerMessageReceipt({
      messageId,
      dedupKey,
      targetPetId,
      sourcePetId,
      sourceDisplayName,
      sourceHost,
      status: "rejected",
      reason: `QueueCapacityExceeded: peer inbox queue capacity limit of ${MAX_PEER_INBOX_QUEUE_CAPACITY} reached`,
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  // 15. Construct PeerMessage and initial PeerMessageReceipt ('queued')
  const expiresAtMs = createdAtMs + ttlMs;

  const peerMessage = {
    schemaVersion: "1",
    kind: "peer_message",
    messageId,
    dedupKey,
    targetPetId,
    sourcePetId,
    sourceDisplayName,
    sourceHost,
    text: options.text,
    deliverAs: "followUp",
    threadId,
    hopCount,
    maxHops,
    replyHandle,
    createdAtMs,
    expiresAtMs,
  };

  const receipt = buildPeerMessageReceipt({
    messageId,
    dedupKey,
    targetPetId,
    sourcePetId,
    sourceDisplayName,
    sourceHost,
    status: "queued",
    reason: null,
    text: options.text,
    deliverAs: "followUp",
    threadId,
    hopCount,
    maxHops,
    replyHandle,
    createdAtMs,
    updatedAtMs: nowMs,
    expiresAtMs,
  });

  // 16. Persist pending message file and initial receipt
  const pendingFileName = `${String(createdAtMs).padStart(16, "0")}-${messageId}.json`;
  const pendingFilePath = path.join(pendingDir, pendingFileName);
  const receiptPath = path.join(receiptsDir, `rcpt-peer-${messageId}.json`);

  try {
    atomicWriteJson(pendingFilePath, peerMessage, fsApi);
  } catch (err) {
    return buildPeerMessageReceipt({
      messageId,
      dedupKey,
      targetPetId,
      sourcePetId,
      sourceDisplayName,
      sourceHost,
      status: "failed",
      reason: `IO failure writing pending message: ${err.message}`,
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  try {
    atomicWriteJson(receiptPath, receipt, fsApi);
  } catch (err) {
    // If pending write succeeds but receipt write fails, delete pending before returning failed
    try {
      if (fsApi.existsSync(pendingFilePath)) {
        fsApi.unlinkSync(pendingFilePath);
      }
    } catch {}
    return buildPeerMessageReceipt({
      messageId,
      dedupKey,
      targetPetId,
      sourcePetId,
      sourceDisplayName,
      sourceHost,
      status: "failed",
      reason: `IO failure writing initial receipt: ${err.message}`,
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  return receipt;
}

function claimNextPeerMessage(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return null;
  }

  if (!options.targetPetId || typeof options.targetPetId !== "string" || !isSafePetId(options.targetPetId)) {
    return null;
  }
  const targetPetId = options.targetPetId;

  const fsApi = options.fsApi || fs;
  const env = options.env || process.env;
  const nowMs = typeof options.now === "function" ? options.now() : Date.now();

  const dataDir = resolveDataDir(options, env);
  const peerInboxPetDir = path.join(dataDir, "peer-inbox", targetPetId);
  const pendingDir = path.join(peerInboxPetDir, "pending");
  const claimedDir = path.join(peerInboxPetDir, "claimed");
  const receiptsDir = path.join(dataDir, "receipts");

  fsApi.mkdirSync(pendingDir, { recursive: true });
  fsApi.mkdirSync(claimedDir, { recursive: true });
  fsApi.mkdirSync(receiptsDir, { recursive: true });

  // 1. Clean up stale claimed items older than 60s (terminal failed/delivery-unknown, NEVER requeued)
  cleanupStalePeerClaims({ fsApi, claimedDir, receiptsDir, targetPetId, nowMs });

  // 2. Scan pending items in FIFO order
  let pendingEntries = [];
  try {
    pendingEntries = fsApi.readdirSync(pendingDir)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".tmp") && !f.endsWith(".quarantine"))
      .sort();
  } catch {
    return null;
  }

  for (const entry of pendingEntries) {
    const pendingFilePath = path.join(pendingDir, entry);

    // Read candidate message before claiming
    let candidateData;
    try {
      const rawContent = fsApi.readFileSync(pendingFilePath, "utf8");
      candidateData = JSON.parse(rawContent);
    } catch {
      quarantinePendingCandidate(fsApi, pendingDir, entry);
      continue;
    }

    if (!candidateData || typeof candidateData !== "object" || Array.isArray(candidateData)) {
      quarantinePendingCandidate(fsApi, pendingDir, entry);
      continue;
    }

    // Validate on-disk candidate messageId and targetPetId
    let candidateMessageId;
    if (candidateData.messageId !== undefined) {
      if (typeof candidateData.messageId !== "string" || !isSafeId(candidateData.messageId)) {
        quarantinePendingCandidate(fsApi, pendingDir, entry);
        continue;
      }
      candidateMessageId = candidateData.messageId;
    } else {
      const match = entry.match(/^\d{1,20}-([A-Za-z0-9_-]{1,64})\.json$/);
      if (match && isSafeId(match[1])) {
        candidateMessageId = match[1];
      } else {
        quarantinePendingCandidate(fsApi, pendingDir, entry);
        continue;
      }
    }

    let candidateTargetPetId = candidateData.targetPetId;
    if (candidateTargetPetId !== undefined) {
      if (typeof candidateTargetPetId !== "string" || !isSafePetId(candidateTargetPetId) || candidateTargetPetId !== targetPetId) {
        quarantinePendingCandidate(fsApi, pendingDir, entry);
        continue;
      }
    } else {
      candidateTargetPetId = targetPetId;
    }

    // Validate source provenance in candidate
    if (
      typeof candidateData.sourcePetId !== "string" ||
      !isSafePetId(candidateData.sourcePetId) ||
      typeof candidateData.sourceDisplayName !== "string" ||
      candidateData.sourceDisplayName.trim().length < 1 ||
      candidateData.sourceDisplayName.length > 128 ||
      typeof candidateData.sourceHost !== "string" ||
      candidateData.sourceHost.trim().length < 1 ||
      candidateData.sourceHost.length > 128
    ) {
      quarantinePendingCandidate(fsApi, pendingDir, entry);
      continue;
    }

    // Validate text
    if (
      typeof candidateData.text !== "string" ||
      candidateData.text.length < 1 ||
      candidateData.text.length > MAX_TEXT_LENGTH
    ) {
      quarantinePendingCandidate(fsApi, pendingDir, entry);
      continue;
    }

    // Validate deliverAs
    if (candidateData.deliverAs !== undefined && candidateData.deliverAs !== "followUp") {
      quarantinePendingCandidate(fsApi, pendingDir, entry);
      continue;
    }

    // Validate hopCount and maxHops
    const hopCount = typeof candidateData.hopCount === "number" ? candidateData.hopCount : 0;
    const maxHops = typeof candidateData.maxHops === "number" ? candidateData.maxHops : 1;
    if (
      !Number.isInteger(hopCount) ||
      !Number.isInteger(maxHops) ||
      hopCount < 0 ||
      hopCount > maxHops ||
      maxHops !== 1
    ) {
      quarantinePendingCandidate(fsApi, pendingDir, entry);
      continue;
    }

    // Validate threadId
    const threadId = typeof candidateData.threadId === "string" && isSafeId(candidateData.threadId)
      ? candidateData.threadId
      : `thr_${candidateMessageId}`;

    const replyHandle = typeof candidateData.replyHandle === "string" ? candidateData.replyHandle : null;
    if (hopCount > 0 && replyHandle !== null) {
      quarantinePendingCandidate(fsApi, pendingDir, entry);
      continue;
    }

    const dedupKey = typeof candidateData.dedupKey === "string" && isSafeId(candidateData.dedupKey)
      ? candidateData.dedupKey
      : candidateMessageId;

    const createdAtMs = typeof candidateData.createdAtMs === "number" ? candidateData.createdAtMs : nowMs;
    const expiresAtMs = typeof candidateData.expiresAtMs === "number"
      ? candidateData.expiresAtMs
      : createdAtMs + DEFAULT_PEER_MESSAGE_TTL_MS;

    const claimedFilePath = path.join(claimedDir, `${candidateMessageId}.json`);

    // Atomically rename pending directly to claimed/<messageId>.json (no orphan temp window)
    try {
      fsApi.renameSync(pendingFilePath, claimedFilePath);
    } catch {
      // Another worker claimed this pending file concurrently, or collision
      continue;
    }

    // Check if candidate message is already expired
    if (expiresAtMs <= nowMs) {
      const rcptPath = path.join(receiptsDir, `rcpt-peer-${candidateMessageId}.json`);
      const expiredReceipt = buildPeerMessageReceipt({
        messageId: candidateMessageId,
        dedupKey,
        targetPetId: candidateTargetPetId,
        sourcePetId: candidateData.sourcePetId,
        sourceDisplayName: candidateData.sourceDisplayName,
        sourceHost: candidateData.sourceHost,
        status: "expired",
        reason: "Message expired in queue before delivery",
        text: candidateData.text,
        deliverAs: "followUp",
        threadId,
        hopCount,
        maxHops,
        replyHandle,
        createdAtMs,
        updatedAtMs: nowMs,
        expiresAtMs,
      });

      // Persist terminal receipt before unlinking claim; if receipt write fails, leave claim
      try {
        atomicWriteJson(rcptPath, expiredReceipt, fsApi);
        try { fsApi.unlinkSync(claimedFilePath); } catch {}
      } catch {
        // Leave claim if receipt write fails
      }
      continue;
    }

    // Valid claim: generate claimToken and overwrite claimed file with claim metadata
    const claimToken = crypto.randomUUID();
    const claimedRecord = {
      schemaVersion: "1",
      kind: "peer_message",
      messageId: candidateMessageId,
      dedupKey,
      targetPetId: candidateTargetPetId,
      sourcePetId: candidateData.sourcePetId,
      sourceDisplayName: candidateData.sourceDisplayName,
      sourceHost: candidateData.sourceHost,
      text: candidateData.text,
      deliverAs: "followUp",
      threadId,
      hopCount,
      maxHops,
      replyHandle,
      createdAtMs,
      expiresAtMs,
      claimToken,
      claimedAtMs: nowMs,
    };
    atomicWriteJson(claimedFilePath, claimedRecord, fsApi);

    return {
      schemaVersion: "1",
      kind: "peer_message",
      messageId: candidateMessageId,
      dedupKey,
      targetPetId: candidateTargetPetId,
      sourcePetId: candidateData.sourcePetId,
      sourceDisplayName: candidateData.sourceDisplayName,
      sourceHost: candidateData.sourceHost,
      text: candidateData.text,
      deliverAs: "followUp",
      threadId,
      hopCount,
      maxHops,
      replyHandle,
      createdAtMs,
      expiresAtMs,
      claimToken,
      claimedAtMs: nowMs,
      message: {
        schemaVersion: "1",
        kind: "peer_message",
        messageId: candidateMessageId,
        dedupKey,
        targetPetId: candidateTargetPetId,
        sourcePetId: candidateData.sourcePetId,
        sourceDisplayName: candidateData.sourceDisplayName,
        sourceHost: candidateData.sourceHost,
        text: candidateData.text,
        deliverAs: "followUp",
        threadId,
        hopCount,
        maxHops,
        replyHandle,
        createdAtMs,
        expiresAtMs,
      },
    };
  }

  return null;
}

function settlePeerMessage(options = {}) {
  const nowMs = typeof options?.now === "function" ? options.now() : Date.now();
  const fsApi = options?.fsApi || fs;
  const env = options?.env || process.env;

  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return buildPeerMessageReceipt({
      messageId: null,
      dedupKey: null,
      targetPetId: null,
      status: "rejected",
      reason: "SchemaValidationError: options must be an object",
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  }

  // 1. Envelope size validation
  const envelope = extractWireEnvelope(options, PEER_SETTLE_WIRE_FIELDS);
  let serializedSize;
  try {
    serializedSize = Buffer.byteLength(JSON.stringify(envelope), "utf8");
  } catch {
    return buildPeerMessageReceipt({
      messageId: typeof options.messageId === "string" && isSafeId(options.messageId) ? options.messageId : null,
      dedupKey: null,
      targetPetId: typeof options.targetPetId === "string" && isSafePetId(options.targetPetId) ? options.targetPetId : null,
      status: "rejected",
      reason: "SchemaValidationError: options cannot be serialized to JSON",
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  }

  if (serializedSize > MAX_ENVELOPE_SIZE) {
    return buildPeerMessageReceipt({
      messageId: typeof options.messageId === "string" && isSafeId(options.messageId) ? options.messageId : null,
      dedupKey: null,
      targetPetId: typeof options.targetPetId === "string" && isSafePetId(options.targetPetId) ? options.targetPetId : null,
      status: "rejected",
      reason: "SchemaValidationError: payload exceeds maximum envelope size of 16 KiB",
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  }

  // 2. Validate messageId (contract field messageId, no aliases)
  if (!options.messageId || typeof options.messageId !== "string" || !isSafeId(options.messageId)) {
    return buildPeerMessageReceipt({
      messageId: null,
      dedupKey: null,
      targetPetId: typeof options.targetPetId === "string" && isSafePetId(options.targetPetId) ? options.targetPetId : null,
      status: "rejected",
      reason: `SchemaValidationError: messageId is required and must match [A-Za-z0-9_-]{1,${MAX_ID_LENGTH}}`,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  }
  const messageId = options.messageId;

  // 3. Validate claimToken
  if (!options.claimToken || typeof options.claimToken !== "string" || options.claimToken.trim().length === 0) {
    return buildPeerMessageReceipt({
      messageId,
      dedupKey: null,
      targetPetId: typeof options.targetPetId === "string" && isSafePetId(options.targetPetId) ? options.targetPetId : null,
      status: "rejected",
      reason: "SchemaValidationError: claimToken is required",
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  }

  // 4. Validate status (terminal status may be dispatched, failed, expired; never call it delivered)
  if (options.status === "delivered") {
    return buildPeerMessageReceipt({
      messageId,
      dedupKey: null,
      targetPetId: typeof options.targetPetId === "string" && isSafePetId(options.targetPetId) ? options.targetPetId : null,
      status: "rejected",
      reason: "SchemaValidationError: Invalid settle status 'delivered'. Settle terminal status must be one of: dispatched, failed, expired",
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  }

  if (!options.status || !VALID_SETTLE_STATUSES.has(options.status)) {
    return buildPeerMessageReceipt({
      messageId,
      dedupKey: null,
      targetPetId: typeof options.targetPetId === "string" && isSafePetId(options.targetPetId) ? options.targetPetId : null,
      status: "rejected",
      reason: `SchemaValidationError: status must be one of: ${Array.from(VALID_SETTLE_STATUSES).join(", ")}`,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  }

  // 5. Validate reason: only string | null, max length 1024, other types rejected
  let settleReason = null;
  if (options.reason !== undefined) {
    if (options.reason === null) {
      settleReason = null;
    } else if (typeof options.reason === "string") {
      if (options.reason.length > MAX_REASON_LENGTH) {
        return buildPeerMessageReceipt({
          messageId,
          dedupKey: null,
          targetPetId: typeof options.targetPetId === "string" && isSafePetId(options.targetPetId) ? options.targetPetId : null,
          status: "rejected",
          reason: `SchemaValidationError: settle reason length must be at most ${MAX_REASON_LENGTH} characters`,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        });
      }
      settleReason = options.reason;
    } else {
      return buildPeerMessageReceipt({
        messageId,
        dedupKey: null,
        targetPetId: typeof options.targetPetId === "string" && isSafePetId(options.targetPetId) ? options.targetPetId : null,
        status: "rejected",
        reason: "SchemaValidationError: settle reason must be a string or null",
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      });
    }
  }

  // 6. Validate targetPetId (contract field targetPetId, no aliases)
  if (!options.targetPetId || typeof options.targetPetId !== "string" || !isSafePetId(options.targetPetId)) {
    return buildPeerMessageReceipt({
      messageId,
      dedupKey: null,
      targetPetId: typeof options.targetPetId === "string" ? String(options.targetPetId).slice(0, MAX_ID_LENGTH) : null,
      status: "rejected",
      reason: "InvalidPetIdentity: target session identity is required",
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  }
  const targetPetId = options.targetPetId;

  // 7. Resolve paths
  const dataDir = resolveDataDir(options, env);
  const peerInboxPetDir = path.join(dataDir, "peer-inbox", targetPetId);
  const claimedDir = path.join(peerInboxPetDir, "claimed");
  const receiptsDir = path.join(dataDir, "receipts");

  const claimedFilePath = path.join(claimedDir, `${messageId}.json`);
  const receiptPath = path.join(receiptsDir, `rcpt-peer-${messageId}.json`);

  if (!fsApi.existsSync(claimedFilePath)) {
    return buildPeerMessageReceipt({
      messageId,
      dedupKey: null,
      targetPetId,
      status: "rejected",
      reason: `ClaimNotFound: no active claim found for messageId "${messageId}"`,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  }

  let claimedData;
  try {
    const rawClaimed = fsApi.readFileSync(claimedFilePath, "utf8");
    claimedData = JSON.parse(rawClaimed);
  } catch (err) {
    return buildPeerMessageReceipt({
      messageId,
      dedupKey: null,
      targetPetId,
      status: "failed",
      reason: `IO failure reading claimed file: ${err.message}`,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  }

  // 8. Validate claimToken match
  if (claimedData.claimToken !== options.claimToken) {
    return buildPeerMessageReceipt({
      messageId,
      dedupKey: claimedData.dedupKey || null,
      targetPetId,
      sourcePetId: claimedData.sourcePetId || null,
      sourceDisplayName: claimedData.sourceDisplayName || null,
      sourceHost: claimedData.sourceHost || null,
      status: "rejected",
      reason: "InvalidClaimToken: claimToken does not match active claim",
      createdAtMs: claimedData.createdAtMs || nowMs,
      updatedAtMs: nowMs,
    });
  }

  // 9. Check stale claim (>60s) — only if claimedAtMs is safe integer
  if (
    typeof claimedData.claimedAtMs === "number" &&
    Number.isSafeInteger(claimedData.claimedAtMs) &&
    claimedData.claimedAtMs > 0 &&
    nowMs - claimedData.claimedAtMs > PEER_CLAIM_TIMEOUT_MS
  ) {
    // Check if a terminal receipt already exists
    let existingTerminal = false;
    let existingRcpt = null;
    try {
      if (fsApi.existsSync(receiptPath)) {
        existingRcpt = JSON.parse(fsApi.readFileSync(receiptPath, "utf8"));
        if (
          existingRcpt.status === "dispatched" ||
          existingRcpt.status === "failed" ||
          existingRcpt.status === "expired" ||
          existingRcpt.status === "rejected"
        ) {
          existingTerminal = true;
        }
      }
    } catch {}

    if (existingTerminal) {
      try { fsApi.unlinkSync(claimedFilePath); } catch {}
      return existingRcpt;
    }

    const failedReceipt = buildPeerMessageReceipt({
      messageId: claimedData.messageId || messageId,
      dedupKey: claimedData.dedupKey || null,
      targetPetId: claimedData.targetPetId || targetPetId,
      sourcePetId: claimedData.sourcePetId || null,
      sourceDisplayName: claimedData.sourceDisplayName || null,
      sourceHost: claimedData.sourceHost || null,
      status: "failed",
      reason: "Claim expired: stale claimed item older than 60s (delivery-unknown)",
      text: claimedData.text,
      deliverAs: "followUp",
      threadId: claimedData.threadId || null,
      hopCount: claimedData.hopCount !== undefined ? claimedData.hopCount : 0,
      maxHops: claimedData.maxHops !== undefined ? claimedData.maxHops : 1,
      replyHandle: claimedData.replyHandle || null,
      createdAtMs: claimedData.createdAtMs,
      updatedAtMs: nowMs,
      expiresAtMs: claimedData.expiresAtMs,
    });

    try {
      atomicWriteJson(receiptPath, failedReceipt, fsApi);
      try { fsApi.unlinkSync(claimedFilePath); } catch {}
    } catch (err) {
      return buildPeerMessageReceipt({
        messageId: claimedData.messageId || messageId,
        dedupKey: claimedData.dedupKey || null,
        targetPetId: claimedData.targetPetId || targetPetId,
        sourcePetId: claimedData.sourcePetId || null,
        sourceDisplayName: claimedData.sourceDisplayName || null,
        sourceHost: claimedData.sourceHost || null,
        status: "failed",
        reason: `IO failure writing expired claim receipt: ${err.message}`,
        createdAtMs: claimedData.createdAtMs,
        updatedAtMs: nowMs,
      });
    }
    return failedReceipt;
  }

  // 10. Normal settle: persist terminal receipt before unlinking claim; if receipt write fails, leave claim
  try {
    if (fsApi.existsSync(receiptPath)) {
      const existingRcpt = JSON.parse(fsApi.readFileSync(receiptPath, "utf8"));
      if (
        existingRcpt.status === "dispatched" ||
        existingRcpt.status === "failed" ||
        existingRcpt.status === "expired" ||
        existingRcpt.status === "rejected"
      ) {
        try { fsApi.unlinkSync(claimedFilePath); } catch {}
        return existingRcpt;
      }
    }
  } catch {}

  const receipt = buildPeerMessageReceipt({
    messageId: claimedData.messageId || messageId,
    dedupKey: claimedData.dedupKey || null,
    targetPetId: claimedData.targetPetId || targetPetId,
    sourcePetId: claimedData.sourcePetId || null,
    sourceDisplayName: claimedData.sourceDisplayName || null,
    sourceHost: claimedData.sourceHost || null,
    status: options.status,
    reason: settleReason,
    text: claimedData.text,
    deliverAs: "followUp",
    threadId: claimedData.threadId || null,
    hopCount: claimedData.hopCount !== undefined ? claimedData.hopCount : 0,
    maxHops: claimedData.maxHops !== undefined ? claimedData.maxHops : 1,
    replyHandle: claimedData.replyHandle || null,
    createdAtMs: claimedData.createdAtMs,
    updatedAtMs: nowMs,
    expiresAtMs: claimedData.expiresAtMs,
  });

  try {
    atomicWriteJson(receiptPath, receipt, fsApi);
  } catch (err) {
    return buildPeerMessageReceipt({
      messageId: claimedData.messageId || messageId,
      dedupKey: claimedData.dedupKey || null,
      targetPetId: claimedData.targetPetId || targetPetId,
      sourcePetId: claimedData.sourcePetId || null,
      sourceDisplayName: claimedData.sourceDisplayName || null,
      sourceHost: claimedData.sourceHost || null,
      status: "failed",
      reason: `IO failure writing settled receipt: ${err.message}`,
      createdAtMs: claimedData.createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  if (receipt.status === "dispatched" && typeof options?.onDispatched === "function") {
    try {
      const cbResult = options.onDispatched(receipt);
      if (cbResult && typeof cbResult.then === "function") {
        if (typeof cbResult.catch === "function") {
          cbResult.catch(() => {});
        } else {
          cbResult.then(null, () => {});
        }
      }
    } catch {
      // Callback error must be swallowed and must not alter dispatched receipt.
    }
  }

  try { fsApi.unlinkSync(claimedFilePath); } catch {}

  return receipt;
}

function getPeerMessageReceipt(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return null;
  }

  // Fail-closed requirement: caller source identity is required
  if (!options.sourcePetId || typeof options.sourcePetId !== "string" || !isSafePetId(options.sourcePetId)) {
    return null;
  }
  const callerSourcePetId = options.sourcePetId;

  if (!options.messageId || typeof options.messageId !== "string" || !isSafeId(options.messageId)) {
    return null;
  }
  const messageId = options.messageId;

  const fsApi = options.fsApi || fs;
  const env = options.env || process.env;
  const nowMs = typeof options.now === "function" ? options.now() : Date.now();

  const dataDir = resolveDataDir(options, env);
  const receiptsDir = path.join(dataDir, "receipts");
  const rcptPath = path.join(receiptsDir, `rcpt-peer-${messageId}.json`);

  let rcpt;
  try {
    if (!fsApi.existsSync(rcptPath)) {
      return null;
    }
    const rawRcpt = fsApi.readFileSync(rcptPath, "utf8");
    rcpt = JSON.parse(rawRcpt);
    if (!rcpt || typeof rcpt !== "object" || Array.isArray(rcpt)) {
      return null;
    }
    if (rcpt.messageId !== messageId) {
      return null;
    }
  } catch {
    return null;
  }

  // Only allow caller sourcePetId === receipt.sourcePetId (target cannot read, no identity cannot read)
  if (rcpt.sourcePetId !== callerSourcePetId) {
    return null;
  }

  const targetPetId = rcpt.targetPetId;
  if (!targetPetId || !isSafePetId(targetPetId)) {
    return rcpt;
  }

  const peerInboxPetDir = path.join(dataDir, "peer-inbox", targetPetId);
  const pendingDir = path.join(peerInboxPetDir, "pending");
  const claimedDir = path.join(peerInboxPetDir, "claimed");

  // Clean up stale claimed items for this target before reading receipt
  cleanupStalePeerClaims({ fsApi, claimedDir, receiptsDir, targetPetId, nowMs });

  // Re-read receipt in case stale claim cleanup updated it, then re-apply
  // sender authorization so a concurrent replacement cannot cross identity.
  try {
    if (fsApi.existsSync(rcptPath)) {
      const refreshed = JSON.parse(fsApi.readFileSync(rcptPath, "utf8"));
      if (
        !refreshed
        || typeof refreshed !== "object"
        || Array.isArray(refreshed)
        || refreshed.messageId !== messageId
        || refreshed.sourcePetId !== callerSourcePetId
      ) {
        return null;
      }
      rcpt = refreshed;
    }
  } catch {
    return null;
  }

  // If receipt is queued and expired, check if message is still pending and expire it atomically
  if (rcpt.status === "queued" && typeof rcpt.expiresAtMs === "number" && rcpt.expiresAtMs <= nowMs) {
    let pendingEntry = null;
    try {
      if (fsApi.existsSync(pendingDir)) {
        const entries = fsApi.readdirSync(pendingDir);
        for (const entry of entries) {
          if (!entry.endsWith(".json") || entry.endsWith(".tmp") || entry.endsWith(".quarantine")) continue;
          if (entry.endsWith(`-${messageId}.json`)) {
            pendingEntry = entry;
            break;
          }
        }
      }
    } catch {
      pendingEntry = null;
    }

    if (pendingEntry) {
      const pendingFilePath = path.join(pendingDir, pendingEntry);
      const claimedFilePath = path.join(claimedDir, `${messageId}.json`);

      let renameOk = false;
      try {
        fsApi.mkdirSync(claimedDir, { recursive: true });
        fsApi.renameSync(pendingFilePath, claimedFilePath);
        renameOk = true;
      } catch {
        // Consumer claimed it first, or concurrent race
        renameOk = false;
      }

      if (renameOk) {
        const expiredReceipt = buildPeerMessageReceipt({
          messageId: rcpt.messageId,
          dedupKey: rcpt.dedupKey,
          targetPetId: rcpt.targetPetId,
          sourcePetId: rcpt.sourcePetId,
          sourceDisplayName: rcpt.sourceDisplayName,
          sourceHost: rcpt.sourceHost,
          status: "expired",
          reason: "Message expired in queue before delivery",
          text: rcpt.text,
          deliverAs: rcpt.deliverAs || "followUp",
          threadId: rcpt.threadId,
          hopCount: rcpt.hopCount,
          maxHops: rcpt.maxHops,
          replyHandle: rcpt.replyHandle,
          createdAtMs: rcpt.createdAtMs,
          updatedAtMs: nowMs,
          expiresAtMs: rcpt.expiresAtMs,
        });

        try {
          atomicWriteJson(rcptPath, expiredReceipt, fsApi);
          try { fsApi.unlinkSync(claimedFilePath); } catch {}
          return expiredReceipt;
        } catch {
          // If receipt write fails, retain claimedFilePath as evidence
          return rcpt;
        }
      }
    }
  }

  return rcpt;
}

module.exports = {
  DEFAULT_PEER_MESSAGE_TTL_MS,
  MAX_PEER_INBOX_QUEUE_CAPACITY,
  MAX_PEER_MESSAGE_TTL_MS,
  MIN_PEER_MESSAGE_TTL_MS,
  PEER_CLAIM_TIMEOUT_MS,
  claimNextPeerMessage,
  enqueuePeerMessage,
  getPeerMessageReceipt,
  settlePeerMessage,
};
