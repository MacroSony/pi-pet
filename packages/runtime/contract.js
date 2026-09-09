"use strict";

// Phase 1 is deliberately a small, versioned boundary. Fields listed here
// are the fields that are actually written/consumed today, not a promise of a
// future command or reaction transport.

const API_CONTRACT_VERSION = "1";
const PET_STATUS_SCHEMA = Object.freeze({
  name: "PetStatus",
  version: API_CONTRACT_VERSION,
  fields: Object.freeze({
    state: "idle|thinking|reading|editing|searching|running|delegating|waiting|error|closed|offline",
    detail: "string",
    tool: "string",
    event: "string",
    sessionId: "string",
    sessionName: "string",
    timestamp: "ISO-8601 string",
  }),
  required: Object.freeze([
    "state", "detail", "tool", "event", "sessionId", "sessionName", "timestamp",
  ]),
});

const STATUS_FILE_SCHEMA = Object.freeze({
  name: "PetStatusFile",
  version: API_CONTRACT_VERSION,
  path: "<statusDir>/status-<session_id>.json",
  fields: Object.freeze({
    state: PET_STATUS_SCHEMA.fields.state,
    detail: "string",
    tool: "string",
    event: "string",
    session_id: "string",
    session_name: "string",
    timestamp: "ISO-8601 string",
  }),
  required: Object.freeze([
    "state", "detail", "tool", "event", "session_id", "session_name", "timestamp",
  ]),
});

// The renderer has a reaction file/CLI today, but phase 1 does not emit one.
// These fields remain documented so a later seam cannot accidentally confuse
// renderer-local reaction input with this runtime API.
const REACTION_SCHEMA = Object.freeze({
  name: "RendererReactionFile",
  version: API_CONTRACT_VERSION,
  // The Rust renderer implements/consumes this renderer-local file. The
  // phase-1 runtime deliberately neither emits nor consumes it.
  rendererImplemented: true,
  runtimeImplemented: false,
  location: "~/.claude/pet-data/reaction-<session_id>.json (renderer default)",
  fields: Object.freeze({
    id: "renderer-generated reaction identifier",
    emotion: "happy|sad|shocked|celebrate|shy|drag",
    message: "reserved renderer message string",
    speak: "reserved renderer speech flag",
    ts: "renderer timestamp in milliseconds",
    ttl_ms: "renderer lifetime in milliseconds",
  }),
  required: Object.freeze(["id", "emotion", "message", "speak", "ts", "ttl_ms"]),
  emittedByRuntime: false,
  note: "Implemented in the renderer only; no reaction/message/speak channel is part of the phase-1 runtime bridge.",
});

const API_CONTRACT = Object.freeze({
  name: "pi-pet-runtime",
  version: API_CONTRACT_VERSION,
  entryPoint: "createClawdPresentationBridge",
  status: PET_STATUS_SCHEMA,
  statusFile: STATUS_FILE_SCHEMA,
  reaction: REACTION_SCHEMA,
});

module.exports = {
  API_CONTRACT,
  API_CONTRACT_VERSION,
  PET_STATUS_SCHEMA,
  REACTION_SCHEMA,
  STATUS_FILE_SCHEMA,
};
