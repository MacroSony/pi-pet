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

function readSessionId(ctx) {
  if (!ctx || typeof ctx !== "object") return "default";
  try {
    const manager = ctx.sessionManager;
    if (manager && typeof manager.getSessionId === "function") {
      const value = manager.getSessionId();
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  } catch {}
  try {
    if (typeof ctx.sessionId === "string" && ctx.sessionId.trim()) {
      return ctx.sessionId.trim();
    }
  } catch {}
  return "default";
}

function resolveSessionId(event, ctx, pi) {
  function sanitize(val) {
    if (typeof val === "string") {
      const trimmed = val.trim();
      if (trimmed && trimmed !== "default") {
        return trimmed;
      }
    }
    return null;
  }

  function tryExtract(fn) {
    try {
      return sanitize(fn());
    } catch {
      return null;
    }
  }

  // 1. Direct string event
  if (typeof event === "string") {
    const s = sanitize(event);
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

function createInboxConsumer(pi, options = {}) {
  const env = options.env || process.env;
  const profileId = (
    typeof options.profileId === "string" && options.profileId.trim()
      ? options.profileId.trim()
      : (typeof env.PI_PET_PROFILE_ID === "string" && env.PI_PET_PROFILE_ID.trim() ? env.PI_PET_PROFILE_ID.trim() : "local")
  );
  const rawSessionId = options.sessionId || options.rawSessionId;
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

  if (
    !rawSessionId ||
    typeof rawSessionId !== "string" ||
    !rawSessionId.trim() ||
    rawSessionId.trim() === "default"
  ) {
    return null;
  }

  const normalizedSessionId = rawSessionId.trim();

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

function piPetExtension(pi) {
  const { Type } = require("typebox");

  if (pi && typeof pi.registerTool === "function") {
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
module.exports.loadInteraction = loadInteraction;
module.exports.loadRemoteConfig = loadRemoteConfig;
module.exports.validateExpression = validateExpression;
module.exports.isIdentityOrSessionRejection = isIdentityOrSessionRejection;
module.exports.postRemoteExpression = postRemoteExpression;
module.exports.buildRemoteExpressionBody = buildRemoteExpressionBody;
module.exports.toolCallDedupKey = toolCallDedupKey;
module.exports.resolveSessionId = resolveSessionId;
module.exports.extractMessageText = extractMessageText;
module.exports.createInboxConsumer = createInboxConsumer;
module.exports.attachInboxConsumer = attachInboxConsumer;
