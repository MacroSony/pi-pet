"use strict";

// Pi Pet Phase B — pet_express tool (agent → pet expression).
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
// Configuration (environment):
//   PI_PET_RUNTIME_MODULE         — trusted absolute path to packages/runtime/interaction.js.
//                                   Optional if remote config is present; required for local delivery.
//   PI_PET_CLAWD_REMOTE_CONFIG    — trusted absolute path to clawd-remote.json override.
//                                   Default: ~/.pi/agent/extensions/clawd-on-desk/clawd-remote.json.
//   PI_PET_DATA_DIR               — runtime data dir override (default: ~/.pi-pet).
//   PI_PET_PROFILE_ID             — profile identity component (default: "local").

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
  try {
    const manager = ctx && ctx.sessionManager;
    if (manager && typeof manager.getSessionId === "function") {
      const value = manager.getSessionId();
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  } catch {
    // fall through to default
  }
  return "default";
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
  const body = {
    schemaVersion: "1",
    kind: "pet_expression",
    rawSessionId,
    agentId: "pi",
    createdAtMs: now(),
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

function piPetExtension(pi) {
  const { Type } = require("typebox");

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
      });
      return formatResult(remoteReceipt);
    },
  });
}

module.exports = piPetExtension;
module.exports.default = piPetExtension;
module.exports.ROUTING_NONCE_HEADER = ROUTING_NONCE_HEADER;
module.exports.ROUTING_NONCE_RE = ROUTING_NONCE_RE;
module.exports.loadRemoteConfig = loadRemoteConfig;
module.exports.validateExpression = validateExpression;
module.exports.isIdentityOrSessionRejection = isIdentityOrSessionRejection;
module.exports.postRemoteExpression = postRemoteExpression;
module.exports.buildRemoteExpressionBody = buildRemoteExpressionBody;
module.exports.toolCallDedupKey = toolCallDedupKey;
