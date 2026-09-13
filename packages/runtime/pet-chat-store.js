"use strict";

/**
 * Pet Chat Store Module
 *
 * Neutral bounded per-pet chat store for conversation history.
 * Canonical file: <dataDir>/chat/chat-<petId>.json
 *
 * Concurrency Note:
 * Single-writer coordinator per runtime data directory is assumed.
 * Operations perform atomic writes using temporary files.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  atomicWriteJson,
  isSafeId,
  isSafePetId,
} = require("./internal");

const SCHEMA_VERSION = "1";
const MAX_CHAT_TURNS = 20;
const MAX_CHAT_FILE_BYTES = 48 * 1024; // 48 KiB (49152 bytes)
const MAX_USER_TEXT_CODE_POINTS = 2000;
const MAX_ASSISTANT_TEXT_BYTES = 8192;

const DISALLOWED_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

const CHAT_EXACT_KEYS = new Set([
  "schemaVersion",
  "petId",
  "revision",
  "turns",
  "updatedAtMs",
]);

const TURN_EXACT_KEYS = new Set([
  "commandId",
  "userText",
  "assistantText",
  "createdAtMs",
  "completedAtMs",
]);

const READ_CHAT_ALLOWED_KEYS = new Set(["petId"]);
const RECORD_USER_MESSAGE_ALLOWED_KEYS = new Set(["petId", "commandId", "text", "createdAtMs"]);
const COMPLETE_TURN_ALLOWED_KEYS = new Set(["petId", "commandId", "assistantText", "completedAtMs"]);
const CLEAR_CHAT_ALLOWED_KEYS = new Set(["petId"]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

function hasOnlyAllowedKeys(obj, allowedKeysSet) {
  if (!isPlainObject(obj)) return false;
  for (const key of Object.keys(obj)) {
    if (!allowedKeysSet.has(key)) {
      return false;
    }
  }
  return true;
}

function countCodePoints(str) {
  if (typeof str !== "string") return 0;
  return Array.from(str).length;
}

function isValidUserText(text) {
  if (typeof text !== "string") return false;
  const len = countCodePoints(text);
  if (len < 1 || len > MAX_USER_TEXT_CODE_POINTS) return false;
  if (DISALLOWED_CONTROL_RE.test(text)) return false;
  return true;
}

function truncateUtf8Bytes(str, maxBytes = MAX_ASSISTANT_TEXT_BYTES) {
  if (typeof str !== "string") return "";
  const buf = Buffer.from(str, "utf8");
  if (buf.byteLength <= maxBytes) {
    return str;
  }
  let totalBytes = 0;
  const result = [];
  for (const char of str) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (totalBytes + charBytes > maxBytes) {
      break;
    }
    totalBytes += charBytes;
    result.push(char);
  }
  return result.join("");
}

function sanitizeAssistantText(text) {
  if (typeof text !== "string") return "";
  const cleaned = text.replace(new RegExp(DISALLOWED_CONTROL_RE.source, "g"), "");
  return truncateUtf8Bytes(cleaned, MAX_ASSISTANT_TEXT_BYTES);
}

function deepClone(obj) {
  if (typeof structuredClone === "function") {
    return structuredClone(obj);
  }
  return JSON.parse(JSON.stringify(obj));
}

function resolveDataDir(options = {}, env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return options.dataDir || env.PI_PET_DATA_DIR || path.join(home, ".pi-pet");
}

function readClock(nowFn, floorMs = 0) {
  const nowMs = nowFn();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    return null;
  }
  return Math.max(nowMs, floorMs);
}

function validateTurnRecord(turn) {
  if (!isPlainObject(turn)) return false;
  const keys = Object.keys(turn);
  if (keys.length !== TURN_EXACT_KEYS.size) return false;
  for (const key of keys) {
    if (!TURN_EXACT_KEYS.has(key)) return false;
  }

  if (!isSafeId(turn.commandId)) return false;
  if (!isValidUserText(turn.userText)) return false;

  if (turn.assistantText !== null) {
    if (typeof turn.assistantText !== "string") return false;
    if (Buffer.byteLength(turn.assistantText, "utf8") > MAX_ASSISTANT_TEXT_BYTES) return false;
    if (DISALLOWED_CONTROL_RE.test(turn.assistantText)) return false;
  }

  if (typeof turn.createdAtMs !== "number" || !Number.isSafeInteger(turn.createdAtMs) || turn.createdAtMs < 0) {
    return false;
  }

  if (turn.completedAtMs !== null) {
    if (
      typeof turn.completedAtMs !== "number" ||
      !Number.isSafeInteger(turn.completedAtMs) ||
      turn.completedAtMs < turn.createdAtMs
    ) {
      return false;
    }
  }

  return true;
}

function validatePersistedChatRecord(chat, expectedPetId) {
  if (!isPlainObject(chat)) return false;
  const keys = Object.keys(chat);
  if (keys.length !== CHAT_EXACT_KEYS.size) return false;
  for (const key of keys) {
    if (!CHAT_EXACT_KEYS.has(key)) return false;
  }

  if (chat.schemaVersion !== SCHEMA_VERSION) return false;
  if (!isSafePetId(chat.petId) || chat.petId !== expectedPetId) return false;
  if (typeof chat.revision !== "number" || !Number.isSafeInteger(chat.revision) || chat.revision < 1) {
    return false;
  }
  if (typeof chat.updatedAtMs !== "number" || !Number.isSafeInteger(chat.updatedAtMs) || chat.updatedAtMs < 0) {
    return false;
  }
  if (!Array.isArray(chat.turns) || chat.turns.length > MAX_CHAT_TURNS) {
    return false;
  }

  const seenCommandIds = new Set();
  for (const turn of chat.turns) {
    if (!validateTurnRecord(turn)) return false;
    if (seenCommandIds.has(turn.commandId)) return false;
    seenCommandIds.add(turn.commandId);
  }

  return true;
}

function readChatFile(chatFilePath, fsApi, petId) {
  try {
    let exists = false;
    try {
      exists = fsApi.existsSync(chatFilePath);
    } catch (err) {
      return {
        exists: true,
        corrupt: true,
        error: "io_error",
        reason: `Failed to check chat file: ${err.message}`,
      };
    }

    if (!exists) {
      return { exists: false };
    }

    const stat = fsApi.statSync(chatFilePath);
    if (stat.size > MAX_CHAT_FILE_BYTES) {
      return {
        exists: true,
        corrupt: true,
        error: "corrupt_chat",
        reason: `Chat file size (${stat.size} bytes) exceeds maximum limit of ${MAX_CHAT_FILE_BYTES} bytes`,
      };
    }
    const raw = fsApi.readFileSync(chatFilePath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_CHAT_FILE_BYTES) {
      return {
        exists: true,
        corrupt: true,
        error: "corrupt_chat",
        reason: "Chat file byte length exceeds maximum limit of 48 KiB",
      };
    }
    const parsed = JSON.parse(raw);
    if (!validatePersistedChatRecord(parsed, petId)) {
      return {
        exists: true,
        corrupt: true,
        error: "corrupt_chat",
        reason: "Chat record schema validation failed",
      };
    }
    if (path.basename(chatFilePath) !== `chat-${petId}.json`) {
      return {
        exists: true,
        corrupt: true,
        error: "corrupt_chat",
        reason: "Chat file name does not match petId",
      };
    }
    return { exists: true, corrupt: false, chat: parsed };
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { exists: false };
    }
    return {
      exists: true,
      corrupt: true,
      error: "corrupt_chat",
      reason: `Failed to read chat file: ${err.message}`,
    };
  }
}

function applyBoundsAndEviction(chat) {
  if (chat.turns.length > MAX_CHAT_TURNS) {
    chat.turns.splice(0, chat.turns.length - MAX_CHAT_TURNS);
  }

  while (chat.turns.length > 0) {
    const json = `${JSON.stringify(chat, null, 2)}\n`;
    if (Buffer.byteLength(json, "utf8") <= MAX_CHAT_FILE_BYTES) {
      break;
    }
    // Evict oldest turn
    chat.turns.shift();
  }
}

function createPetChatStore(config = {}) {
  const fsApi = config.fsApi || fs;
  const env = config.env || process.env;
  const nowFn = typeof config.now === "function" ? config.now : Date.now;

  const dataDir = resolveDataDir(config, env);
  const chatDir = path.join(dataDir, "chat");

  function getChatFilePath(petId) {
    return path.join(chatDir, `chat-${petId}.json`);
  }

  function readChat(options) {
    if (arguments.length !== 1 || !hasOnlyAllowedKeys(options, READ_CHAT_ALLOWED_KEYS)) {
      return { ok: false, error: "invalid_options", reason: "Invalid options provided to readChat" };
    }

    const { petId } = options;
    if (!isSafePetId(petId)) {
      return { ok: false, error: "invalid_pet_id", reason: "Invalid petId" };
    }

    const chatFilePath = getChatFilePath(petId);
    const fileResult = readChatFile(chatFilePath, fsApi, petId);

    if (fileResult.corrupt) {
      return {
        ok: false,
        error: fileResult.error || "corrupt_chat",
        reason: fileResult.reason || "Persisted chat file is corrupt or invalid",
      };
    }

    if (!fileResult.exists) {
      return {
        ok: true,
        chat: {
          schemaVersion: SCHEMA_VERSION,
          petId,
          revision: 0,
          turns: [],
          updatedAtMs: null,
        },
      };
    }

    return {
      ok: true,
      chat: deepClone(fileResult.chat),
    };
  }

  function recordUserMessage(options) {
    if (arguments.length !== 1 || !hasOnlyAllowedKeys(options, RECORD_USER_MESSAGE_ALLOWED_KEYS)) {
      return { ok: false, error: "invalid_options", reason: "Invalid options provided to recordUserMessage" };
    }

    const { petId, commandId, text, createdAtMs } = options;

    if (!isSafePetId(petId)) {
      return { ok: false, error: "invalid_pet_id", reason: "Invalid petId" };
    }

    if (!isSafeId(commandId)) {
      return { ok: false, error: "invalid_command_id", reason: "Invalid commandId" };
    }

    if (typeof text !== "string") {
      return { ok: false, error: "invalid_text", reason: "text must be a string" };
    }

    const textLen = countCodePoints(text);
    if (textLen < 1 || textLen > MAX_USER_TEXT_CODE_POINTS) {
      return {
        ok: false,
        error: "invalid_text",
        reason: `text length (${textLen} code points) must be between 1 and ${MAX_USER_TEXT_CODE_POINTS} code points`,
      };
    }

    if (DISALLOWED_CONTROL_RE.test(text)) {
      return { ok: false, error: "invalid_text", reason: "text contains disallowed control characters" };
    }

    if (createdAtMs !== undefined) {
      if (typeof createdAtMs !== "number" || !Number.isSafeInteger(createdAtMs) || createdAtMs < 0) {
        return { ok: false, error: "invalid_timestamp", reason: "createdAtMs must be a non-negative safe integer" };
      }
    }

    const chatFilePath = getChatFilePath(petId);
    const fileResult = readChatFile(chatFilePath, fsApi, petId);

    if (fileResult.corrupt) {
      return {
        ok: false,
        error: fileResult.error || "corrupt_chat",
        reason: fileResult.reason || "Persisted chat file is corrupt or invalid",
      };
    }

    const currentChat = fileResult.exists ? fileResult.chat : null;
    const currentRevision = currentChat ? currentChat.revision : 0;
    const previousUpdatedAtMs = currentChat ? currentChat.updatedAtMs : 0;
    const existingTurns = currentChat ? deepClone(currentChat.turns) : [];

    const existingTurn = existingTurns.find((t) => t.commandId === commandId);
    if (existingTurn) {
      if (existingTurn.userText === text) {
        // Idempotent retry with identical commandId and text
        return {
          ok: true,
          chat: deepClone(currentChat),
          idempotent: true,
        };
      }
      return {
        ok: false,
        error: "conflict",
        reason: `Turn with commandId "${commandId}" already exists with different user text`,
      };
    }

    const turnCreatedAtMs = createdAtMs !== undefined ? createdAtMs : readClock(nowFn, previousUpdatedAtMs);
    if (turnCreatedAtMs === null) {
      return { ok: false, error: "invalid_clock", reason: "Clock returned invalid timestamp" };
    }

    const newTurn = {
      commandId,
      userText: text,
      assistantText: null,
      createdAtMs: turnCreatedAtMs,
      completedAtMs: null,
    };

    const newTurns = [...existingTurns, newTurn];
    const newUpdatedAtMs = readClock(nowFn, Math.max(previousUpdatedAtMs, turnCreatedAtMs));
    if (newUpdatedAtMs === null) {
      return { ok: false, error: "invalid_clock", reason: "Clock returned invalid timestamp" };
    }

    const newChat = {
      schemaVersion: SCHEMA_VERSION,
      petId,
      revision: currentRevision + 1,
      turns: newTurns,
      updatedAtMs: newUpdatedAtMs,
    };

    applyBoundsAndEviction(newChat);

    try {
      atomicWriteJson(chatFilePath, newChat, fsApi);
    } catch (err) {
      return {
        ok: false,
        error: "io_error",
        reason: `Failed to persist chat file: ${err.message}`,
      };
    }

    return {
      ok: true,
      chat: deepClone(newChat),
    };
  }

  function completeTurn(options) {
    if (arguments.length !== 1 || !hasOnlyAllowedKeys(options, COMPLETE_TURN_ALLOWED_KEYS)) {
      return { ok: false, error: "invalid_options", reason: "Invalid options provided to completeTurn" };
    }

    const { petId, commandId, assistantText, completedAtMs } = options;

    if (!isSafePetId(petId)) {
      return { ok: false, error: "invalid_pet_id", reason: "Invalid petId" };
    }

    if (!isSafeId(commandId)) {
      return { ok: false, error: "invalid_command_id", reason: "Invalid commandId" };
    }

    if (typeof assistantText !== "string") {
      return { ok: false, error: "invalid_assistant_text", reason: "assistantText must be a string" };
    }

    if (completedAtMs !== undefined) {
      if (typeof completedAtMs !== "number" || !Number.isSafeInteger(completedAtMs) || completedAtMs < 0) {
        return { ok: false, error: "invalid_timestamp", reason: "completedAtMs must be a non-negative safe integer" };
      }
    }

    const sanitizedAssistantText = sanitizeAssistantText(assistantText);

    const chatFilePath = getChatFilePath(petId);
    const fileResult = readChatFile(chatFilePath, fsApi, petId);

    if (fileResult.corrupt) {
      return {
        ok: false,
        error: fileResult.error || "corrupt_chat",
        reason: fileResult.reason || "Persisted chat file is corrupt or invalid",
      };
    }

    if (!fileResult.exists) {
      return {
        ok: false,
        error: "turn_not_found",
        reason: "Chat file does not exist",
      };
    }

    const currentChat = fileResult.chat;
    const currentTurns = deepClone(currentChat.turns);
    const turnIndex = currentTurns.findIndex((t) => t.commandId === commandId);

    if (turnIndex === -1) {
      return {
        ok: false,
        error: "turn_not_found",
        reason: `Turn with commandId "${commandId}" not found`,
      };
    }

    const turn = currentTurns[turnIndex];

    if (turn.assistantText !== null) {
      if (turn.assistantText === sanitizedAssistantText) {
        return {
          ok: true,
          chat: deepClone(currentChat),
          idempotent: true,
        };
      }
      return {
        ok: false,
        error: "conflict",
        reason: `Turn with commandId "${commandId}" already completed with different assistant text`,
      };
    }

    const turnCompletedAtMs =
      completedAtMs !== undefined
        ? completedAtMs
        : readClock(nowFn, Math.max(turn.createdAtMs, currentChat.updatedAtMs));

    if (turnCompletedAtMs === null) {
      return { ok: false, error: "invalid_clock", reason: "Clock returned invalid timestamp" };
    }

    if (turnCompletedAtMs < turn.createdAtMs) {
      return {
        ok: false,
        error: "invalid_timestamp",
        reason: "completedAtMs cannot be earlier than createdAtMs",
      };
    }

    turn.assistantText = sanitizedAssistantText;
    turn.completedAtMs = turnCompletedAtMs;

    const newUpdatedAtMs = readClock(nowFn, Math.max(currentChat.updatedAtMs, turnCompletedAtMs));
    if (newUpdatedAtMs === null) {
      return { ok: false, error: "invalid_clock", reason: "Clock returned invalid timestamp" };
    }

    const newChat = {
      schemaVersion: SCHEMA_VERSION,
      petId,
      revision: currentChat.revision + 1,
      turns: currentTurns,
      updatedAtMs: newUpdatedAtMs,
    };

    applyBoundsAndEviction(newChat);

    try {
      atomicWriteJson(chatFilePath, newChat, fsApi);
    } catch (err) {
      return {
        ok: false,
        error: "io_error",
        reason: `Failed to persist chat file: ${err.message}`,
      };
    }

    return {
      ok: true,
      chat: deepClone(newChat),
    };
  }

  function clearChat(options) {
    if (arguments.length !== 1 || !hasOnlyAllowedKeys(options, CLEAR_CHAT_ALLOWED_KEYS)) {
      return { ok: false, error: "invalid_options", reason: "Invalid options provided to clearChat" };
    }

    const { petId } = options;
    if (!isSafePetId(petId)) {
      return { ok: false, error: "invalid_pet_id", reason: "Invalid petId" };
    }

    const chatFilePath = getChatFilePath(petId);
    let cleared = false;
    try {
      let exists = false;
      try {
        exists = fsApi.existsSync(chatFilePath);
      } catch (err) {
        return {
          ok: false,
          error: "io_error",
          reason: `Failed to check chat file: ${err.message}`,
        };
      }

      if (exists) {
        fsApi.unlinkSync(chatFilePath);
        cleared = true;
      }
    } catch (err) {
      return {
        ok: false,
        error: "io_error",
        reason: `Failed to clear chat file: ${err.message}`,
      };
    }

    return {
      ok: true,
      cleared,
      chat: {
        schemaVersion: SCHEMA_VERSION,
        petId,
        revision: 0,
        turns: [],
        updatedAtMs: null,
      },
    };
  }

  return {
    readChat,
    recordUserMessage,
    completeTurn,
    clearChat,
  };
}

module.exports = {
  DISALLOWED_CONTROL_RE,
  MAX_ASSISTANT_TEXT_BYTES,
  MAX_CHAT_FILE_BYTES,
  MAX_CHAT_TURNS,
  MAX_USER_TEXT_CODE_POINTS,
  createPetChatStore,
  sanitizeAssistantText,
  truncateUtf8Bytes,
};
