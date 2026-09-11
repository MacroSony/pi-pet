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
  isSafeId,
  isSafePetId,
  resolvePetIdentity,
} = require("./internal");

const DEFAULT_USER_MESSAGE_TTL_MS = 60000; // 60s
const MIN_USER_MESSAGE_TTL_MS = 1000;
const MAX_USER_MESSAGE_TTL_MS = 300000;
const MAX_INBOX_QUEUE_CAPACITY = 32;
const CLAIM_TIMEOUT_MS = 60000; // 60s

const VALID_SETTLE_STATUSES = Object.freeze(new Set(["dispatched", "failed", "expired"]));

const ENQUEUE_WIRE_FIELDS = Object.freeze([
  "petId",
  "rawSessionId",
  "id",
  "agentId",
  "profileId",
  "text",
  "deliverAs",
  "commandId",
  "dedupKey",
  "ttlMs",
  "createdAtMs",
]);

const SETTLE_WIRE_FIELDS = Object.freeze([
  "petId",
  "rawSessionId",
  "id",
  "agentId",
  "profileId",
  "commandId",
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

function resolveDataDir(options, env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return options?.dataDir || env.PI_PET_DATA_DIR || path.join(home, ".pi-pet");
}

function buildUserMessageReceipt({
  commandId = null,
  dedupKey = null,
  petId = null,
  status,
  reason = null,
  text,
  deliverAs = "followUp",
  createdAtMs,
  updatedAtMs,
  expiresAtMs,
}) {
  const receipt = {
    schemaVersion: "1",
    kind: "user_message",
    commandId,
    dedupKey,
    petId,
    status,
    reason,
  };

  if (text !== undefined) {
    receipt.text = text;
  }
  if (deliverAs !== undefined && status !== "rejected") {
    receipt.deliverAs = deliverAs;
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
      ...(deliverAs !== undefined ? { deliverAs } : {}),
    };
  }

  return receipt;
}

function enqueueUserMessage(options = {}) {
  const fsApi = options?.fsApi || fs;
  const env = options?.env || process.env;
  const nowMs = typeof options?.now === "function" ? options.now() : Date.now();
  const createdAtMs = typeof options?.createdAtMs === "number" ? options.createdAtMs : nowMs;

  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return buildUserMessageReceipt({
      commandId: null,
      dedupKey: null,
      petId: null,
      status: "rejected",
      reason: "SchemaValidationError: options must be an object",
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  // 1. Validate envelope size (<= 16 KiB)
  const envelope = extractWireEnvelope(options, ENQUEUE_WIRE_FIELDS);
  let serializedSize;
  try {
    serializedSize = Buffer.byteLength(JSON.stringify(envelope), "utf8");
  } catch {
    return buildUserMessageReceipt({
      commandId: options.commandId || null,
      dedupKey: options.dedupKey || null,
      petId: null,
      status: "rejected",
      reason: "SchemaValidationError: options cannot be serialized to JSON",
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  if (serializedSize > MAX_ENVELOPE_SIZE) {
    return buildUserMessageReceipt({
      commandId: options.commandId || null,
      dedupKey: options.dedupKey || null,
      petId: null,
      status: "rejected",
      reason: "SchemaValidationError: payload exceeds maximum envelope size of 16 KiB",
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  // 2. Validate text (1..2000 characters)
  if (options.text === undefined || typeof options.text !== "string") {
    return buildUserMessageReceipt({
      commandId: options.commandId || null,
      dedupKey: options.dedupKey || null,
      petId: null,
      status: "rejected",
      reason: "SchemaValidationError: text must be a string",
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  if (options.text.length < 1 || options.text.length > MAX_TEXT_LENGTH) {
    return buildUserMessageReceipt({
      commandId: options.commandId || null,
      dedupKey: options.dedupKey || null,
      petId: null,
      status: "rejected",
      reason: `SchemaValidationError: text length must be between 1 and ${MAX_TEXT_LENGTH} characters`,
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  // 3. Validate deliverAs (fixed to 'followUp')
  if (options.deliverAs !== undefined && options.deliverAs !== "followUp") {
    return buildUserMessageReceipt({
      commandId: options.commandId || null,
      dedupKey: options.dedupKey || null,
      petId: null,
      status: "rejected",
      reason: "SchemaValidationError: deliverAs must be 'followUp'",
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  // 4. Validate TTL (1s..300s, default 60s) — wire contract only ttlMs, no ttl seconds alias
  let ttlMs = DEFAULT_USER_MESSAGE_TTL_MS;
  if (options.ttlMs !== undefined) {
    if (
      typeof options.ttlMs !== "number" ||
      !Number.isFinite(options.ttlMs) ||
      options.ttlMs < MIN_USER_MESSAGE_TTL_MS ||
      options.ttlMs > MAX_USER_MESSAGE_TTL_MS
    ) {
      return buildUserMessageReceipt({
        commandId: options.commandId || null,
        dedupKey: options.dedupKey || null,
        petId: null,
        status: "rejected",
        reason: `SchemaValidationError: ttlMs must be a number between ${MIN_USER_MESSAGE_TTL_MS} and ${MAX_USER_MESSAGE_TTL_MS}`,
        createdAtMs,
        updatedAtMs: nowMs,
      });
    }
    ttlMs = options.ttlMs;
  }

  // 5. Validate identifier fields if supplied (safe [A-Za-z0-9_-] max 64)
  if (options.dedupKey !== undefined && !isSafeId(options.dedupKey)) {
    return buildUserMessageReceipt({
      commandId: options.commandId || null,
      dedupKey: null,
      petId: null,
      status: "rejected",
      reason: `SchemaValidationError: dedupKey must be a non-empty string up to ${MAX_ID_LENGTH} characters matching [A-Za-z0-9_-]`,
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  if (options.commandId !== undefined && !isSafeId(options.commandId)) {
    return buildUserMessageReceipt({
      commandId: null,
      dedupKey: options.dedupKey || null,
      petId: null,
      status: "rejected",
      reason: `SchemaValidationError: commandId must be a non-empty string up to ${MAX_ID_LENGTH} characters matching [A-Za-z0-9_-]`,
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  // 6. Derive or validate petId
  const idResult = resolvePetIdentity(options);
  if (!idResult.ok) {
    return buildUserMessageReceipt({
      commandId: options.commandId || null,
      dedupKey: options.dedupKey || null,
      petId: idResult.petId,
      status: "rejected",
      reason: idResult.reason,
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }
  const petId = idResult.petId;

  // 7. Resolve directories
  const dataDir = resolveDataDir(options, env);
  const statusDir = path.join(dataDir, "status");
  const receiptsDir = path.join(dataDir, "receipts");
  const inboxPetDir = path.join(dataDir, "inbox", petId);
  const pendingDir = path.join(inboxPetDir, "pending");
  const claimedDir = path.join(inboxPetDir, "claimed");

  // 8. Active session verification (reject status closed or offline)
  const statusPath = path.join(statusDir, `status-${petId}.json`);
  if (!fsApi.existsSync(statusPath)) {
    return buildUserMessageReceipt({
      commandId: options.commandId || null,
      dedupKey: options.dedupKey || null,
      petId,
      status: "rejected",
      reason: `UnknownPetIdentity: active session status file not found for ${petId}`,
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  let statusData;
  try {
    const rawStatus = fsApi.readFileSync(statusPath, "utf8");
    statusData = JSON.parse(rawStatus);
  } catch (err) {
    return buildUserMessageReceipt({
      commandId: options.commandId || null,
      dedupKey: options.dedupKey || null,
      petId,
      status: "rejected",
      reason: `UnknownPetIdentity: failed to parse active session status file: ${err.message}`,
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  if (!statusData || statusData.state === "closed") {
    return buildUserMessageReceipt({
      commandId: options.commandId || null,
      dedupKey: options.dedupKey || null,
      petId,
      status: "rejected",
      reason: "SessionClosed: session is closed",
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  if (statusData.state === "offline") {
    return buildUserMessageReceipt({
      commandId: options.commandId || null,
      dedupKey: options.dedupKey || null,
      petId,
      status: "rejected",
      reason: "SessionOffline: session is offline",
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  // 9. Check TTL expiration at ingestion
  if (createdAtMs + ttlMs < nowMs) {
    return buildUserMessageReceipt({
      commandId: options.commandId || null,
      dedupKey: options.dedupKey || null,
      petId,
      status: "expired",
      reason: "Command expired before processing",
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  // 10. Command & dedup identity
  const commandId = options.commandId || crypto.randomUUID();
  const dedupKey = options.dedupKey || commandId;

  // 11. Deduplication check against persisted user-message receipts (rcpt-user-* ONLY)
  try {
    fsApi.mkdirSync(receiptsDir, { recursive: true });
    const entries = fsApi.readdirSync(receiptsDir);
    for (const file of entries) {
      if (!file.startsWith("rcpt-user-") || !file.endsWith(".json")) continue;
      const filePath = path.join(receiptsDir, file);
      try {
        const content = fsApi.readFileSync(filePath, "utf8");
        const rcpt = JSON.parse(content);

        const rcptTime = rcpt.createdAtMs || rcpt.updatedAtMs || 0;
        if (rcptTime > 0 && nowMs - rcptTime > GC_WINDOW_MS) {
          try { fsApi.unlinkSync(filePath); } catch {}
          continue;
        }

        if (file === `rcpt-user-${commandId}.json` || rcpt.commandId === commandId) {
          if (rcpt.petId && rcpt.petId !== petId) {
            return buildUserMessageReceipt({
              commandId,
              dedupKey,
              petId,
              status: "rejected",
              reason: `CommandIdConflict: commandId "${commandId}" already exists for a different pet`,
              createdAtMs,
              updatedAtMs: nowMs,
            });
          }
          return rcpt;
        }

        if (rcpt.petId === petId && rcpt.dedupKey === dedupKey) {
          return rcpt;
        }
      } catch {
        // Skip unreadable receipts
      }
    }
  } catch {
    // Ignore scan errors
  }

  // 12. Check inbox queue capacity (cap pending + claimed at 32, reject newest)
  fsApi.mkdirSync(pendingDir, { recursive: true });
  fsApi.mkdirSync(claimedDir, { recursive: true });

  let pendingCount = 0;
  let claimedCount = 0;
  try {
    const pendingEntries = fsApi.readdirSync(pendingDir);
    pendingCount = pendingEntries.filter((f) => f.endsWith(".json") && !f.endsWith(".tmp")).length;
  } catch {}

  try {
    const claimedEntries = fsApi.readdirSync(claimedDir);
    claimedCount = claimedEntries.filter((f) => f.endsWith(".json") && !f.endsWith(".tmp")).length;
  } catch {}

  if (pendingCount + claimedCount >= MAX_INBOX_QUEUE_CAPACITY) {
    return buildUserMessageReceipt({
      commandId,
      dedupKey,
      petId,
      status: "rejected",
      reason: `QueueCapacityExceeded: inbox queue capacity limit of ${MAX_INBOX_QUEUE_CAPACITY} reached`,
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  // 13. Construct UserMessage and UserMessageReceipt (canonical initial status 'queued')
  const expiresAtMs = createdAtMs + ttlMs;

  const userMessage = {
    schemaVersion: "1",
    kind: "user_message",
    commandId,
    dedupKey,
    petId,
    text: options.text,
    deliverAs: "followUp",
    createdAtMs,
    expiresAtMs,
  };

  const receipt = buildUserMessageReceipt({
    commandId,
    dedupKey,
    petId,
    status: "queued",
    reason: null,
    text: options.text,
    deliverAs: "followUp",
    createdAtMs,
    updatedAtMs: nowMs,
    expiresAtMs,
  });

  // 14. Persist pending message file and initial receipt
  const pendingFileName = `${String(createdAtMs).padStart(16, "0")}-${commandId}.json`;
  const pendingFilePath = path.join(pendingDir, pendingFileName);
  const receiptPath = path.join(receiptsDir, `rcpt-user-${commandId}.json`);

  try {
    atomicWriteJson(pendingFilePath, userMessage, fsApi);
  } catch (err) {
    return buildUserMessageReceipt({
      commandId,
      dedupKey,
      petId,
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
    return buildUserMessageReceipt({
      commandId,
      dedupKey,
      petId,
      status: "failed",
      reason: `IO failure writing initial receipt: ${err.message}`,
      createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  return receipt;
}

function claimNextUserMessage(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return null;
  }

  const fsApi = options.fsApi || fs;
  const env = options.env || process.env;
  const nowMs = typeof options.now === "function" ? options.now() : Date.now();

  const idResult = resolvePetIdentity(options);
  if (!idResult.ok) {
    return null;
  }
  const petId = idResult.petId;

  const dataDir = resolveDataDir(options, env);
  const inboxPetDir = path.join(dataDir, "inbox", petId);
  const pendingDir = path.join(inboxPetDir, "pending");
  const claimedDir = path.join(inboxPetDir, "claimed");
  const receiptsDir = path.join(dataDir, "receipts");

  fsApi.mkdirSync(pendingDir, { recursive: true });
  fsApi.mkdirSync(claimedDir, { recursive: true });
  fsApi.mkdirSync(receiptsDir, { recursive: true });

  // 1. Clean up stale claimed items older than 60s (terminal failed/delivery-unknown, NEVER requeued)
  try {
    const claimedEntries = fsApi.readdirSync(claimedDir);
    for (const file of claimedEntries) {
      if (!file.endsWith(".json") || file.endsWith(".tmp")) continue;
      const fileBase = path.basename(file, ".json");
      if (!isSafeId(fileBase)) continue;

      const claimedFilePath = path.join(claimedDir, file);
      try {
        const rawClaimed = fsApi.readFileSync(claimedFilePath, "utf8");
        const claimedMsg = JSON.parse(rawClaimed);
        if (!claimedMsg || typeof claimedMsg !== "object" || Array.isArray(claimedMsg)) continue;

        const candidateCommandId = typeof claimedMsg.commandId === "string" && isSafeId(claimedMsg.commandId)
          ? claimedMsg.commandId
          : fileBase;
        if (!isSafeId(candidateCommandId)) continue;

        const candidatePetId = typeof claimedMsg.petId === "string" && isSafePetId(claimedMsg.petId)
          ? claimedMsg.petId
          : petId;
        if (!isSafePetId(candidatePetId)) continue;

        const claimedAt = typeof claimedMsg.claimedAtMs === "number"
          ? claimedMsg.claimedAtMs
          : (typeof claimedMsg.updatedAtMs === "number"
            ? claimedMsg.updatedAtMs
            : (typeof claimedMsg.createdAtMs === "number" ? claimedMsg.createdAtMs : 0));

        if (nowMs - claimedAt > CLAIM_TIMEOUT_MS) {
          const rcptPath = path.join(receiptsDir, `rcpt-user-${candidateCommandId}.json`);

          // Check if a terminal user receipt already exists
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
            const failedReceipt = buildUserMessageReceipt({
              commandId: candidateCommandId,
              dedupKey: typeof claimedMsg.dedupKey === "string" && isSafeId(claimedMsg.dedupKey) ? claimedMsg.dedupKey : null,
              petId: candidatePetId,
              status: "failed",
              reason: "Claim expired: stale claimed item older than 60s (delivery-unknown)",
              text: typeof claimedMsg.text === "string" ? claimedMsg.text : "",
              deliverAs: "followUp",
              createdAtMs: typeof claimedMsg.createdAtMs === "number" ? claimedMsg.createdAtMs : nowMs,
              updatedAtMs: nowMs,
              expiresAtMs: typeof claimedMsg.expiresAtMs === "number" ? claimedMsg.expiresAtMs : undefined,
            });
            try {
              atomicWriteJson(rcptPath, failedReceipt, fsApi);
              try { fsApi.unlinkSync(claimedFilePath); } catch {}
            } catch {
              // Leave claim if receipt write fails
            }
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {}

  // 2. Scan pending items in FIFO order
  let pendingEntries = [];
  try {
    pendingEntries = fsApi.readdirSync(pendingDir)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"))
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

    // Harden on-disk candidate commandId and petId validation before constructing paths
    let candidateCommandId;
    if (candidateData.commandId !== undefined) {
      if (typeof candidateData.commandId !== "string" || !isSafeId(candidateData.commandId)) {
        // Malformed commandId in candidate file; not dispatchable and must not escape
        quarantinePendingCandidate(fsApi, pendingDir, entry);
        continue;
      }
      candidateCommandId = candidateData.commandId;
    } else {
      const match = entry.match(/^\d{1,20}-([A-Za-z0-9_-]{1,64})\.json$/);
      if (match && isSafeId(match[1])) {
        candidateCommandId = match[1];
      } else {
        quarantinePendingCandidate(fsApi, pendingDir, entry);
        continue;
      }
    }

    let candidatePetId = candidateData.petId;
    if (candidatePetId !== undefined) {
      if (typeof candidatePetId !== "string" || !isSafePetId(candidatePetId) || candidatePetId !== petId) {
        // Malformed or mismatched petId; skip
        quarantinePendingCandidate(fsApi, pendingDir, entry);
        continue;
      }
    } else {
      candidatePetId = petId;
    }

    if (
      typeof candidateData.text !== "string" ||
      candidateData.text.length < 1 ||
      candidateData.text.length > MAX_TEXT_LENGTH
    ) {
      quarantinePendingCandidate(fsApi, pendingDir, entry);
      continue;
    }

    if (candidateData.deliverAs !== undefined && candidateData.deliverAs !== "followUp") {
      quarantinePendingCandidate(fsApi, pendingDir, entry);
      continue;
    }

    const dedupKey = typeof candidateData.dedupKey === "string" && isSafeId(candidateData.dedupKey)
      ? candidateData.dedupKey
      : candidateCommandId;

    const createdAtMs = typeof candidateData.createdAtMs === "number" ? candidateData.createdAtMs : nowMs;
    const expiresAtMs = typeof candidateData.expiresAtMs === "number"
      ? candidateData.expiresAtMs
      : createdAtMs + DEFAULT_USER_MESSAGE_TTL_MS;

    const claimedFilePath = path.join(claimedDir, `${candidateCommandId}.json`);

    // Atomically rename pending directly to claimed/<commandId>.json (no orphan temp claim window)
    try {
      fsApi.renameSync(pendingFilePath, claimedFilePath);
    } catch {
      // Another worker claimed this pending file concurrently, or collision
      continue;
    }

    // Check if candidate message is already expired
    if (expiresAtMs <= nowMs) {
      const rcptPath = path.join(receiptsDir, `rcpt-user-${candidateCommandId}.json`);
      const expiredReceipt = buildUserMessageReceipt({
        commandId: candidateCommandId,
        dedupKey,
        petId: candidatePetId,
        status: "expired",
        reason: "Message expired in queue before delivery",
        text: candidateData.text,
        deliverAs: "followUp",
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
      kind: "user_message",
      commandId: candidateCommandId,
      dedupKey,
      petId: candidatePetId,
      text: candidateData.text,
      deliverAs: "followUp",
      createdAtMs,
      expiresAtMs,
      claimToken,
      claimedAtMs: nowMs,
    };
    atomicWriteJson(claimedFilePath, claimedRecord, fsApi);

    return {
      schemaVersion: "1",
      kind: "user_message",
      commandId: candidateCommandId,
      dedupKey,
      petId: candidatePetId,
      text: candidateData.text,
      deliverAs: "followUp",
      createdAtMs,
      expiresAtMs,
      claimToken,
      claimedAtMs: nowMs,
      message: {
        schemaVersion: "1",
        kind: "user_message",
        commandId: candidateCommandId,
        dedupKey,
        petId: candidatePetId,
        text: candidateData.text,
        deliverAs: "followUp",
        createdAtMs,
        expiresAtMs,
      },
    };
  }

  return null;
}

function settleUserMessage(options = {}) {
  const nowMs = typeof options?.now === "function" ? options.now() : Date.now();
  const fsApi = options?.fsApi || fs;
  const env = options?.env || process.env;

  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return buildUserMessageReceipt({
      commandId: null,
      dedupKey: null,
      petId: null,
      status: "rejected",
      reason: "SchemaValidationError: options must be an object",
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  }

  // 1. Envelope size validation
  const envelope = extractWireEnvelope(options, SETTLE_WIRE_FIELDS);
  let serializedSize;
  try {
    serializedSize = Buffer.byteLength(JSON.stringify(envelope), "utf8");
  } catch {
    return buildUserMessageReceipt({
      commandId: options.commandId || null,
      dedupKey: null,
      petId: null,
      status: "rejected",
      reason: "SchemaValidationError: options cannot be serialized to JSON",
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  }

  if (serializedSize > MAX_ENVELOPE_SIZE) {
    return buildUserMessageReceipt({
      commandId: options.commandId || null,
      dedupKey: null,
      petId: null,
      status: "rejected",
      reason: "SchemaValidationError: payload exceeds maximum envelope size of 16 KiB",
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  }

  // 2. Validate commandId
  if (!options.commandId || typeof options.commandId !== "string" || !isSafeId(options.commandId)) {
    return buildUserMessageReceipt({
      commandId: options.commandId || null,
      dedupKey: null,
      petId: null,
      status: "rejected",
      reason: `SchemaValidationError: commandId is required and must match [A-Za-z0-9_-]{1,${MAX_ID_LENGTH}}`,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  }

  // 3. Validate claimToken
  if (!options.claimToken || typeof options.claimToken !== "string" || options.claimToken.trim().length === 0) {
    return buildUserMessageReceipt({
      commandId: options.commandId,
      dedupKey: null,
      petId: null,
      status: "rejected",
      reason: "SchemaValidationError: claimToken is required",
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  }

  // 4. Validate status (terminal status may be dispatched, failed, expired; never call it delivered)
  if (options.status === "delivered") {
    return buildUserMessageReceipt({
      commandId: options.commandId,
      dedupKey: null,
      petId: null,
      status: "rejected",
      reason: "SchemaValidationError: Invalid settle status 'delivered'. Settle terminal status must be one of: dispatched, failed, expired",
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  }

  if (!options.status || !VALID_SETTLE_STATUSES.has(options.status)) {
    return buildUserMessageReceipt({
      commandId: options.commandId,
      dedupKey: null,
      petId: null,
      status: "rejected",
      reason: `SchemaValidationError: status must be one of: ${Array.from(VALID_SETTLE_STATUSES).join(", ")}`,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  }

  // 5. Derive or validate petId
  const idResult = resolvePetIdentity(options);
  if (!idResult.ok) {
    return buildUserMessageReceipt({
      commandId: options.commandId,
      dedupKey: null,
      petId: idResult.petId,
      status: "rejected",
      reason: idResult.reason,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  }
  const petId = idResult.petId;

  // 6. Resolve paths
  const dataDir = resolveDataDir(options, env);
  const inboxPetDir = path.join(dataDir, "inbox", petId);
  const claimedDir = path.join(inboxPetDir, "claimed");
  const receiptsDir = path.join(dataDir, "receipts");

  const claimedFilePath = path.join(claimedDir, `${options.commandId}.json`);
  const receiptPath = path.join(receiptsDir, `rcpt-user-${options.commandId}.json`);

  if (!fsApi.existsSync(claimedFilePath)) {
    return buildUserMessageReceipt({
      commandId: options.commandId,
      dedupKey: null,
      petId,
      status: "rejected",
      reason: `ClaimNotFound: no active claim found for commandId "${options.commandId}"`,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  }

  let claimedData;
  try {
    const rawClaimed = fsApi.readFileSync(claimedFilePath, "utf8");
    claimedData = JSON.parse(rawClaimed);
  } catch (err) {
    return buildUserMessageReceipt({
      commandId: options.commandId,
      dedupKey: null,
      petId,
      status: "failed",
      reason: `IO failure reading claimed file: ${err.message}`,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  }

  // 7. Validate claimToken match
  if (claimedData.claimToken !== options.claimToken) {
    return buildUserMessageReceipt({
      commandId: options.commandId,
      dedupKey: claimedData.dedupKey || null,
      petId,
      status: "rejected",
      reason: "InvalidClaimToken: claimToken does not match active claim",
      createdAtMs: claimedData.createdAtMs || nowMs,
      updatedAtMs: nowMs,
    });
  }

  // 8. Check stale claim (>60s)
  const claimedAt = claimedData.claimedAtMs || claimedData.updatedAtMs || claimedData.createdAtMs || 0;
  if (nowMs - claimedAt > CLAIM_TIMEOUT_MS) {
    // Check if a terminal user receipt already exists
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

    const failedReceipt = buildUserMessageReceipt({
      commandId: claimedData.commandId,
      dedupKey: claimedData.dedupKey || null,
      petId: claimedData.petId || petId,
      status: "failed",
      reason: "Claim expired: stale claimed item older than 60s (delivery-unknown)",
      text: claimedData.text,
      deliverAs: "followUp",
      createdAtMs: claimedData.createdAtMs,
      updatedAtMs: nowMs,
      expiresAtMs: claimedData.expiresAtMs,
    });

    try {
      atomicWriteJson(receiptPath, failedReceipt, fsApi);
      try { fsApi.unlinkSync(claimedFilePath); } catch {}
    } catch (err) {
      return buildUserMessageReceipt({
        commandId: claimedData.commandId,
        dedupKey: claimedData.dedupKey || null,
        petId,
        status: "failed",
        reason: `IO failure writing expired claim receipt: ${err.message}`,
        createdAtMs: claimedData.createdAtMs,
        updatedAtMs: nowMs,
      });
    }
    return failedReceipt;
  }

  // 9. Normal settle: persist terminal receipt before unlinking claim; if receipt write fails, leave claim
  const receipt = buildUserMessageReceipt({
    commandId: claimedData.commandId,
    dedupKey: claimedData.dedupKey || null,
    petId: claimedData.petId || petId,
    status: options.status, // "dispatched" | "failed" | "expired"
    reason: options.reason || null,
    text: claimedData.text,
    deliverAs: "followUp",
    createdAtMs: claimedData.createdAtMs,
    updatedAtMs: nowMs,
    expiresAtMs: claimedData.expiresAtMs,
  });

  try {
    atomicWriteJson(receiptPath, receipt, fsApi);
  } catch (err) {
    return buildUserMessageReceipt({
      commandId: claimedData.commandId,
      dedupKey: claimedData.dedupKey || null,
      petId,
      status: "failed",
      reason: `IO failure writing settled receipt: ${err.message}`,
      createdAtMs: claimedData.createdAtMs,
      updatedAtMs: nowMs,
    });
  }

  try { fsApi.unlinkSync(claimedFilePath); } catch {}

  return receipt;
}

module.exports = {
  CLAIM_TIMEOUT_MS,
  DEFAULT_USER_MESSAGE_TTL_MS,
  MAX_INBOX_QUEUE_CAPACITY,
  MAX_USER_MESSAGE_TTL_MS,
  MIN_USER_MESSAGE_TTL_MS,
  buildUserMessageReceipt,
  claimNextUserMessage,
  enqueueUserMessage,
  settleUserMessage,
};
