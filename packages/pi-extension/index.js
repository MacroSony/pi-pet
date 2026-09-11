"use strict";

// Pi Pet Phase B — pet_express tool (agent → pet expression) and inbox consumption (pet → agent input).
//
// The tool surface is deliberately tiny (contract docs/drafts/phase-a-interaction-contract.md §2):
// the agent only provides text and/or emotion. petId, commandId, timestamps and TTL are
// attached here in the adapter, never by the model.
//
// Delivery modes:
//   1. Local: writes PetEvent and DeliveryReceipt files via packages/runtime/interaction.js.
//   2. Remote fallback: if local identity/session is unknown or closed, POSTs to Clawd's
//      remote-SSH ingress on 127.0.0.1:<remotePort>/pet-expression with x-clawd-routing-nonce header.
//
// Inbox Consumption:
//   Consumes local own-session user messages from runtime inbox via claimNextUserMessage and settleUserMessage.
//   Dispatches received messages to active Pi session via pi.sendUserMessage.
//
// Configuration (environment):
//   PI_PET_RUNTIME_MODULE         — trusted absolute path to packages/runtime/interaction.js.
//                                   Optional if remote config is present; required for local delivery & inbox.
//   PI_PET_CLAWD_REMOTE_CONFIG    — trusted absolute path to clawd-remote.json override.
//                                   Default: ~/.pi/agent/extensions/clawd-on-desk/clawd-remote.json.
//   PI_PET_DATA_DIR               — runtime data dir override (default: ~/.pi-pet).
//   PI_PET_PROFILE_ID             — profile identity component (default: "local").

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const ROUTING_NONCE_HEADER = "x-clawd-routing-nonce";
const ROUTING_NONCE_RE = /^[a-f0-9]{32}$/;
const MAX_ENVELOPE_SIZE = 16384; // 16 KiB
const MAX_RESPONSE_SIZE = 65536; // 64 KiB
const HTTP_TIMEOUT_MS = 2500;
const MAX_TEXT_LENGTH = 2000;

const CLAWD_SERVER_ID = "clawd-on-desk";
const CLAWD_SERVER_HEADER = "x-clawd-server";
const PEER_CAPABILITY_SLOT_SYMBOL = Symbol.for("pi-pet.peer-capability.v1");
const PEER_ALLOWED_PATHS = new Set(["/pet-peer/catalog", "/pet-peer/send"]);
const PEER_LOCAL_TIMEOUT_MS = 2500;
const PEER_REMOTE_TIMEOUT_MS = 5000;

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_DRAIN_INTERVAL_MS = 0;

const VALID_EMOTIONS = Object.freeze(["happy", "shy", "shocked", "sad", "celebrate"]);
const VALID_EMOTIONS_SET = new Set(VALID_EMOTIONS);

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

function loadInteraction(env) {
  const source = env || process.env;
  const modulePath = typeof source.PI_PET_RUNTIME_MODULE === "string"
    ? source.PI_PET_RUNTIME_MODULE.trim()
    : "";
  if (!modulePath || !path.isAbsolute(modulePath)) return null;
  try {
    return require(modulePath);
  } catch {
    return null;
  }
}

function resolveRemoteConfigPath(env) {
  const source = env || process.env;
  if (typeof source.PI_PET_CLAWD_REMOTE_CONFIG === "string" && source.PI_PET_CLAWD_REMOTE_CONFIG.trim()) {
    const customPath = source.PI_PET_CLAWD_REMOTE_CONFIG.trim();
    return path.isAbsolute(customPath) ? customPath : null;
  }
  const home = (source && (source.HOME || source.USERPROFILE)) || os.homedir();
  return path.join(home, ".pi", "agent", "extensions", "clawd-on-desk", "clawd-remote.json");
}

function loadRemoteConfig(env) {
  const configPath = resolveRemoteConfigPath(env);
  if (!configPath) return null;
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

    const { remotePort, routingNonce, profileId } = parsed;

    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
      return null;
    }
    if (typeof routingNonce !== "string" || !ROUTING_NONCE_RE.test(routingNonce)) {
      return null;
    }
    if (typeof profileId !== "string" || profileId.trim().length === 0) {
      return null;
    }

    return {
      remotePort,
      routingNonce,
      profileId: profileId.trim(),
    };
  } catch {
    return null;
  }
}

function resolveLocalRuntimeConfigPath(env) {
  const source = env || process.env;
  if (typeof source.PI_PET_CLAWD_RUNTIME_CONFIG === "string" && source.PI_PET_CLAWD_RUNTIME_CONFIG.trim()) {
    const customPath = source.PI_PET_CLAWD_RUNTIME_CONFIG.trim();
    return path.isAbsolute(customPath) ? customPath : null;
  }
  const home = (source && (source.HOME || source.USERPROFILE)) || os.homedir();
  return path.join(home, ".clawd", "runtime.json");
}

function loadLocalRuntimeConfig(env) {
  const configPath = resolveLocalRuntimeConfigPath(env);
  if (!configPath) return null;
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

    const { app, port, ownerPid } = parsed;

    if (app !== CLAWD_SERVER_ID) {
      return null;
    }
    if (!Number.isInteger(port) || port < 23333 || port > 23337) {
      return null;
    }
    if (typeof ownerPid !== "number" || !Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
      return null;
    }

    return {
      mode: "local",
      port,
      ownerPid,
    };
  } catch {
    return null;
  }
}

function resolvePeerTransportConfig(env) {
  const remote = loadRemoteConfig(env);
  if (remote) {
    return {
      mode: "remote",
      port: remote.remotePort,
      routingNonce: remote.routingNonce,
      profileId: remote.profileId,
    };
  }
  const local = loadLocalRuntimeConfig(env);
  if (local) {
    return local;
  }
  return null;
}

function readPeerCapabilityToken() {
  const slot = globalThis[PEER_CAPABILITY_SLOT_SYMBOL];
  if (!slot || typeof slot !== "object" || Array.isArray(slot)) {
    return null;
  }
  if (slot.version !== 1) {
    return null;
  }
  if (typeof slot.token !== "string" || !/^[0-9a-f]{64}$/.test(slot.token)) {
    return null;
  }
  return slot.token;
}

function countCodePoints(str) {
  if (typeof str !== "string") return 0;
  return Array.from(str).length;
}

const PUBLIC_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u061C\u200E-\u200F\u202A-\u202E\u2066-\u2069]+/g;

function sanitizePublicText(value, maxCodePoints) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(PUBLIC_CONTROL_RE, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const characters = Array.from(normalized);
  return characters.slice(0, maxCodePoints).join("");
}

function projectCatalogSession(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const { handle, capabilities, canMessage, expiresAtMs } = entry;
  const displayName = sanitizePublicText(entry.displayName, 120);
  const host = sanitizePublicText(entry.host, 120);
  const state = sanitizePublicText(entry.state, 64);

  if (typeof handle !== "string" || !/^psh_[A-Za-z0-9_-]{1,124}$/.test(handle)) return null;
  if (!displayName || !host || !state) return null;
  if (
    !Array.isArray(capabilities)
    || capabilities.length !== 1
    || capabilities[0] !== "receive_peer_message"
  ) return null;
  if (canMessage !== true) return null;
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs < 0) return null;

  return {
    handle,
    displayName,
    host,
    state,
    capabilities: ["receive_peer_message"],
    canMessage: true,
    expiresAtMs,
  };
}

function sanitizeSendDetails(data, defaultReason = null) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {
      status: "failed",
      reason: defaultReason || "Unknown error",
    };
  }

  const details = {};

  details.schemaVersion = "1";

  const validStatuses = new Set(["queued", "dispatched", "failed", "expired", "rejected"]);
  details.status = validStatuses.has(data.status) ? data.status : "failed";

  if (typeof data.messageId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(data.messageId)) {
    details.messageId = data.messageId;
  }

  if (typeof data.threadId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(data.threadId)) {
    details.threadId = data.threadId;
  }

  if (Number.isSafeInteger(data.hopCount) && data.hopCount >= 0 && data.hopCount <= 1) {
    details.hopCount = data.hopCount;
  }

  if (Number.isSafeInteger(data.maxHops) && data.maxHops >= 0 && data.maxHops <= 1) {
    details.maxHops = data.maxHops;
  }

  if (Number.isSafeInteger(data.createdAtMs) && data.createdAtMs > 0) {
    details.createdAtMs = data.createdAtMs;
  }

  if (Number.isSafeInteger(data.expiresAtMs) && data.expiresAtMs > 0) {
    details.expiresAtMs = data.expiresAtMs;
  }

  const safeReason = sanitizePublicText(data.reason, 1024);
  const safeDefaultReason = sanitizePublicText(defaultReason, 1024);
  if (safeReason) {
    details.reason = safeReason;
  } else if (safeDefaultReason) {
    details.reason = safeDefaultReason;
  }

  return details;
}

function postPeerJson(config, pathName, body, signal) {
  return new Promise((resolve) => {
    if (!config || typeof config !== "object" || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
      resolve({ ok: false, status: 0, reason: "Clawd runtime configuration unavailable" });
      return;
    }

    if (!PEER_ALLOWED_PATHS.has(pathName)) {
      resolve({ ok: false, status: 0, reason: "Invalid request path" });
      return;
    }

    if (signal && signal.aborted) {
      resolve({ ok: false, status: 0, reason: "Request aborted" });
      return;
    }

    let bodyJson;
    try {
      bodyJson = JSON.stringify(body);
    } catch {
      resolve({ ok: false, status: 0, reason: "Failed to serialize request payload to JSON" });
      return;
    }

    const bodyBytes = Buffer.byteLength(bodyJson, "utf8");
    if (bodyBytes > MAX_ENVELOPE_SIZE) {
      resolve({ ok: false, status: 0, reason: "Request payload exceeds 16 KiB limit" });
      return;
    }

    const isRemote = config.mode === "remote" || Boolean(config.routingNonce);
    const timeoutMs = isRemote ? PEER_REMOTE_TIMEOUT_MS : PEER_LOCAL_TIMEOUT_MS;

    const headers = {
      "Content-Type": "application/json",
      "Content-Length": bodyBytes,
      Connection: "close",
    };

    if (isRemote && typeof config.routingNonce === "string") {
      headers[ROUTING_NONCE_HEADER] = config.routingNonce;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const reqOptions = {
      hostname: "127.0.0.1",
      port: config.port,
      path: pathName,
      method: "POST",
      headers,
      timeout: timeoutMs,
    };

    if (signal) {
      reqOptions.signal = signal;
    }

    let req;
    try {
      req = http.request(reqOptions, (res) => {
        const serverHeader = res.headers && (
          res.headers[CLAWD_SERVER_HEADER] ||
          res.headers[CLAWD_SERVER_HEADER.toLowerCase()]
        );
        const headerVal = Array.isArray(serverHeader) ? serverHeader[0] : serverHeader;
        if (headerVal !== CLAWD_SERVER_ID) {
          try { req.destroy(); } catch {}
          try { res.destroy(); } catch {}
          finish({ ok: false, status: res.statusCode || 0, reason: "Invalid server header" });
          return;
        }

        let receivedBytes = 0;
        const chunks = [];
        let tooLarge = false;

        res.on("data", (chunk) => {
          if (tooLarge) return;
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          receivedBytes += buf.length;
          if (receivedBytes > MAX_RESPONSE_SIZE) {
            tooLarge = true;
            chunks.length = 0;
            finish({ ok: false, status: res.statusCode || 0, reason: "Response exceeded maximum size limit of 64 KiB" });
            try { req.destroy(); } catch {}
            try { res.destroy(); } catch {}
            return;
          }
          chunks.push(buf);
        });

        res.on("end", () => {
          if (tooLarge || settled) return;
          const raw = Buffer.concat(chunks).toString("utf8");
          let data = null;
          if (raw) {
            try {
              data = JSON.parse(raw);
            } catch {
              finish({
                ok: false,
                status: res.statusCode || 0,
                reason: `Non-JSON response from server (HTTP ${res.statusCode})`,
              });
              return;
            }
          }
          const ok = Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 300);
          finish({ ok, status: res.statusCode || 0, data });
        });

        res.on("aborted", () => {
          finish({ ok: false, status: 0, reason: "Response aborted" });
        });

        res.on("error", (err) => {
          finish({ ok: false, status: 0, reason: (err && err.message) || "Response error" });
        });
      });
    } catch (err) {
      finish({ ok: false, status: 0, reason: (err && err.message) || "Failed to initiate request" });
      return;
    }

    req.on("timeout", () => {
      try { req.destroy(); } catch {}
      finish({ ok: false, status: 0, reason: `Request timed out after ${timeoutMs}ms` });
    });

    req.on("error", (err) => {
      if (signal && signal.aborted) {
        finish({ ok: false, status: 0, reason: "Request aborted" });
      } else {
        finish({ ok: false, status: 0, reason: (err && err.message) || "Transport error" });
      }
    });

    try {
      req.write(bodyJson);
      req.end();
    } catch (err) {
      finish({ ok: false, status: 0, reason: (err && err.message) || "Request write error" });
    }
  });
}

function canonicalizePiSessionId(val) {
  if (typeof val !== "string") return null;
  const trimmed = val.trim();
  if (!trimmed || trimmed === "default") return null;
  if (trimmed === "pi:" || trimmed === "pi:default") return null;
  if (trimmed.startsWith("pi:")) {
    const after = trimmed.slice(3).trim();
    if (!after || after === "default") return null;
    return `pi:${after}`;
  }
  return `pi:${trimmed}`;
}

function readSessionId(ctx) {
  if (!ctx || typeof ctx !== "object") return "default";
  let candidate = null;
  try {
    const manager = ctx.sessionManager;
    if (manager && typeof manager.getSessionId === "function") {
      candidate = manager.getSessionId();
    }
  } catch {}
  if (!candidate) {
    try {
      if (typeof ctx.sessionId === "string") {
        candidate = ctx.sessionId;
      }
    } catch {}
  }
  const canonical = canonicalizePiSessionId(candidate);
  return canonical || "default";
}

function resolveSessionId(event, ctx, pi) {
  function tryExtract(fn) {
    try {
      return canonicalizePiSessionId(fn());
    } catch {
      return null;
    }
  }

  // 1. Direct string event
  if (typeof event === "string") {
    const s = canonicalizePiSessionId(event);
    if (s) return s;
  }

  // 2. Event object candidates
  if (event && typeof event === "object") {
    const fromEvent =
      tryExtract(() => event.sessionId) ||
      tryExtract(() => event.rawSessionId) ||
      tryExtract(() => (typeof event.sessionManager?.getSessionId === "function" ? event.sessionManager.getSessionId() : null)) ||
      tryExtract(() => event.session?.id) ||
      tryExtract(() => event.session?.sessionId);
    if (fromEvent) return fromEvent;
  }

  // 3. Context object candidates
  if (ctx && typeof ctx === "object") {
    const fromCtx =
      tryExtract(() => ctx.sessionId) ||
      tryExtract(() => ctx.rawSessionId) ||
      tryExtract(() => (typeof ctx.sessionManager?.getSessionId === "function" ? ctx.sessionManager.getSessionId() : null)) ||
      tryExtract(() => ctx.session?.id);
    if (fromCtx) return fromCtx;
  }

  // 4. Pi object candidates
  if (pi && typeof pi === "object") {
    const fromPi =
      tryExtract(() => pi.sessionId) ||
      tryExtract(() => (typeof pi.sessionManager?.getSessionId === "function" ? pi.sessionManager.getSessionId() : null)) ||
      tryExtract(() => (typeof pi.getSessionId === "function" ? pi.getSessionId() : null));
    if (fromPi) return fromPi;
  }

  return null;
}

function getCanonicalSessionId(ctx, pi) {
  let resolved = resolveSessionId(undefined, ctx, pi);
  if (!resolved) {
    const fromRead = readSessionId(ctx);
    if (fromRead && fromRead !== "default") {
      resolved = canonicalizePiSessionId(fromRead);
    }
  }
  if (!resolved || resolved === "default" || resolved === "pi:default" || resolved === "pi:") {
    return null;
  }
  return resolved;
}

function extractMessageText(claimed) {
  if (claimed && typeof claimed.text === "string") {
    return claimed.text;
  }
  return "";
}

function isIdentityOrSessionRejection(receipt) {
  if (!receipt || receipt.status !== "rejected" || typeof receipt.reason !== "string") {
    return false;
  }
  const reason = receipt.reason;
  return (
    reason.startsWith("InvalidPetIdentity") ||
    reason.startsWith("UnknownPetIdentity") ||
    reason.startsWith("SessionClosed")
  );
}

function toolCallDedupKey(toolCallId) {
  const safe = String(toolCallId || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 55);
  return safe ? `tc_${safe}` : undefined;
}

function buildRemoteExpressionBody({ rawSessionId, toolCallId, params, now = Date.now }) {
  const nowMs = typeof now === "function" ? now() : Date.now();
  const body = {
    schemaVersion: "1",
    kind: "pet_expression",
    rawSessionId,
    agentId: "pi",
    createdAtMs: nowMs,
  };
  const dedupKey = toolCallDedupKey(toolCallId);
  if (dedupKey) body.dedupKey = dedupKey;
  if (params && params.text !== undefined) body.text = params.text;
  if (params && params.emotion !== undefined) body.emotion = params.emotion;
  return body;
}

function postRemoteExpression(remoteConfig, bodyObj, signal) {
  return new Promise((resolve) => {
    let bodyJson;
    try {
      bodyJson = JSON.stringify(bodyObj);
    } catch (err) {
      resolve({
        status: "rejected",
        reason: "SchemaValidationError: options cannot be serialized to JSON",
      });
      return;
    }

    const bodyBytes = Buffer.byteLength(bodyJson, "utf8");
    if (bodyBytes > MAX_ENVELOPE_SIZE) {
      resolve({
        status: "rejected",
        reason: "SchemaValidationError: payload exceeds maximum envelope size of 16 KiB",
      });
      return;
    }

    let settled = false;
    const finish = (receipt) => {
      if (settled) return;
      settled = true;
      resolve(receipt);
    };

    const reqOptions = {
      hostname: "127.0.0.1",
      port: remoteConfig.remotePort,
      path: "/pet-expression",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [ROUTING_NONCE_HEADER]: remoteConfig.routingNonce,
        "Content-Length": bodyBytes,
      },
      timeout: HTTP_TIMEOUT_MS,
    };
    if (signal) {
      reqOptions.signal = signal;
    }

    let req;
    try {
      req = http.request(reqOptions, (res) => {
        let totalBytes = 0;
        const chunks = [];

        res.on("data", (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > MAX_RESPONSE_SIZE) {
            req.destroy(new Error("Response exceeded maximum size limit of 64 KiB"));
            return;
          }
          chunks.push(chunk);
        });

        res.on("end", () => {
          if (settled) return;
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            const receipt = JSON.parse(raw);
            if (receipt && typeof receipt === "object" && typeof receipt.status === "string") {
              finish(receipt);
            } else {
              finish({
                status: "failed",
                reason: `Invalid JSON receipt from remote: ${raw.slice(0, 200)}`,
              });
            }
          } catch (err) {
            finish({
              status: "failed",
              reason: `Non-JSON response from remote server (HTTP ${res.statusCode}): ${err.message}`,
            });
          }
        });

        res.on("error", (err) => {
          finish({
            status: "failed",
            reason: `Remote response error: ${err.message}`,
          });
        });
      });
    } catch (err) {
      finish({
        status: "failed",
        reason: `Failed to initiate remote request: ${err.message}`,
      });
      return;
    }

    req.on("timeout", () => {
      req.destroy(new Error(`Remote request timed out after ${HTTP_TIMEOUT_MS}ms`));
    });

    req.on("error", (err) => {
      finish({
        status: "failed",
        reason: `Remote delivery failed: ${err.message}`,
      });
    });

    req.write(bodyJson);
    req.end();
  });
}

async function dispatchRemoteExpression(remoteConfig, { rawSessionId, toolCallId, params, signal, now }) {
  const remoteBody = buildRemoteExpressionBody({ rawSessionId, toolCallId, params, now });
  return postRemoteExpression(remoteConfig, remoteBody, signal);
}

function formatResult(receipt) {
  return {
    content: [{ type: "text", text: JSON.stringify(receipt) }],
    details: receipt,
    isError: receipt.status !== "delivered",
  };
}

function formatPeerResult(details, isError) {
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
    isError: Boolean(isError),
  };
}

function createInboxConsumer(pi, options = {}) {
  const env = options.env || process.env;
  const profileId = (
    typeof options.profileId === "string" && options.profileId.trim()
      ? options.profileId.trim()
      : (typeof env.PI_PET_PROFILE_ID === "string" && env.PI_PET_PROFILE_ID.trim() ? env.PI_PET_PROFILE_ID.trim() : "local")
  );
  const rawSessionId = options.sessionId || options.rawSessionId;
  const canonicalSessionId = canonicalizePiSessionId(rawSessionId);
  if (!canonicalSessionId) {
    return null;
  }

  const normalizedSessionId = canonicalSessionId;
  const dataDir = options.dataDir || env.PI_PET_DATA_DIR || undefined;
  const claimantId =
    options.claimantId ||
    `pi-ext-${crypto.randomUUID()}`;
  const pollIntervalMs =
    typeof options.pollIntervalMs === "number" ? options.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS;
  const drainIntervalMs =
    typeof options.drainIntervalMs === "number" ? options.drainIntervalMs : DEFAULT_DRAIN_INTERVAL_MS;
  const setTimeoutFn = options.setTimeout || setTimeout;
  const clearTimeoutFn = options.clearTimeout || clearTimeout;
  const nowFn = typeof options.now === "function" ? options.now : Date.now;

  let active = false;
  let activeTimer = null;
  let inFlightTick = null;

  function schedule(delayMs) {
    if (!active) return;
    if (activeTimer) {
      try {
        clearTimeoutFn(activeTimer);
      } catch {}
      activeTimer = null;
    }
    try {
      const timer = setTimeoutFn(() => {
        activeTimer = null;
        if (!active) return;
        inFlightTick = Promise.resolve()
          .then(() => tick())
          .catch(() => {
            if (active) {
              try {
                schedule(pollIntervalMs);
              } catch {}
            }
          })
          .finally(() => {
            inFlightTick = null;
          });
      }, delayMs);

      if (timer && typeof timer.unref === "function") {
        try {
          timer.unref();
        } catch {}
      }
      activeTimer = timer;
    } catch {
      // setTimeoutFn threw synchronously
    }
  }

  async function pollOnce() {
    const interaction = options.interaction || loadInteraction(env);
    if (
      !interaction ||
      typeof interaction.claimNextUserMessage !== "function" ||
      typeof interaction.settleUserMessage !== "function"
    ) {
      return {
        hasMore: false,
        error: new Error("Runtime module not configured or missing required inbox functions"),
      };
    }

    let claimed;
    try {
      claimed = await interaction.claimNextUserMessage({
        profileId,
        agentId: "pi",
        rawSessionId: normalizedSessionId,
        dataDir,
        claimantId,
        now: nowFn,
      });
    } catch (err) {
      return { hasMore: false, error: err };
    }

    if (!claimed || !claimed.claimToken) {
      return { hasMore: false };
    }

    const commandId = claimed.commandId || claimed.id || claimed.eventId;
    let petId = claimed.petId;
    if (!petId && typeof interaction.derivePetId === "function") {
      try {
        petId = interaction.derivePetId({
          profileId,
          agentId: "pi",
          rawSessionId: normalizedSessionId,
        });
      } catch {
        // ignore derivation failure
      }
    }

    const currentNowMs = nowFn();

    // 1. Re-check expiresAtMs immediately before dispatch and settle expired without calling Pi
    if (
      claimed.expiresAtMs !== undefined &&
      typeof claimed.expiresAtMs === "number" &&
      claimed.expiresAtMs <= currentNowMs
    ) {
      try {
        await interaction.settleUserMessage({
          petId,
          commandId,
          claimToken: claimed.claimToken,
          status: "expired",
          reason: "Message expired before dispatch",
          dataDir,
          now: nowFn,
        });
      } catch {
        // never crash
      }
      return { hasMore: true, status: "expired" };
    }

    // 2. Extract text and validate claimed message shape (.text only)
    const text = extractMessageText(claimed);
    if (!text || typeof text !== "string" || text.length === 0 || text.length > MAX_TEXT_LENGTH) {
      const reason = "Malformed or empty claimed user message";
      try {
        await interaction.settleUserMessage({
          petId,
          commandId,
          claimToken: claimed.claimToken,
          status: "failed",
          reason,
          dataDir,
          now: nowFn,
        });
      } catch {
        // never crash
      }
      return { hasMore: true, status: "failed", error: new Error(reason) };
    }

    // 3. Invoke pi.sendUserMessage(text, { deliverAs: 'followUp', expandPromptTemplates: false })
    let dispatchError = null;

    try {
      if (!pi || typeof pi.sendUserMessage !== "function") {
        throw new Error("pi.sendUserMessage is not a function");
      }
      pi.sendUserMessage(text, {
        deliverAs: "followUp",
        expandPromptTemplates: false,
      });
    } catch (err) {
      dispatchError = err;
    }

    // 3. Settle status: 'dispatched' on successful invocation, 'failed' on synchronous throw
    if (dispatchError) {
      try {
        await interaction.settleUserMessage({
          petId,
          commandId,
          claimToken: claimed.claimToken,
          status: "failed",
          reason: dispatchError.message || String(dispatchError),
          dataDir,
          now: nowFn,
        });
      } catch {
        // never crash
      }
      return { hasMore: true, status: "failed", error: dispatchError };
    } else {
      try {
        await interaction.settleUserMessage({
          petId,
          commandId,
          claimToken: claimed.claimToken,
          status: "dispatched",
          dataDir,
          now: nowFn,
        });
      } catch {
        // never crash
      }
      return { hasMore: true, status: "dispatched" };
    }
  }

  async function tick() {
    if (!active) return;
    try {
      const result = await pollOnce();
      if (!active) return;
      if (result && result.hasMore) {
        schedule(drainIntervalMs);
      } else {
        schedule(pollIntervalMs);
      }
    } catch {
      // Errors back off and never crash Pi
      if (active) {
        try {
          schedule(pollIntervalMs);
        } catch {}
      }
    }
  }

  function start() {
    if (active) return consumer;
    active = true;
    schedule(0);
    return consumer;
  }

  function stop() {
    active = false;
    if (activeTimer) {
      try {
        clearTimeoutFn(activeTimer);
      } catch {}
      activeTimer = null;
    }
    return consumer;
  }

  const consumer = {
    sessionId: normalizedSessionId,
    profileId,
    claimantId,
    start,
    stop,
    pollOnce,
    tick,
    get isRunning() {
      return active;
    },
  };

  return consumer;
}

function attachInboxConsumer(pi, options = {}) {
  if (!pi || typeof pi.on !== "function") {
    return null;
  }

  let activeInboxConsumer = null;

  function stopCurrent() {
    if (activeInboxConsumer) {
      activeInboxConsumer.stop();
      activeInboxConsumer = null;
    }
  }

  function handleSessionStart(event, ctx) {
    let sessionId = null;
    try {
      sessionId = resolveSessionId(event, ctx, pi);
    } catch {
      sessionId = null;
    }

    if (!sessionId) {
      stopCurrent();
      return;
    }

    // Replace any previous loop before starting
    stopCurrent();

    const consumer = createInboxConsumer(pi, {
      ...options,
      sessionId,
    });
    if (consumer) {
      activeInboxConsumer = consumer;
      consumer.start();
    }
  }

  function handleSessionShutdown() {
    stopCurrent();
  }

  pi.on("session_start", handleSessionStart);
  pi.on("session_shutdown", handleSessionShutdown);

  return {
    getActiveConsumer: () => activeInboxConsumer,
    stop: stopCurrent,
    handleSessionStart,
    handleSessionShutdown,
  };
}

function piPetExtension(pi, dependencies = {}) {
  // Normal Pi discovery loads index.ts, which imports Pi's bundled TypeBox and
  // injects it here. The CommonJS fallback remains for direct Node consumers
  // and tests, but production loading must not depend on extension-local
  // node_modules.
  const Type = dependencies.Type || require("typebox").Type;

  if (pi && typeof pi.registerTool === "function") {
    pi.registerTool({
      name: "pet_list_sessions",
      label: "List Pet Sessions",
      description:
        "List active desktop pet sessions available for peer messaging. Returns sanitized session handles, display names, states and hosts.",
      promptSnippet:
        "pet_list_sessions(state?, host?) — list active peer-messageable pet sessions",
      promptGuidelines: [
        "Returns active, interactive Pi sessions advertising peer messaging capability, excluding self.",
        "Use the returned handle (psh_...) with pet_send to send a peer note.",
      ],
      parameters: Type.Object({
        state: Type.Optional(Type.String({ maxLength: 120 })),
        host: Type.Optional(Type.String({ maxLength: 120 })),
      }),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        if (params !== undefined && (typeof params !== "object" || Array.isArray(params))) {
          return formatPeerResult({ status: "rejected", reason: "Parameters must be an object" }, true);
        }

        if (params && typeof params === "object") {
          for (const key of Object.keys(params)) {
            if (key !== "state" && key !== "host") {
              return formatPeerResult({ status: "rejected", reason: `Unexpected parameter: "${key}"` }, true);
            }
          }
          if (params.state !== undefined) {
            if (typeof params.state !== "string" || countCodePoints(params.state) > 120) {
              return formatPeerResult({ status: "rejected", reason: "state must be a string <= 120 characters" }, true);
            }
          }
          if (params.host !== undefined) {
            if (typeof params.host !== "string" || countCodePoints(params.host) > 120) {
              return formatPeerResult({ status: "rejected", reason: "host must be a string <= 120 characters" }, true);
            }
          }
        }

        const rawSessionId = getCanonicalSessionId(ctx, pi);
        if (!rawSessionId) {
          return formatPeerResult({ status: "rejected", reason: "Invalid or uninitialized session" }, true);
        }

        const capabilityToken = readPeerCapabilityToken();
        if (!capabilityToken) {
          return formatPeerResult({ status: "rejected", reason: "Peer capability token unavailable or invalid" }, true);
        }

        const config = resolvePeerTransportConfig();
        if (!config) {
          return formatPeerResult({ status: "failed", reason: "Clawd runtime configuration unavailable" }, true);
        }

        const body = {
          schemaVersion: "1",
          kind: "peer_catalog_query",
          rawSessionId,
          capabilityToken,
        };
        if (params && typeof params.state === "string" && params.state.trim().length > 0) {
          body.state = params.state.trim();
        }
        if (params && typeof params.host === "string" && params.host.trim().length > 0) {
          body.host = params.host.trim();
        }

        const res = await postPeerJson(config, "/pet-peer/catalog", body, signal);

        if (!res.ok || res.status !== 200) {
          const errorDetails = sanitizeSendDetails(res.data, res.reason || `HTTP ${res.status}`);
          return formatPeerResult(errorDetails, true);
        }

        const data = res.data;
        if (!data || typeof data !== "object" || Array.isArray(data) || data.kind !== "peer_catalog" || !Array.isArray(data.sessions)) {
          return formatPeerResult({ status: "failed", reason: "Invalid catalog response structure" }, true);
        }

        const projectedSessions = [];
        for (const sessionEntry of data.sessions) {
          const projected = projectCatalogSession(sessionEntry);
          if (projected) {
            projectedSessions.push(projected);
          }
        }

        const details = {
          schemaVersion: "1",
          kind: "peer_catalog",
          sessions: projectedSessions,
        };

        return formatPeerResult(details, false);
      },
    });

    pi.registerTool({
      name: "pet_send",
      label: "Send Peer Note",
      description:
        "Send a one-shot peer note to another active desktop pet session using a valid catalog or reply handle.",
      promptSnippet:
        "pet_send(target, text) — send a one-shot peer note to another active pet session",
      promptGuidelines: [
        "target must be a valid session handle (e.g. psh_...) from pet_list_sessions or an incoming peer note.",
        "text must be between 1 and 2000 Unicode code points.",
        "Peer messaging is normal priority and cannot force an immediate turn or autonomous reply.",
      ],
      parameters: Type.Object({
        target: Type.String({ minLength: 1, maxLength: 128 }),
        text: Type.String({ minLength: 1, maxLength: 2000 }),
      }),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        if (!params || typeof params !== "object" || Array.isArray(params)) {
          return formatPeerResult({ status: "rejected", reason: "Parameters must be an object" }, true);
        }

        for (const key of Object.keys(params)) {
          if (key !== "target" && key !== "text") {
            return formatPeerResult({ status: "rejected", reason: `Unexpected parameter: "${key}"` }, true);
          }
        }

        const { target, text } = params;

        if (typeof target !== "string" || !/^psh_[A-Za-z0-9_-]{1,124}$/.test(target)) {
          return formatPeerResult({ status: "rejected", reason: "Invalid target: expected a psh_ opaque handle" }, true);
        }

        if (typeof text !== "string") {
          return formatPeerResult({ status: "rejected", reason: "text must be a string" }, true);
        }

        const cpLen = countCodePoints(text);
        if (cpLen < 1 || cpLen > 2000) {
          return formatPeerResult({ status: "rejected", reason: "text length must be between 1 and 2000 Unicode code points" }, true);
        }

        const rawSessionId = getCanonicalSessionId(ctx, pi);
        if (!rawSessionId) {
          return formatPeerResult({ status: "rejected", reason: "Invalid or uninitialized session" }, true);
        }

        const capabilityToken = readPeerCapabilityToken();
        if (!capabilityToken) {
          return formatPeerResult({ status: "rejected", reason: "Peer capability token unavailable or invalid" }, true);
        }

        const config = resolvePeerTransportConfig();
        if (!config) {
          return formatPeerResult({ status: "failed", reason: "Clawd runtime configuration unavailable" }, true);
        }

        const body = {
          schemaVersion: "1",
          kind: "peer_send",
          rawSessionId,
          capabilityToken,
          target,
          text,
        };

        const res = await postPeerJson(config, "/pet-peer/send", body, signal);

        const isSuccessHttp = res.status === 200 || res.status === 202;
        const data = res.data;
        const fallbackReason = res.ok ? null : (res.reason || `HTTP ${res.status}`);
        const sanitized = sanitizeSendDetails(data, fallbackReason);

        const isSuccessStatus = sanitized.status === "queued" || sanitized.status === "dispatched";
        const isError = !(isSuccessHttp && isSuccessStatus);

        return formatPeerResult(sanitized, isError);
      },
    });

    pi.registerTool({
      name: "pet_express",
      label: "Pet Express",
      description:
        "Express through your desktop pet: show a text bubble and/or play an emotion animation. " +
        "At least one of text or emotion is required. emotion is a closed enum: happy | shy | shocked | sad | celebrate.",
      promptSnippet:
        "pet_express(text?, emotion?) — show a bubble and/or play an emotion on your desktop pet",
      promptGuidelines: [
        "Use pet_express sparingly, for genuinely notable moments (finished a task, blocked, celebrating).",
        "emotion is a closed enum: happy | shy | shocked | sad | celebrate. Never invent other values.",
      ],
      parameters: Type.Object({
        text: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
        emotion: Type.Optional(
          Type.Union([
            Type.Literal("happy"),
            Type.Literal("shy"),
            Type.Literal("shocked"),
            Type.Literal("sad"),
            Type.Literal("celebrate"),
          ])
        ),
      }),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const interaction = loadInteraction();
        const rawSessionId = readSessionId(ctx);

        if (interaction) {
          const localReceipt = interaction.expressExpression({
            profileId: process.env.PI_PET_PROFILE_ID || "local",
            agentId: "pi",
            rawSessionId,
            text: params && params.text,
            emotion: params && params.emotion,
            dataDir: process.env.PI_PET_DATA_DIR || undefined,
            now: Date.now,
          });

          // If delivered, expired, failed, or a schema rejection, return as-is
          if (!isIdentityOrSessionRejection(localReceipt)) {
            return formatResult(localReceipt);
          }

          // Identity or session rejection -> check for remote fallback
          const remoteConfig = loadRemoteConfig();
          if (!remoteConfig) {
            const annotatedReceipt = {
              ...localReceipt,
              reason: localReceipt.reason
                ? `${localReceipt.reason} (remote fallback unavailable)`
                : "remote fallback unavailable",
            };
            return formatResult(annotatedReceipt);
          }

          const remoteReceipt = await dispatchRemoteExpression(remoteConfig, {
            rawSessionId,
            toolCallId,
            params,
            signal,
            now: Date.now,
          });
          return formatResult(remoteReceipt);
        }

        // No runtime module configured -> check if remote config is present
        const remoteConfig = loadRemoteConfig();
        if (!remoteConfig) {
          const receipt = { status: "failed", reason: "PI_PET_RUNTIME_MODULE not configured or unloadable" };
          return formatResult(receipt);
        }

        // Inline validation before remote POST
        const validation = validateExpression({
          text: params && params.text,
          emotion: params && params.emotion,
        });
        if (!validation.ok) {
          const receipt = {
            schemaVersion: "1",
            commandId: null,
            dedupKey: null,
            petId: null,
            status: "rejected",
            reason: `SchemaValidationError: ${validation.reason}`,
            createdAtMs: Date.now(),
            updatedAtMs: Date.now(),
          };
          return formatResult(receipt);
        }

        const remoteReceipt = await dispatchRemoteExpression(remoteConfig, {
          rawSessionId,
          toolCallId,
          params,
          signal,
          now: Date.now,
        });
        return formatResult(remoteReceipt);
      },
    });
  }

  if (pi && typeof pi.on === "function") {
    attachInboxConsumer(pi);
  }
}

module.exports = piPetExtension;
module.exports.default = piPetExtension;
module.exports.ROUTING_NONCE_HEADER = ROUTING_NONCE_HEADER;
module.exports.ROUTING_NONCE_RE = ROUTING_NONCE_RE;
module.exports.DEFAULT_POLL_INTERVAL_MS = DEFAULT_POLL_INTERVAL_MS;
module.exports.DEFAULT_DRAIN_INTERVAL_MS = DEFAULT_DRAIN_INTERVAL_MS;
module.exports.CLAWD_SERVER_ID = CLAWD_SERVER_ID;
module.exports.CLAWD_SERVER_HEADER = CLAWD_SERVER_HEADER;
module.exports.PEER_CAPABILITY_SLOT_SYMBOL = PEER_CAPABILITY_SLOT_SYMBOL;
module.exports.loadInteraction = loadInteraction;
module.exports.loadRemoteConfig = loadRemoteConfig;
module.exports.resolveLocalRuntimeConfigPath = resolveLocalRuntimeConfigPath;
module.exports.loadLocalRuntimeConfig = loadLocalRuntimeConfig;
module.exports.resolvePeerTransportConfig = resolvePeerTransportConfig;
module.exports.postPeerJson = postPeerJson;
module.exports.countCodePoints = countCodePoints;
module.exports.projectCatalogSession = projectCatalogSession;
module.exports.sanitizeSendDetails = sanitizeSendDetails;
module.exports.validateExpression = validateExpression;
module.exports.isIdentityOrSessionRejection = isIdentityOrSessionRejection;
module.exports.postRemoteExpression = postRemoteExpression;
module.exports.buildRemoteExpressionBody = buildRemoteExpressionBody;
module.exports.toolCallDedupKey = toolCallDedupKey;
module.exports.canonicalizePiSessionId = canonicalizePiSessionId;
module.exports.readSessionId = readSessionId;
module.exports.resolveSessionId = resolveSessionId;
module.exports.getCanonicalSessionId = getCanonicalSessionId;
module.exports.extractMessageText = extractMessageText;
module.exports.createInboxConsumer = createInboxConsumer;
module.exports.attachInboxConsumer = attachInboxConsumer;
