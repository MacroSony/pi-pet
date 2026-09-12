"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const extension = require("../index.js");

const PEER_SLOT = Symbol.for("pi-pet.peer-capability.v1");
const VALID_TOKEN = "ab".repeat(32);
const Type = {
  Object: (properties) => ({ type: "object", properties }),
  Optional: (schema) => schema,
  String: (opts) => ({ type: "string", ...opts }),
  Union: (schemas) => ({ anyOf: schemas }),
  Literal: (value) => ({ const: value }),
};

function makeClaim({ hopCount = 0 } = {}) {
  const now = 1700000000000;
  return {
    schemaVersion: "1",
    kind: "peer_message",
    messageId: `msg_wake_${hopCount}`,
    dedupKey: `msg_wake_${hopCount}`,
    targetPetId: "pet_local_pi_pi:wake-target",
    sourcePetId: "pet_source_internal",
    sourceDisplayName: "Wake Source · Pi",
    sourceHost: "Homelab",
    text: hopCount === 0 ? "Please check the demo." : "The demo looks good.",
    deliverAs: "followUp",
    threadId: "thr_wake_test",
    hopCount,
    maxHops: 1,
    replyHandle: hopCount === 0 ? "psh_reply_once" : null,
    createdAtMs: now - 1000,
    expiresAtMs: now + 59000,
    claimToken: `claim_${hopCount}`,
    claimedAtMs: now,
  };
}

function makeConsumer(claim, shouldTriggerPeerTurn) {
  const sent = [];
  const settlements = [];
  const pi = {
    sendUserMessage() {
      throw new Error("peer message must not use sendUserMessage");
    },
    sendMessage(message, options) {
      sent.push({ message, options });
    },
  };
  const interaction = {
    derivePetId: ({ profileId, agentId, rawSessionId }) => `pet_${profileId}_${agentId}_${rawSessionId}`,
    claimNextUserMessage: async () => null,
    settleUserMessage: async () => ({ status: "empty" }),
    claimNextPeerMessage: async () => claim,
    settlePeerMessage: async (entry) => {
      settlements.push(entry);
      return { status: entry.status, messageId: entry.messageId };
    },
  };
  const consumer = extension.createInboxConsumer(pi, {
    sessionId: "wake-target",
    profileId: "local",
    interaction,
    now: () => 1700000000000,
    shouldTriggerPeerTurn,
  });
  return { consumer, sent, settlements };
}

test.afterEach(() => {
  delete globalThis[PEER_SLOT];
});

test("peer wake state is attach-local, session-bound, and defaults off", () => {
  const state = extension.createPeerWakeState();
  assert.equal(state.enabled, false);
  assert.equal(state.isEnabledFor("pi:a"), false);

  assert.equal(state.enableFor("a"), true);
  assert.equal(state.isEnabledFor("pi:a"), true);
  assert.equal(state.isEnabledFor("pi:b"), false);

  state.resetFor("b");
  assert.equal(state.enabled, false);
  assert.equal(state.isEnabledFor("pi:a"), false);
  assert.equal(state.isEnabledFor("pi:b"), false);

  state.enableFor("pi:b");
  state.disable();
  assert.equal(state.enabled, false);
});

test("shared capability slot wake mode preserves the process-private token and fails closed", () => {
  globalThis[PEER_SLOT] = Object.freeze({ version: 1, token: VALID_TOKEN });
  assert.equal(extension.setSharedPeerWakeMode("bounded"), true);
  assert.deepEqual(globalThis[PEER_SLOT], {
    version: 1,
    token: VALID_TOKEN,
    wakeMode: "bounded",
  });

  assert.equal(extension.setSharedPeerWakeMode("off"), true);
  assert.equal(globalThis[PEER_SLOT].wakeMode, "off");
  assert.equal(extension.setSharedPeerWakeMode("invalid"), false);

  delete globalThis[PEER_SLOT];
  assert.equal(extension.setSharedPeerWakeMode("bounded"), false);
});

test("every session start resets wake policy, including invalid or runtime-unavailable starts", () => {
  const handlers = {};
  const starts = [];
  let shutdowns = 0;
  const lifecycle = extension.attachInboxConsumer({
    on(name, handler) { handlers[name] = handler; },
  }, {
    env: {},
    onSessionStart: (sessionId) => starts.push(sessionId),
    onSessionShutdown: () => { shutdowns++; },
  });

  handlers.session_start({ sessionId: "remote-only-session" }, {});
  assert.deepEqual(starts, ["pi:remote-only-session"]);
  assert.ok(lifecycle.getActiveConsumer());

  handlers.session_start({ sessionId: "default" }, {});
  assert.deepEqual(starts, ["pi:remote-only-session", null]);
  assert.equal(lifecycle.getActiveConsumer(), null);

  handlers.session_shutdown({ reason: "reload" }, {});
  assert.equal(shutdowns, 1);
  lifecycle.stop();
});

test("/pet-peer-wake explicitly enables, reports, and disables PoC wake mode", async () => {
  globalThis[PEER_SLOT] = Object.freeze({ version: 1, token: VALID_TOKEN });
  const commands = new Map();
  const notifications = [];
  const pi = {
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
    registerTool() {},
  };
  extension(pi, { Type });

  const command = commands.get("pet-peer-wake");
  assert.ok(command);
  const ctx = {
    sessionManager: { getSessionId: () => "wake-command-session" },
    ui: { notify: (text, level) => notifications.push({ text, level }) },
  };

  await command.handler("status", ctx);
  assert.match(notifications.at(-1).text, /is off/);

  await command.handler("on", ctx);
  assert.equal(globalThis[PEER_SLOT].wakeMode, "bounded");
  assert.match(notifications.at(-1).text, /is ON/);

  await command.handler("status", ctx);
  assert.match(notifications.at(-1).text, /is on/);

  await command.handler("off", ctx);
  assert.equal(globalThis[PEER_SLOT].wakeMode, "off");
  assert.match(notifications.at(-1).text, /is OFF/);

  await command.handler("banana", ctx);
  assert.match(notifications.at(-1).text, /Usage:/);
  assert.equal(notifications.at(-1).level, "error");
});

test("enabled receiver wakes on hop 0 and includes the single reply guidance", async () => {
  const { consumer, sent, settlements } = makeConsumer(makeClaim({ hopCount: 0 }), () => true);
  const result = await consumer.pollOnce();

  assert.equal(result.status, "dispatched");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].options, { deliverAs: "followUp", triggerTurn: true });
  assert.match(sent[0].message.content, /Optional reply target: psh_reply_once/);
  assert.match(sent[0].message.content, /use only the supplied reply target/);
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].status, "dispatched");
});

test("enabled receiver wakes on hop 1 but receives a hard-stop instruction and no reply handle", async () => {
  const { consumer, sent } = makeConsumer(makeClaim({ hopCount: 1 }), () => true);
  const result = await consumer.pollOnce();

  assert.equal(result.status, "dispatched");
  assert.deepEqual(sent[0].options, { deliverAs: "followUp", triggerTurn: true });
  assert.doesNotMatch(sent[0].message.content, /Optional reply target:/);
  assert.match(sent[0].message.content, /no reply budget left/);
  assert.equal(sent[0].message.details.replyHandle, null);
});

test("wake policy errors fail closed to the unchanged passive M2 behavior", async () => {
  const { consumer, sent } = makeConsumer(makeClaim({ hopCount: 0 }), () => {
    throw new Error("policy unavailable");
  });
  await consumer.pollOnce();

  assert.deepEqual(sent[0].options, { deliverAs: "followUp", triggerTurn: false });
  assert.doesNotMatch(sent[0].message.content, /receiver opted into/);
});
