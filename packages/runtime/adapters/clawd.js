"use strict";

// Compatibility adapter for Clawd's authoritative session snapshot shape.
// Keep all Clawd field names and lifecycle interpretation here; the runtime
// below this file only receives neutral PetStatus values.

const crypto = require("node:crypto");
const path = require("node:path");
const { createPetRuntime, defaultStatusDir } = require("../runtime");

const DEFAULT_AGENT_IDS = ["pi"];
const PET_ID_PREFIX = "pet_";
const PET_ID_HASH_LENGTH = 24;
const MAX_LABEL_LENGTH = 120;
const MAX_DETAIL_LENGTH = 180;

function normalizeText(value, maxLength = MAX_DETAIL_LENGTH) {
  if (typeof value !== "string") return "";
  return value.replace(/[\0\r\n]+/g, " ").trim().slice(0, maxLength);
}

function normalizeAgentIds(value) {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const ids = source
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return new Set(ids.length > 0 ? ids : DEFAULT_AGENT_IDS);
}

// This formula is intentionally unchanged from Clawd's in-tree bridge.
function stablePetSessionId(entry) {
  const profileId = normalizeText(entry && entry.profileId, 256) || "local";
  const agentId = normalizeText(entry && entry.agentId, 256) || "unknown";
  const rawSessionId = normalizeText(
    (entry && entry.rawSessionId) || (entry && entry.id),
    4096
  ) || "unknown";
  const digest = crypto
    .createHash("sha256")
    .update(`${profileId}\0${agentId}\0${rawSessionId}`, "utf8")
    .digest("hex")
    .slice(0, PET_ID_HASH_LENGTH);
  return `${PET_ID_PREFIX}${digest}`;
}

function statusForTool(toolName) {
  const tool = normalizeText(toolName, 120).toLowerCase();
  if (/(edit|write|replace|create|notebook)/.test(tool)) return "editing";
  if (/(read|view|fetch|list_dir|listdir)/.test(tool)) return "reading";
  if (/(grep|search|find|glob)/.test(tool)) return "searching";
  if (/(agent|skill|delegate|subagent|task)/.test(tool)) return "delegating";
  return "running";
}

function presentationState(entry) {
  const state = normalizeText(entry && entry.state, 80).toLowerCase();
  const rawEvent = normalizeText(entry && entry.lastEvent && entry.lastEvent.rawEvent, 120);

  if (rawEvent === "SessionEnd") return "closed";
  if (state === "error") return "error";
  if (state === "notification") return "waiting";
  if (state === "attention") return "idle";
  if (["sleeping", "dozing", "yawning", "collapsing"].includes(state)) return "offline";
  if (["thinking", "sweeping"].includes(state)) return "thinking";
  if (["carrying", "juggling"].includes(state)) return "delegating";
  if (state === "working") return statusForTool(entry && entry.toolName);
  return "idle";
}

function sessionName(entry) {
  const parts = [
    normalizeText(entry && entry.sourceDisplayLabel, 60),
    normalizeText(entry && entry.agentName, 60) || normalizeText(entry && entry.agentId, 60),
    normalizeText(entry && entry.displayFolder, 60),
  ].filter(Boolean);
  return (parts.join(" / ") || "Agent session").slice(0, MAX_LABEL_LENGTH);
}

function activityDetail(entry, state) {
  const project = normalizeText(entry && entry.displayFolder, 90) || "project";
  const tool = normalizeText(entry && entry.toolName, 80);
  switch (state) {
    case "editing": return `Editing ${project}`;
    case "reading": return `Reading ${project}`;
    case "searching": return "Searching…";
    case "delegating": return "Delegating…";
    case "running": return tool ? `Running ${tool}` : "Running tool…";
    case "thinking": return "Thinking…";
    case "waiting": return "Waiting for approval…";
    case "error": return "Something went wrong";
    case "closed": return "Session ended";
    case "offline": return "Sleeping";
    default: return "Waiting for input";
  }
}

function toPetStatus(entry, now = new Date()) {
  const state = presentationState(entry);
  const updatedAt = Number(entry && entry.updatedAt);
  const timestamp = Number.isFinite(updatedAt) && updatedAt > 0
    ? new Date(updatedAt).toISOString()
    : now.toISOString();
  return {
    state,
    detail: activityDetail(entry, state),
    tool: normalizeText(entry && entry.toolName, 120),
    event: normalizeText(entry && entry.lastEvent && entry.lastEvent.rawEvent, 120),
    sessionId: stablePetSessionId(entry),
    sessionName: sessionName(entry),
    timestamp,
  };
}

// File payload retained as a named compatibility/testing view. The neutral
// adapter output above is the only value passed into createPetRuntime.
function toStatusPayload(entry, now = new Date()) {
  const status = toPetStatus(entry, now);
  return {
    state: status.state,
    detail: status.detail,
    tool: status.tool,
    event: status.event,
    session_id: status.sessionId,
    session_name: status.sessionName,
    timestamp: status.timestamp,
  };
}

function createClawdPresentationBridge(options = {}) {
  const enabled = options.enabled === true;
  const agentIds = normalizeAgentIds(options.agentIds);
  const runtime = createPetRuntime(options);

  function accepted(entry) {
    return !!entry && entry.headless !== true && agentIds.has(entry.agentId);
  }

  return {
    onSessionEnd(entry) {
      if (!enabled || !accepted(entry)) return false;
      return runtime.onSessionEnd(toPetStatus(entry, typeof options.now === "function" ? options.now() : new Date()));
    },
    onSnapshot(snapshot) {
      if (!enabled || !snapshot || !Array.isArray(snapshot.sessions)) {
        return { written: 0, launched: 0 };
      }
      const now = typeof options.now === "function" ? options.now : () => new Date();
      const statuses = snapshot.sessions
        .filter(accepted)
        .map((entry) => toPetStatus(entry, now()));
      return runtime.onSnapshot({ statuses });
    },
    statusPathFor: runtime.statusPathFor,
    get enabled() { return runtime.enabled; },
  };
}

module.exports = {
  DEFAULT_AGENT_IDS,
  activityDetail,
  createClawdPresentationBridge,
  defaultStatusDir,
  normalizeAgentIds,
  presentationState,
  sessionName,
  stablePetSessionId,
  statusForTool,
  toPetStatus,
  toStatusPayload,
};
