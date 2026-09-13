"use strict";

/**
 * Team Board Store Module
 *
 * Concurrency & OCC Architecture Note:
 * Optimistic Concurrency Control (OCC) revision checking in this store assumes
 * all mutation operations are coordinated through a canonical single-writer coordinator
 * process (e.g., the local runtime coordinator). This implementation does NOT claim or
 * provide distributed cross-process file-level CAS (Compare-And-Swap) or multi-process OCC
 * locks without an external coordinator.
 *
 * Trusted Adapter Note:
 * The trusted adapter authenticates the actor prior to calling team board store methods.
 * The store verifies actor shape, membership, and role permissions against the authoritative TeamStore.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  MAX_ENVELOPE_SIZE,
  atomicWriteJson,
  isSafePetId,
} = require("./internal");
const { createTeamStore, isSafeTeamId } = require("./team-store");

const SCHEMA_VERSION = "1";
const MAX_BOARD_MARKDOWN_BYTES = 8192;

const DISALLOWED_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

const BOARD_EXACT_KEYS = new Set([
  "schemaVersion",
  "teamId",
  "revision",
  "markdown",
  "updatedAtMs",
  "updatedByPetId",
]);

const READ_BOARD_ALLOWED_KEYS = new Set(["teamId", "actor"]);
const WRITE_BOARD_ALLOWED_KEYS = new Set(["teamId", "actor", "baseRevision", "markdown"]);
const ACTOR_ALLOWED_KEYS = new Set(["kind", "petId"]);

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

function isStrictMemberActor(actor) {
  if (!isPlainObject(actor)) {
    return false;
  }
  const keys = Object.keys(actor);
  if (keys.length !== ACTOR_ALLOWED_KEYS.size) {
    return false;
  }
  for (const k of keys) {
    if (!ACTOR_ALLOWED_KEYS.has(k)) {
      return false;
    }
  }
  if (actor.kind !== "member") {
    return false;
  }
  if (!isSafePetId(actor.petId)) {
    return false;
  }
  return true;
}

function isValidMarkdown(markdown) {
  if (typeof markdown !== "string") {
    return false;
  }
  if (Buffer.byteLength(markdown, "utf8") > MAX_BOARD_MARKDOWN_BYTES) {
    return false;
  }
  if (DISALLOWED_CONTROL_RE.test(markdown)) {
    return false;
  }
  return true;
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
  // Wall clocks can move backwards. Keep persisted timestamps monotonic
  // without weakening revision-based conflict detection.
  return Math.max(nowMs, floorMs);
}

function validatePersistedBoardRecord(board, expectedTeamId) {
  if (!isPlainObject(board)) {
    return false;
  }
  const keys = Object.keys(board);
  if (keys.length !== BOARD_EXACT_KEYS.size) {
    return false;
  }
  for (const key of keys) {
    if (!BOARD_EXACT_KEYS.has(key)) {
      return false;
    }
  }

  if (board.schemaVersion !== SCHEMA_VERSION) {
    return false;
  }
  if (!isSafeTeamId(board.teamId) || board.teamId !== expectedTeamId) {
    return false;
  }
  if (
    typeof board.revision !== "number" ||
    !Number.isSafeInteger(board.revision) ||
    board.revision < 1
  ) {
    return false;
  }
  if (!isValidMarkdown(board.markdown)) {
    return false;
  }
  if (
    typeof board.updatedAtMs !== "number" ||
    !Number.isSafeInteger(board.updatedAtMs) ||
    board.updatedAtMs < 0
  ) {
    return false;
  }
  if (!isSafePetId(board.updatedByPetId)) {
    return false;
  }

  return true;
}

function readBoardFile(boardFilePath, fsApi, teamId) {
  try {
    if (!fsApi.existsSync(boardFilePath)) {
      return { exists: false };
    }
    const stat = fsApi.statSync(boardFilePath);
    if (stat.size > MAX_ENVELOPE_SIZE) {
      return { exists: true, corrupt: true, error: "corrupt_board", reason: "Board file size exceeds maximum envelope limit" };
    }
    const raw = fsApi.readFileSync(boardFilePath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_ENVELOPE_SIZE) {
      return { exists: true, corrupt: true, error: "corrupt_board", reason: "Board file byte length exceeds maximum envelope limit" };
    }
    const parsed = JSON.parse(raw);
    if (!validatePersistedBoardRecord(parsed, teamId)) {
      return { exists: true, corrupt: true, error: "corrupt_board", reason: "Board record schema validation failed" };
    }
    if (path.basename(boardFilePath) !== `board-${teamId}.json`) {
      return { exists: true, corrupt: true, error: "corrupt_board", reason: "Board file name does not match teamId" };
    }
    return { exists: true, corrupt: false, board: parsed };
  } catch (err) {
    return { exists: true, corrupt: true, error: "corrupt_board", reason: `Failed to read board file: ${err.message}` };
  }
}

function createTeamBoardStore(config = {}) {
  const fsApi = config.fsApi || fs;
  const env = config.env || process.env;
  const nowFn = typeof config.now === "function" ? config.now : Date.now;

  const dataDir = resolveDataDir(config, env);
  const teamsDir = path.join(dataDir, "teams");

  const teamStore =
    config.teamStore ||
    createTeamStore({
      dataDir,
      env,
      fsApi,
      now: nowFn,
    });

  function getBoardFilePath(teamId) {
    return path.join(teamsDir, `board-${teamId}.json`);
  }

  function readBoard(options) {
    if (arguments.length !== 1 || !hasOnlyAllowedKeys(options, READ_BOARD_ALLOWED_KEYS)) {
      return { ok: false, error: "invalid_options", reason: "Invalid options provided to readBoard" };
    }

    const { teamId, actor } = options;

    if (!isSafeTeamId(teamId)) {
      return { ok: false, error: "invalid_team_id", reason: "Invalid teamId" };
    }

    if (!isStrictMemberActor(actor)) {
      return { ok: false, error: "forbidden", reason: "Invalid actor: actor must be { kind: 'member', petId }" };
    }

    // Authoritatively check Team state and Actor permissions
    const team = teamStore.getTeam({ teamId });
    if (!team) {
      return { ok: false, error: "team_not_found", reason: "Team not found" };
    }
    if (team.status !== "active") {
      return { ok: false, error: "team_not_active", reason: "Team is not active" };
    }

    const member = Array.isArray(team.members) && team.members.find((m) => m.petId === actor.petId);
    if (!member) {
      return { ok: false, error: "forbidden", reason: `Pet "${actor.petId}" is not an active member of team "${teamId}"` };
    }
    // Observer role is allowed to read

    const boardFilePath = getBoardFilePath(teamId);
    const fileResult = readBoardFile(boardFilePath, fsApi, teamId);

    if (fileResult.corrupt) {
      return {
        ok: false,
        error: fileResult.error || "corrupt_board",
        reason: fileResult.reason || "Persisted board file is corrupt or invalid",
      };
    }

    if (!fileResult.exists) {
      // Absent valid board returns synthetic revision 0 empty markdown with null updated fields
      return {
        ok: true,
        board: {
          schemaVersion: SCHEMA_VERSION,
          teamId,
          revision: 0,
          markdown: "",
          updatedAtMs: null,
          updatedByPetId: null,
        },
      };
    }

    return {
      ok: true,
      board: deepClone(fileResult.board),
    };
  }

  function writeBoard(options) {
    if (arguments.length !== 1 || !hasOnlyAllowedKeys(options, WRITE_BOARD_ALLOWED_KEYS)) {
      return { ok: false, error: "invalid_options", reason: "Invalid options provided to writeBoard" };
    }

    const { teamId, actor, baseRevision, markdown } = options;

    if (!isSafeTeamId(teamId)) {
      return { ok: false, error: "invalid_team_id", reason: "Invalid teamId" };
    }

    if (!isStrictMemberActor(actor)) {
      return { ok: false, error: "forbidden", reason: "Invalid actor: actor must be { kind: 'member', petId }" };
    }

    if (typeof baseRevision !== "number" || !Number.isSafeInteger(baseRevision) || baseRevision < 0) {
      return { ok: false, error: "invalid_revision", reason: "baseRevision must be a non-negative safe integer" };
    }

    if (typeof markdown !== "string") {
      return { ok: false, error: "invalid_markdown", reason: "markdown must be a string" };
    }

    if (Buffer.byteLength(markdown, "utf8") > MAX_BOARD_MARKDOWN_BYTES) {
      return {
        ok: false,
        error: "markdown_too_large",
        reason: `Markdown byte length (${Buffer.byteLength(markdown, "utf8")}) exceeds maximum limit of ${MAX_BOARD_MARKDOWN_BYTES} bytes`,
      };
    }

    if (DISALLOWED_CONTROL_RE.test(markdown)) {
      return { ok: false, error: "invalid_markdown", reason: "Markdown contains disallowed control characters" };
    }

    // Authoritatively check Team state and Actor permissions
    const team = teamStore.getTeam({ teamId });
    if (!team) {
      return { ok: false, error: "team_not_found", reason: "Team not found" };
    }
    if (team.status !== "active") {
      return { ok: false, error: "team_not_active", reason: "Team is not active" };
    }

    const member = Array.isArray(team.members) && team.members.find((m) => m.petId === actor.petId);
    if (!member) {
      return { ok: false, error: "forbidden", reason: `Pet "${actor.petId}" is not an active member of team "${teamId}"` };
    }

    if (member.role === "observer") {
      return { ok: false, error: "forbidden", reason: "Observer members cannot write to board" };
    }

    const boardFilePath = getBoardFilePath(teamId);
    const fileResult = readBoardFile(boardFilePath, fsApi, teamId);

    if (fileResult.corrupt) {
      return {
        ok: false,
        error: fileResult.error || "corrupt_board",
        reason: fileResult.reason || "Persisted board file is corrupt or invalid",
      };
    }

    const currentRevision = fileResult.exists ? fileResult.board.revision : 0;
    const previousUpdatedAtMs = fileResult.exists ? fileResult.board.updatedAtMs : (team.updatedAtMs || team.createdAtMs || 0);

    if (baseRevision !== currentRevision) {
      return {
        ok: false,
        error: "conflict",
        reason: `Revision mismatch: expected ${currentRevision}, got ${baseRevision}`,
        currentRevision,
      };
    }

    const nowMs = readClock(nowFn, previousUpdatedAtMs);
    if (nowMs === null) {
      return {
        ok: false,
        error: "invalid_clock",
        reason: "Clock returned invalid timestamp",
      };
    }

    const newBoard = {
      schemaVersion: SCHEMA_VERSION,
      teamId,
      revision: currentRevision + 1,
      markdown,
      updatedAtMs: nowMs,
      updatedByPetId: actor.petId,
    };

    try {
      atomicWriteJson(boardFilePath, newBoard, fsApi);
    } catch (err) {
      return {
        ok: false,
        error: "io_error",
        reason: `Failed to persist board: ${err.message}`,
        currentRevision,
      };
    }

    return {
      ok: true,
      board: deepClone(newBoard),
    };
  }

  return {
    readBoard,
    writeBoard,
  };
}

module.exports = {
  MAX_BOARD_MARKDOWN_BYTES,
  createTeamBoardStore,
};
