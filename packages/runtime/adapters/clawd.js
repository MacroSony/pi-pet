"use strict";

// Compatibility adapter for Clawd's authoritative session snapshot shape.
// Keep all Clawd field names and lifecycle interpretation here; the runtime
// below this file only receives neutral PetStatus values.

const { createPetRuntime, defaultStatusDir } = require("../runtime");
const { derivePetId } = require("../identity");
const { createTeamStore } = require("../team-store");
const { createTeamBoardStore } = require("../team-board-store");

const DEFAULT_AGENT_IDS = ["pi"];
const MAX_LABEL_LENGTH = 120;
const MAX_DETAIL_LENGTH = 180;
const stablePetSessionId = derivePetId;

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
  const displayTitle = normalizeText(entry && entry.displayTitle, MAX_LABEL_LENGTH);
  const agent = normalizeText(entry && (entry.agentName || entry.agentId), 60);
  if (displayTitle) {
    if (!agent || displayTitle.toLowerCase() === agent.toLowerCase()
      || displayTitle.toLowerCase().endsWith(` · ${agent.toLowerCase()}`)) {
      return displayTitle;
    }
    const suffix = ` · ${agent}`;
    return `${Array.from(displayTitle).slice(0, Math.max(0, MAX_LABEL_LENGTH - Array.from(suffix).length)).join("")}${suffix}`;
  }
  const parts = [
    normalizeText(entry && entry.sourceDisplayLabel, 60),
    normalizeText(entry && entry.agentName, 60) || normalizeText(entry && entry.agentId, 60),
    normalizeText(entry && entry.displayFolder, 60),
  ].filter(Boolean);
  return (parts.join(" / ") || "Agent session").slice(0, MAX_LABEL_LENGTH);
}

function buildTeamPresentation(entry, snapshotSessions, options = {}) {
  const teamStore = options.teamStore;
  const teamBoardStore = options.teamBoardStore;
  if (!teamStore || typeof teamStore.listTeamsForPet !== "function") return null;

  const petId = stablePetSessionId(entry);
  const teams = teamStore.listTeamsForPet({ petId });
  const activeTeams = Array.isArray(teams) ? teams.filter((team) => team && team.status === "active") : [];
  // Lite Team promises at most one active Team per pet. Fail closed if the
  // persisted state violates that invariant rather than presenting an
  // arbitrary relationship.
  if (activeTeams.length !== 1) return null;

  const team = activeTeams[0];
  const callerMember = Array.isArray(team.members)
    ? team.members.find((member) => member && member.petId === petId)
    : null;
  if (!callerMember) return null;

  const entriesByPetId = new Map();
  for (const candidate of Array.isArray(snapshotSessions) ? snapshotSessions : []) {
    if (!candidate || candidate.agentId !== "pi" || candidate.headless === true) continue;
    try {
      entriesByPetId.set(stablePetSessionId(candidate), candidate);
    } catch {}
  }

  const members = team.members.map((member, index) => {
    const candidate = entriesByPetId.get(member.petId);
    return {
      displayName: candidate ? sessionName(candidate) : `Teammate ${index + 1}`,
      role: member.role,
      state: candidate ? presentationState(candidate) : "offline",
      host: candidate
        ? (normalizeText(candidate.sourceDisplayLabel, 60) || normalizeText(candidate.profileId, 60) || "local")
        : "offline",
    };
  });

  let board = { status: "unavailable", revision: null, markdown: "", updatedBy: "" };
  if (teamBoardStore && typeof teamBoardStore.readBoard === "function") {
    const result = teamBoardStore.readBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId },
    });
    if (result && result.ok && result.board) {
      const writerIndex = team.members.findIndex((member) => member.petId === result.board.updatedByPetId);
      const writer = writerIndex >= 0 ? members[writerIndex] : null;
      board = {
        status: "ready",
        revision: result.board.revision,
        markdown: result.board.markdown,
        updatedBy: writer ? writer.displayName : "",
      };
    }
  }

  return {
    name: normalizeText(team.name, 80),
    role: callerMember.role,
    members,
    board,
  };
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

function toPetStatus(entry, now = new Date(), presentation = {}) {
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
    team: presentation.team || null,
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
    team: status.team,
  };
}

function createClawdPresentationBridge(options = {}) {
  const enabled = options.enabled === true;
  const agentIds = normalizeAgentIds(options.agentIds);
  const runtime = createPetRuntime(options);
  const teamStore = options.teamStore || createTeamStore({ env: options.env });
  const teamBoardStore = options.teamBoardStore || createTeamBoardStore({
    env: options.env,
    teamStore,
  });

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
      const acceptedSessions = snapshot.sessions.filter(accepted);
      const statuses = acceptedSessions.map((entry) => toPetStatus(entry, now(), {
        team: buildTeamPresentation(entry, acceptedSessions, { teamStore, teamBoardStore }),
      }));
      return runtime.onSnapshot({ statuses });
    },
    statusPathFor: runtime.statusPathFor,
    get enabled() { return runtime.enabled; },
  };
}

module.exports = {
  DEFAULT_AGENT_IDS,
  activityDetail,
  buildTeamPresentation,
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
