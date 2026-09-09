"use strict";

// Dependency-free neutral PetStatus runtime. This module deliberately knows
// nothing about Clawd, agents, or provider-specific snapshots.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn: spawnChild } = require("node:child_process");

const STATUS_FILE_PREFIX = "status-";
const PRESENTATION_COMPARE_KEYS = [
  "state", "detail", "tool", "event", "sessionId", "sessionName",
];

function isTruthyEnv(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function defaultStatusDir(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return path.join(home, ".pi-pet", "status");
}

function presentationChanged(previous, next) {
  if (!previous) return true;
  return PRESENTATION_COMPARE_KEYS.some((key) => previous[key] !== next[key]);
}

function isSafeSessionId(sessionId) {
  // A portable basename on Windows as well as POSIX (including no ADS ':').
  // The Clawd adapter's pet_<hash> IDs already satisfy this contract.
  return typeof sessionId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(sessionId);
}

function assertSafeSessionId(sessionId) {
  if (!isSafeSessionId(sessionId)) {
    throw new Error(`Invalid sessionId for status path: ${String(sessionId)}`);
  }
}

function copyStatus(status) {
  return {
    state: status.state,
    detail: status.detail,
    tool: status.tool,
    event: status.event,
    sessionId: status.sessionId,
    sessionName: status.sessionName,
    timestamp: status.timestamp,
  };
}

function toStatusFilePayload(status) {
  // Neutral runtime callers use camelCase. Snake_case belongs only to this
  // explicit Rust renderer-file projection; do not accept it as runtime input.
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

function writeStatusFile(statusPath, status, fsApi = fs) {
  fsApi.mkdirSync(path.dirname(statusPath), { recursive: true });
  const content = `${JSON.stringify(toStatusFilePayload(status))}\n`;
  const temporaryPath = `${statusPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fsApi.writeFileSync(temporaryPath, content, "utf8");
  try {
    fsApi.renameSync(temporaryPath, statusPath);
  } catch {
    // A few Windows/filesystem combinations reject replacing an existing file
    // through rename. Retain the reliable in-place fallback used by the old
    // bridge rather than dropping state.
    fsApi.writeFileSync(statusPath, content, "utf8");
    try { fsApi.unlinkSync(temporaryPath); } catch {}
  }
}

function createPetRuntime(options = {}) {
  const enabled = options.enabled === true;
  const statusDir = options.statusDir || defaultStatusDir(options.env);
  const rendererBinary = typeof options.rendererBinary === "string" && options.rendererBinary.trim()
    ? options.rendererBinary.trim()
    : null;
  const assetsDir = typeof options.assetsDir === "string" && options.assetsDir.trim()
    ? options.assetsDir.trim()
    : null;
  const fsApi = options.fsApi || fs;
  const spawn = options.spawn || spawnChild;
  const log = typeof options.log === "function" ? options.log : () => {};
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const launchedIds = new Set();
  const launchedProcesses = new Map();
  const known = new Map();

  function statusPathFor(sessionId) {
    assertSafeSessionId(sessionId);
    return path.join(statusDir, `${STATUS_FILE_PREFIX}${sessionId}.json`);
  }

  function launchRenderer(status, statusPath) {
    if (
      !rendererBinary
      || launchedIds.has(status.sessionId)
      || status.state === "closed"
      || status.state === "offline"
    ) return;

    launchedIds.add(status.sessionId);
    const args = ["run", "--status-file", statusPath, "--session-id", status.sessionId];
    if (assetsDir) args.push("--assets-dir", assetsDir);
    try {
      const child = spawn(rendererBinary, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      if (child) launchedProcesses.set(status.sessionId, child);
      const releaseLaunch = () => {
        if (launchedProcesses.get(status.sessionId) !== child) return;
        launchedProcesses.delete(status.sessionId);
        launchedIds.delete(status.sessionId);
      };
      if (child && typeof child.unref === "function") child.unref();
      if (child && typeof child.once === "function") {
        child.once("error", (error) => {
          releaseLaunch();
          log(`renderer launch failed for ${status.sessionId}: ${error.message}`);
        });
        child.once("exit", (code, signal) => {
          releaseLaunch();
          if (code !== 0 || signal) {
            log(`renderer for ${status.sessionId} exited abnormally: code=${code} signal=${signal || "none"}`);
          }
        });
      }
    } catch (error) {
      log(`renderer launch threw for ${status.sessionId}: ${error.message}`);
    }
  }

  function markMissingSessionsOffline(seenIds) {
    for (const [sessionId, prior] of known) {
      if (seenIds.has(sessionId) || prior.state === "offline") continue;
      const offline = {
        ...prior,
        state: "offline",
        detail: "Connection lost",
        event: "SessionMissing",
        timestamp: now().toISOString(),
      };
      writeStatusFile(statusPathFor(sessionId), offline, fsApi);
      known.set(sessionId, offline);
    }
  }

  function onSessionEnd(status) {
    if (!enabled || !status) return false;
    assertSafeSessionId(status.sessionId);
    const sessionId = status.sessionId;
    const prior = known.get(sessionId) || copyStatus(status);
    const closed = {
      ...prior,
      state: "closed",
      detail: "Session ended",
      event: "SessionEnd",
      timestamp: now().toISOString(),
    };
    writeStatusFile(statusPathFor(sessionId), closed, fsApi);
    known.delete(sessionId);
    launchedIds.delete(sessionId);
    launchedProcesses.delete(sessionId);
    return true;
  }

  function onSnapshot(snapshot) {
    if (!enabled || !snapshot || !Array.isArray(snapshot.statuses)) {
      return { written: 0, launched: 0 };
    }

    // Validate the whole batch before touching the filesystem or spawning a
    // renderer. A malformed entry must not leave a partially applied snapshot.
    for (const status of snapshot.statuses) {
      assertSafeSessionId(status && status.sessionId);
    }

    const seenIds = new Set();
    let written = 0;
    let launched = 0;
    for (const status of snapshot.statuses) {
      if (!status || !status.sessionId) continue;
      const prior = known.get(status.sessionId);
      const changed = presentationChanged(prior, status);
      const ownedStatus = copyStatus(status);
      const statusPath = statusPathFor(status.sessionId);
      if (changed) {
        writeStatusFile(statusPath, ownedStatus, fsApi);
        written += 1;
      }
      if (status.state === "closed") launchedIds.delete(status.sessionId);
      seenIds.add(status.sessionId);
      // Never retain a caller-owned mutable object: Clawd may update its
      // snapshot entry in place before the next broadcast.
      known.set(status.sessionId, ownedStatus);
      // Heartbeats and metadata ripples do not relaunch a voluntarily closed
      // renderer. A genuine presentation change does.
      const isRunning = launchedProcesses.has(status.sessionId);
      if (changed && !isRunning && status.state !== "closed" && status.state !== "offline") {
        const wasLaunched = launchedIds.has(status.sessionId);
        launchRenderer(ownedStatus, statusPath);
        if (!wasLaunched && launchedIds.has(status.sessionId)) launched += 1;
      }
    }
    markMissingSessionsOffline(seenIds);
    return { written, launched };
  }

  return {
    onSessionEnd,
    onSnapshot,
    statusPathFor,
    get enabled() { return enabled; },
  };
}

module.exports = {
  createPetRuntime,
  defaultStatusDir,
  isSafeSessionId,
  isTruthyEnv,
  presentationChanged,
  toStatusFilePayload,
  writeStatusFile,
};
