"use strict";

/**
 * Team Store Module
 *
 * Concurrency & OCC Architecture Note:
 * Optimistic Concurrency Control (OCC) revision checking in this store assumes
 * all mutation operations are coordinated through a canonical single-writer coordinator
 * process (e.g., the local runtime coordinator). This implementation does NOT claim or
 * provide distributed cross-process file-level CAS (Compare-And-Swap) or multi-process OCC
 * locks without an external coordinator.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  MAX_ENVELOPE_SIZE,
  atomicWriteJson,
  isSafePetId,
} = require("./internal");

const SCHEMA_VERSION = "1";
const MAX_TEAM_MEMBERS = 8;
const MIN_TEAM_NAME_LENGTH = 1;
const MAX_TEAM_NAME_LENGTH = 80;
const TEAM_MEMBERSHIP_POLICY = "user_only";
const MAX_ID_GENERATION_ATTEMPTS = 5;

const VALID_TEAM_ROLES = Object.freeze(["leader", "member", "observer"]);
const VALID_TEAM_ROLES_SET = new Set(VALID_TEAM_ROLES);

const VALID_TEAM_STATUSES = Object.freeze(["active", "dissolved"]);
const VALID_TEAM_STATUSES_SET = new Set(VALID_TEAM_STATUSES);

const C0_C1_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/;

const TEAM_EXACT_KEYS = new Set([
  "schemaVersion",
  "teamId",
  "name",
  "status",
  "revision",
  "membershipPolicy",
  "leaderPetId",
  "members",
  "createdAtMs",
  "updatedAtMs",
]);

const MEMBER_EXACT_KEYS = new Set([
  "petId",
  "role",
  "joinedAtMs",
]);

const CREATE_TEAM_ALLOWED_KEYS = new Set(["name", "leaderPetId", "members", "actor"]);
const MEMBER_INPUT_ALLOWED_KEYS = new Set(["petId", "role"]);
const GET_TEAM_ALLOWED_KEYS = new Set(["teamId"]);
const LIST_TEAMS_ALLOWED_KEYS = new Set(["petId"]);
const ADD_MEMBER_ALLOWED_KEYS = new Set(["teamId", "petId", "role", "baseRevision", "actor"]);
const REMOVE_MEMBER_ALLOWED_KEYS = new Set(["teamId", "petId", "baseRevision", "actor"]);
const SET_MEMBER_ROLE_ALLOWED_KEYS = new Set(["teamId", "petId", "role", "baseRevision", "actor"]);
const DISSOLVE_TEAM_ALLOWED_KEYS = new Set(["teamId", "baseRevision", "actor"]);

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

function isSafeTeamId(teamId) {
  return (
    typeof teamId === "string" &&
    /^team_[A-Za-z0-9_-]{1,60}$/.test(teamId) &&
    !teamId.includes("..")
  );
}

function generateTeamId(randomBytesFn = crypto.randomBytes) {
  return `team_${randomBytesFn(12).toString("hex")}`;
}

function deepClone(obj) {
  if (typeof structuredClone === "function") {
    return structuredClone(obj);
  }
  return JSON.parse(JSON.stringify(obj));
}

function isValidTeamName(name) {
  if (typeof name !== "string") {
    return false;
  }
  if (C0_C1_CONTROL_RE.test(name)) {
    return false;
  }
  const trimmed = name.trim();
  const codePointLength = Array.from(trimmed).length;
  return codePointLength >= MIN_TEAM_NAME_LENGTH && codePointLength <= MAX_TEAM_NAME_LENGTH;
}

function isStrictUserActor(actor) {
  if (!isPlainObject(actor)) {
    return false;
  }
  const keys = Object.keys(actor);
  if (keys.length !== 1 || actor.kind !== "user") {
    return false;
  }
  return true;
}

function validateTeamRecord(team) {
  if (!isPlainObject(team)) {
    return false;
  }
  const teamKeys = Object.keys(team);
  if (teamKeys.length !== TEAM_EXACT_KEYS.size) {
    return false;
  }
  for (const key of teamKeys) {
    if (!TEAM_EXACT_KEYS.has(key)) {
      return false;
    }
  }

  if (team.schemaVersion !== SCHEMA_VERSION) {
    return false;
  }
  if (!isSafeTeamId(team.teamId)) {
    return false;
  }
  if (!isValidTeamName(team.name)) {
    return false;
  }
  if (!VALID_TEAM_STATUSES_SET.has(team.status)) {
    return false;
  }
  if (
    typeof team.revision !== "number" ||
    !Number.isSafeInteger(team.revision) ||
    team.revision < 1
  ) {
    return false;
  }
  if (team.membershipPolicy !== TEAM_MEMBERSHIP_POLICY) {
    return false;
  }
  if (!isSafePetId(team.leaderPetId)) {
    return false;
  }

  if (
    typeof team.createdAtMs !== "number" ||
    !Number.isSafeInteger(team.createdAtMs) ||
    team.createdAtMs < 0
  ) {
    return false;
  }
  if (
    typeof team.updatedAtMs !== "number" ||
    !Number.isSafeInteger(team.updatedAtMs) ||
    team.updatedAtMs < team.createdAtMs
  ) {
    return false;
  }

  if (!Array.isArray(team.members)) {
    return false;
  }
  if (team.members.length < 1 || team.members.length > MAX_TEAM_MEMBERS) {
    return false;
  }

  const seenPetIds = new Set();
  let leaderCount = 0;
  for (const m of team.members) {
    if (!isPlainObject(m)) {
      return false;
    }
    const memberKeys = Object.keys(m);
    if (memberKeys.length !== MEMBER_EXACT_KEYS.size) {
      return false;
    }
    for (const k of memberKeys) {
      if (!MEMBER_EXACT_KEYS.has(k)) {
        return false;
      }
    }

    if (!isSafePetId(m.petId) || seenPetIds.has(m.petId)) {
      return false;
    }
    seenPetIds.add(m.petId);

    if (!VALID_TEAM_ROLES_SET.has(m.role)) {
      return false;
    }
    if (
      typeof m.joinedAtMs !== "number" ||
      !Number.isSafeInteger(m.joinedAtMs) ||
      m.joinedAtMs < team.createdAtMs ||
      m.joinedAtMs > team.updatedAtMs
    ) {
      return false;
    }
    if (m.role === "leader") {
      leaderCount++;
      if (m.petId !== team.leaderPetId) {
        return false;
      }
    }
  }

  if (leaderCount !== 1) {
    return false;
  }
  if (!seenPetIds.has(team.leaderPetId)) {
    return false;
  }

  return true;
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
  // Wall clocks can move backwards. Keep persisted Team timestamps monotonic
  // without weakening revision-based conflict detection.
  return Math.max(nowMs, floorMs);
}

function readTeamFile(teamFilePath, fsApi) {
  try {
    if (!fsApi.existsSync(teamFilePath)) {
      return null;
    }
    const stat = fsApi.statSync(teamFilePath);
    if (stat.size > MAX_ENVELOPE_SIZE) {
      return null;
    }
    const raw = fsApi.readFileSync(teamFilePath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_ENVELOPE_SIZE) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!validateTeamRecord(parsed)) {
      return null;
    }
    if (path.basename(teamFilePath) !== `team-${parsed.teamId}.json`) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function createTeamStore(config = {}) {
  const fsApi = config.fsApi || fs;
  const env = config.env || process.env;
  const nowFn = typeof config.now === "function" ? config.now : Date.now;
  const randomBytesFn = typeof config.randomBytes === "function" ? config.randomBytes : crypto.randomBytes;

  const dataDir = resolveDataDir(config, env);
  const teamsDir = path.join(dataDir, "teams");

  function getTeamFilePath(teamId) {
    return path.join(teamsDir, `team-${teamId}.json`);
  }

  function createTeam(options) {
    if (arguments.length !== 1 || !hasOnlyAllowedKeys(options, CREATE_TEAM_ALLOWED_KEYS)) {
      return { ok: false, error: "invalid_options", reason: "Invalid options provided to createTeam" };
    }

    if (!isStrictUserActor(options.actor)) {
      return {
        ok: false,
        error: "forbidden",
        reason: "Mutation requires explicit user actor",
      };
    }

    if (!isValidTeamName(options.name)) {
      return {
        ok: false,
        error: "invalid_name",
        reason: `Team name must be between ${MIN_TEAM_NAME_LENGTH} and ${MAX_TEAM_NAME_LENGTH} code points without control characters`,
      };
    }
    const trimmedName = options.name.trim();

    if (!options.leaderPetId || !isSafePetId(options.leaderPetId)) {
      return {
        ok: false,
        error: "invalid_leader",
        reason: "Invalid leaderPetId: must be a valid safe pet identity",
      };
    }
    const leaderPetId = options.leaderPetId;

    const nowMs = readClock(nowFn);
    if (nowMs === null) {
      return {
        ok: false,
        error: "invalid_clock",
        reason: "Clock returned invalid timestamp",
      };
    }

    const validatedMembers = [];
    const seenPetIds = new Set();

    let rawMembers = [];
    if (options.members !== undefined) {
      if (!Array.isArray(options.members)) {
        return {
          ok: false,
          error: "invalid_members",
          reason: "members must be an array if provided",
        };
      }
      rawMembers = options.members;
    }

    let leaderFoundInInput = false;

    for (const item of rawMembers) {
      let petId;
      let role = "member";

      if (typeof item === "string") {
        petId = item;
      } else if (isPlainObject(item)) {
        if (!hasOnlyAllowedKeys(item, MEMBER_INPUT_ALLOWED_KEYS)) {
          return {
            ok: false,
            error: "invalid_members",
            reason: "Member object contains forbidden or unknown keys (joinedAtMs is disallowed)",
          };
        }
        petId = item.petId;
        if (item.role !== undefined) {
          role = item.role;
        }
      } else {
        return {
          ok: false,
          error: "invalid_members",
          reason: "Each member item must be a pet ID string or a plain object with petId",
        };
      }

      if (!isSafePetId(petId)) {
        return {
          ok: false,
          error: "invalid_pet_id",
          reason: `Invalid member petId: "${petId}"`,
        };
      }

      if (seenPetIds.has(petId)) {
        return {
          ok: false,
          error: "duplicate_member",
          reason: `Duplicate member petId: "${petId}"`,
        };
      }
      seenPetIds.add(petId);

      if (petId === leaderPetId) {
        if (isPlainObject(item) && item.role !== undefined && item.role !== "leader") {
          return {
            ok: false,
            error: "invalid_leader_role",
            reason: "The leader member must have role leader",
          };
        }
        leaderFoundInInput = true;
        role = "leader";
      } else {
        if (role === "leader") {
          return {
            ok: false,
            error: "multiple_leaders",
            reason: "Team cannot have more than one leader",
          };
        }
        if (!VALID_TEAM_ROLES_SET.has(role)) {
          return {
            ok: false,
            error: "invalid_role",
            reason: `Role for ${petId} must be one of: ${VALID_TEAM_ROLES.join(", ")}`,
          };
        }
      }

      validatedMembers.push({
        petId,
        role,
        joinedAtMs: nowMs,
      });
    }

    if (!leaderFoundInInput) {
      validatedMembers.unshift({
        petId: leaderPetId,
        role: "leader",
        joinedAtMs: nowMs,
      });
      seenPetIds.add(leaderPetId);
    }

    if (validatedMembers.length > MAX_TEAM_MEMBERS) {
      return {
        ok: false,
        error: "max_members_exceeded",
        reason: `Team cannot exceed maximum of ${MAX_TEAM_MEMBERS} members (got ${validatedMembers.length})`,
      };
    }

    let teamId = null;
    let teamFilePath = null;
    for (let attempt = 0; attempt < MAX_ID_GENERATION_ATTEMPTS; attempt++) {
      const candidateId = generateTeamId(randomBytesFn);
      const candidatePath = getTeamFilePath(candidateId);
      if (!fsApi.existsSync(candidatePath)) {
        teamId = candidateId;
        teamFilePath = candidatePath;
        break;
      }
    }

    if (!teamId) {
      return {
        ok: false,
        error: "id_collision",
        reason: `Failed to generate a unique teamId after ${MAX_ID_GENERATION_ATTEMPTS} attempts`,
      };
    }

    const teamRecord = {
      schemaVersion: SCHEMA_VERSION,
      teamId,
      name: trimmedName,
      status: "active",
      revision: 1,
      membershipPolicy: TEAM_MEMBERSHIP_POLICY,
      leaderPetId,
      members: validatedMembers,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };

    try {
      atomicWriteJson(teamFilePath, teamRecord, fsApi);
    } catch (err) {
      return {
        ok: false,
        error: "io_error",
        reason: `Failed to persist team: ${err.message}`,
      };
    }

    return {
      ok: true,
      team: deepClone(teamRecord),
    };
  }

  function getTeam(options) {
    if (arguments.length !== 1 || !hasOnlyAllowedKeys(options, GET_TEAM_ALLOWED_KEYS)) {
      return null;
    }
    const teamId = options.teamId;
    if (!isSafeTeamId(teamId)) {
      return null;
    }

    const filePath = getTeamFilePath(teamId);
    const record = readTeamFile(filePath, fsApi);
    if (!record) {
      return null;
    }

    return deepClone(record);
  }

  function listTeamsForPet(options) {
    if (arguments.length !== 1 || !hasOnlyAllowedKeys(options, LIST_TEAMS_ALLOWED_KEYS)) {
      return [];
    }
    const petId = options.petId;
    if (!isSafePetId(petId)) {
      return [];
    }

    try {
      if (!fsApi.existsSync(teamsDir)) {
        return [];
      }

      const files = fsApi.readdirSync(teamsDir);
      const results = [];

      for (const file of files) {
        if (!file.endsWith(".json") || file.endsWith(".tmp")) {
          continue;
        }
        const match = file.match(/^team-(team_[A-Za-z0-9_-]{1,60})\.json$/);
        if (!match) {
          continue;
        }

        const filePath = path.join(teamsDir, file);
        const record = readTeamFile(filePath, fsApi);
        if (!record) {
          continue;
        }

        const isMember = record.members.some((m) => m.petId === petId);
        if (isMember) {
          results.push(deepClone(record));
        }
      }

      return results;
    } catch {
      return [];
    }
  }

  function addMember(options) {
    if (arguments.length !== 1 || !hasOnlyAllowedKeys(options, ADD_MEMBER_ALLOWED_KEYS)) {
      return { ok: false, error: "invalid_options", reason: "Invalid options provided to addMember" };
    }

    if (!isStrictUserActor(options.actor)) {
      return {
        ok: false,
        error: "forbidden",
        reason: "Mutation requires explicit user actor",
      };
    }

    const { teamId, petId, baseRevision } = options;
    const role = options.role !== undefined ? options.role : "member";

    if (!isSafeTeamId(teamId)) {
      return { ok: false, error: "invalid_team_id", reason: "Invalid teamId" };
    }
    if (!isSafePetId(petId)) {
      return { ok: false, error: "invalid_pet_id", reason: `Invalid petId: "${petId}"` };
    }

    if (role === "leader") {
      return {
        ok: false,
        error: "cannot_add_as_leader",
        reason: "Cannot add a member directly as leader; use setMemberRole to transfer leadership",
      };
    }
    if (!VALID_TEAM_ROLES_SET.has(role)) {
      return {
        ok: false,
        error: "invalid_role",
        reason: `Role must be one of: ${VALID_TEAM_ROLES.join(", ")}`,
      };
    }

    if (typeof baseRevision !== "number" || !Number.isSafeInteger(baseRevision) || baseRevision < 1) {
      return {
        ok: false,
        error: "invalid_revision",
        reason: "baseRevision must be a positive safe integer",
      };
    }

    const filePath = getTeamFilePath(teamId);
    const team = readTeamFile(filePath, fsApi);
    if (!team) {
      return { ok: false, error: "not_found", reason: "Team not found" };
    }

    if (team.status === "dissolved") {
      return {
        ok: false,
        error: "team_dissolved",
        reason: "Cannot mutate a dissolved team",
        currentRevision: team.revision,
      };
    }

    if (baseRevision !== team.revision) {
      return {
        ok: false,
        error: "conflict",
        reason: `Revision mismatch: expected ${team.revision}, got ${baseRevision}`,
        currentRevision: team.revision,
      };
    }

    const alreadyMember = team.members.some((m) => m.petId === petId);
    if (alreadyMember) {
      return {
        ok: false,
        error: "already_member",
        reason: `Pet "${petId}" is already a member of the team`,
        currentRevision: team.revision,
      };
    }

    if (team.members.length >= MAX_TEAM_MEMBERS) {
      return {
        ok: false,
        error: "max_members_exceeded",
        reason: `Team has reached the maximum of ${MAX_TEAM_MEMBERS} members`,
        currentRevision: team.revision,
      };
    }

    const nowMs = readClock(nowFn, team.updatedAtMs);
    if (nowMs === null) {
      return {
        ok: false,
        error: "invalid_clock",
        reason: "Clock returned invalid timestamp",
      };
    }

    team.members.push({
      petId,
      role,
      joinedAtMs: nowMs,
    });

    team.revision += 1;
    team.updatedAtMs = nowMs;

    try {
      atomicWriteJson(filePath, team, fsApi);
    } catch (err) {
      return {
        ok: false,
        error: "io_error",
        reason: `Failed to persist team update: ${err.message}`,
        currentRevision: team.revision - 1,
      };
    }

    return {
      ok: true,
      team: deepClone(team),
    };
  }

  function removeMember(options) {
    if (arguments.length !== 1 || !hasOnlyAllowedKeys(options, REMOVE_MEMBER_ALLOWED_KEYS)) {
      return { ok: false, error: "invalid_options", reason: "Invalid options provided to removeMember" };
    }

    if (!isStrictUserActor(options.actor)) {
      return {
        ok: false,
        error: "forbidden",
        reason: "Mutation requires explicit user actor",
      };
    }

    const { teamId, petId, baseRevision } = options;

    if (!isSafeTeamId(teamId)) {
      return { ok: false, error: "invalid_team_id", reason: "Invalid teamId" };
    }
    if (!isSafePetId(petId)) {
      return { ok: false, error: "invalid_pet_id", reason: `Invalid petId: "${petId}"` };
    }

    if (typeof baseRevision !== "number" || !Number.isSafeInteger(baseRevision) || baseRevision < 1) {
      return {
        ok: false,
        error: "invalid_revision",
        reason: "baseRevision must be a positive safe integer",
      };
    }

    const filePath = getTeamFilePath(teamId);
    const team = readTeamFile(filePath, fsApi);
    if (!team) {
      return { ok: false, error: "not_found", reason: "Team not found" };
    }

    if (team.status === "dissolved") {
      return {
        ok: false,
        error: "team_dissolved",
        reason: "Cannot mutate a dissolved team",
        currentRevision: team.revision,
      };
    }

    if (baseRevision !== team.revision) {
      return {
        ok: false,
        error: "conflict",
        reason: `Revision mismatch: expected ${team.revision}, got ${baseRevision}`,
        currentRevision: team.revision,
      };
    }

    if (petId === team.leaderPetId) {
      return {
        ok: false,
        error: "cannot_remove_leader",
        reason: "Leader cannot be removed from the team",
        currentRevision: team.revision,
      };
    }

    const memberIndex = team.members.findIndex((m) => m.petId === petId);
    if (memberIndex === -1) {
      return {
        ok: false,
        error: "member_not_found",
        reason: `Pet "${petId}" is not a member of the team`,
        currentRevision: team.revision,
      };
    }

    const nowMs = readClock(nowFn, team.updatedAtMs);
    if (nowMs === null) {
      return {
        ok: false,
        error: "invalid_clock",
        reason: "Clock returned invalid timestamp",
      };
    }

    team.members.splice(memberIndex, 1);
    team.revision += 1;
    team.updatedAtMs = nowMs;

    try {
      atomicWriteJson(filePath, team, fsApi);
    } catch (err) {
      return {
        ok: false,
        error: "io_error",
        reason: `Failed to persist team update: ${err.message}`,
        currentRevision: team.revision - 1,
      };
    }

    return {
      ok: true,
      team: deepClone(team),
    };
  }

  function setMemberRole(options) {
    if (arguments.length !== 1 || !hasOnlyAllowedKeys(options, SET_MEMBER_ROLE_ALLOWED_KEYS)) {
      return { ok: false, error: "invalid_options", reason: "Invalid options provided to setMemberRole" };
    }

    if (!isStrictUserActor(options.actor)) {
      return {
        ok: false,
        error: "forbidden",
        reason: "Mutation requires explicit user actor",
      };
    }

    const { teamId, petId, role, baseRevision } = options;

    if (!isSafeTeamId(teamId)) {
      return { ok: false, error: "invalid_team_id", reason: "Invalid teamId" };
    }
    if (!isSafePetId(petId)) {
      return { ok: false, error: "invalid_pet_id", reason: `Invalid petId: "${petId}"` };
    }

    if (!VALID_TEAM_ROLES_SET.has(role)) {
      return {
        ok: false,
        error: "invalid_role",
        reason: `Role must be one of: ${VALID_TEAM_ROLES.join(", ")}`,
      };
    }

    if (typeof baseRevision !== "number" || !Number.isSafeInteger(baseRevision) || baseRevision < 1) {
      return {
        ok: false,
        error: "invalid_revision",
        reason: "baseRevision must be a positive safe integer",
      };
    }

    const filePath = getTeamFilePath(teamId);
    const team = readTeamFile(filePath, fsApi);
    if (!team) {
      return { ok: false, error: "not_found", reason: "Team not found" };
    }

    if (team.status === "dissolved") {
      return {
        ok: false,
        error: "team_dissolved",
        reason: "Cannot mutate a dissolved team",
        currentRevision: team.revision,
      };
    }

    if (baseRevision !== team.revision) {
      return {
        ok: false,
        error: "conflict",
        reason: `Revision mismatch: expected ${team.revision}, got ${baseRevision}`,
        currentRevision: team.revision,
      };
    }

    const member = team.members.find((m) => m.petId === petId);
    if (!member) {
      return {
        ok: false,
        error: "member_not_found",
        reason: `Pet "${petId}" is not a member of the team`,
        currentRevision: team.revision,
      };
    }

    if (role === "leader") {
      if (petId === team.leaderPetId) {
        // No-op: already leader, no revision change
        return {
          ok: true,
          team: deepClone(team),
        };
      }
      // Atomic leader transfer
      const oldLeader = team.members.find((m) => m.petId === team.leaderPetId);
      if (oldLeader) {
        oldLeader.role = "member";
      }
      member.role = "leader";
      team.leaderPetId = petId;
    } else {
      if (petId === team.leaderPetId) {
        return {
          ok: false,
          error: "cannot_demote_leader",
          reason: "Leader cannot be demoted directly; transfer leadership instead",
          currentRevision: team.revision,
        };
      }
      if (member.role === role) {
        // No-op: role unchanged, no revision change
        return {
          ok: true,
          team: deepClone(team),
        };
      }
      member.role = role;
    }

    const nowMs = readClock(nowFn, team.updatedAtMs);
    if (nowMs === null) {
      return {
        ok: false,
        error: "invalid_clock",
        reason: "Clock returned invalid timestamp",
      };
    }

    team.revision += 1;
    team.updatedAtMs = nowMs;

    try {
      atomicWriteJson(filePath, team, fsApi);
    } catch (err) {
      return {
        ok: false,
        error: "io_error",
        reason: `Failed to persist team update: ${err.message}`,
        currentRevision: team.revision - 1,
      };
    }

    return {
      ok: true,
      team: deepClone(team),
    };
  }

  function dissolveTeam(options) {
    if (arguments.length !== 1 || !hasOnlyAllowedKeys(options, DISSOLVE_TEAM_ALLOWED_KEYS)) {
      return { ok: false, error: "invalid_options", reason: "Invalid options provided to dissolveTeam" };
    }

    if (!isStrictUserActor(options.actor)) {
      return {
        ok: false,
        error: "forbidden",
        reason: "Mutation requires explicit user actor",
      };
    }

    const { teamId, baseRevision } = options;

    if (!isSafeTeamId(teamId)) {
      return { ok: false, error: "invalid_team_id", reason: "Invalid teamId" };
    }

    if (typeof baseRevision !== "number" || !Number.isSafeInteger(baseRevision) || baseRevision < 1) {
      return {
        ok: false,
        error: "invalid_revision",
        reason: "baseRevision must be a positive safe integer",
      };
    }

    const filePath = getTeamFilePath(teamId);
    const team = readTeamFile(filePath, fsApi);
    if (!team) {
      return { ok: false, error: "not_found", reason: "Team not found" };
    }

    if (team.status === "dissolved") {
      return {
        ok: false,
        error: "team_dissolved",
        reason: "Team is already dissolved",
        currentRevision: team.revision,
      };
    }

    if (baseRevision !== team.revision) {
      return {
        ok: false,
        error: "conflict",
        reason: `Revision mismatch: expected ${team.revision}, got ${baseRevision}`,
        currentRevision: team.revision,
      };
    }

    const nowMs = readClock(nowFn, team.updatedAtMs);
    if (nowMs === null) {
      return {
        ok: false,
        error: "invalid_clock",
        reason: "Clock returned invalid timestamp",
      };
    }

    team.status = "dissolved";
    team.revision += 1;
    team.updatedAtMs = nowMs;

    try {
      atomicWriteJson(filePath, team, fsApi);
    } catch (err) {
      return {
        ok: false,
        error: "io_error",
        reason: `Failed to persist team dissolve: ${err.message}`,
        currentRevision: team.revision - 1,
      };
    }

    return {
      ok: true,
      team: deepClone(team),
    };
  }

  return {
    createTeam,
    getTeam,
    listTeamsForPet,
    addMember,
    removeMember,
    setMemberRole,
    dissolveTeam,
  };
}

module.exports = {
  MAX_TEAM_MEMBERS,
  MAX_TEAM_NAME_LENGTH,
  MIN_TEAM_NAME_LENGTH,
  TEAM_MEMBERSHIP_POLICY,
  VALID_TEAM_ROLES,
  VALID_TEAM_STATUSES,
  createTeamStore,
  isSafeTeamId,
};
