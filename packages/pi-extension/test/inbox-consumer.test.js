"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

const typeboxStub = {
  Type: {
    Object: (properties) => ({ type: "object", properties }),
    Optional: (schema) => schema,
    String: (opts) => ({ type: "string", ...opts }),
    Union: (schemas) => ({ anyOf: schemas }),
    Literal: (value) => ({ const: value }),
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "typebox") return typeboxStub;
  return originalLoad.apply(this, arguments);
};
test.after(() => {
  Module._load = originalLoad;
});

const extension = require("../index.js");

function createMockPi() {
  const listeners = new Map();
  const sentUserMessages = [];

  return {
    listeners,
    sentUserMessages,
    on(event, handler) {
      if (!listeners.has(event)) {
        listeners.set(event, []);
      }
      listeners.get(event).push(handler);
    },
    emit(event, ...args) {
      const handlers = listeners.get(event) || [];
      for (const h of handlers) {
        h(...args);
      }
    },
    sendUserMessage(text, options) {
      sentUserMessages.push({ text, options });
    },
    registerTool() {},
  };
}

test("lifecycle registration only occurs if pi.on exists", () => {
  let registeredTool = null;
  const noPiOn = {
    registerTool(def) {
      registeredTool = def;
    },
  };
  extension(noPiOn);
  assert.ok(registeredTool, "pet_express tool was registered");

  const mockPi = createMockPi();
  extension(mockPi);
  assert.ok(mockPi.listeners.has("session_start"), "session_start handler registered");
  assert.ok(mockPi.listeners.has("session_shutdown"), "session_shutdown handler registered");
  assert.equal(mockPi.listeners.has("reload"), false, "nonstandard reload handler must NOT be registered");
});

test("strict missing session ID: never poll inbox under fallback 'default', empty, or missing", async () => {
  let claimsCount = 0;
  const mockInteraction = {
    claimNextUserMessage: async () => {
      claimsCount++;
      return null;
    },
    settleUserMessage: async () => {},
  };

  const mockPi = createMockPi();
  const lifecycle = extension.attachInboxConsumer(mockPi, {
    interaction: mockInteraction,
  });

  // 1. Trigger session_start with fallback "default"
  mockPi.emit("session_start", { sessionId: "default" });
  assert.equal(lifecycle.getActiveConsumer(), null, "consumer must not start for 'default'");

  // 2. Trigger session_start with empty string
  mockPi.emit("session_start", { sessionId: "" });
  assert.equal(lifecycle.getActiveConsumer(), null, "consumer must not start for empty string");

  // 3. Trigger session_start with whitespace string
  mockPi.emit("session_start", { sessionId: "   " });
  assert.equal(lifecycle.getActiveConsumer(), null, "consumer must not start for whitespace");

  // 4. Trigger session_start with null / undefined
  mockPi.emit("session_start", null);
  assert.equal(lifecycle.getActiveConsumer(), null, "consumer must not start for null");

  // 5. Trigger session_start with sessionManager returning "default"
  mockPi.emit("session_start", {}, { sessionManager: { getSessionId: () => "default" } });
  assert.equal(lifecycle.getActiveConsumer(), null, "consumer must not start for sessionManager returning 'default'");

  // Wait a moment to ensure no asynchronous ticks ran
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(claimsCount, 0, "no claimNextUserMessage should ever be called");
  lifecycle.stop();
});

test("start, shutdown, and reload single-loop behavior: replaces previous loop and stops on shutdown/reload", async () => {
  const claimedBySession = [];
  const mockInteraction = {
    claimNextUserMessage: async ({ rawSessionId }) => {
      claimedBySession.push(rawSessionId);
      return null;
    },
    settleUserMessage: async () => {},
  };

  const mockPi = createMockPi();
  const lifecycle = extension.attachInboxConsumer(mockPi, {
    interaction: mockInteraction,
    pollIntervalMs: 50,
  });

  // 1. session_start with ses-1
  mockPi.emit("session_start", { sessionId: "ses-1" });
  const consumer1 = lifecycle.getActiveConsumer();
  assert.ok(consumer1, "consumer1 started");
  assert.equal(consumer1.sessionId, "pi:ses-1");
  assert.equal(consumer1.isRunning, true);

  await new Promise((r) => setTimeout(r, 25));
  assert.ok(claimedBySession.includes("pi:ses-1"), "claimed for canonical pi:ses-1");

  // 2. session_start with ses-2 replaces previous loop
  mockPi.emit("session_start", { sessionId: "ses-2" });
  const consumer2 = lifecycle.getActiveConsumer();
  assert.ok(consumer2, "consumer2 started");
  assert.equal(consumer2.sessionId, "pi:ses-2");
  assert.equal(consumer1.isRunning, false, "consumer1 must be stopped");
  assert.equal(consumer2.isRunning, true, "consumer2 is running");

  await new Promise((r) => setTimeout(r, 25));
  assert.ok(claimedBySession.includes("pi:ses-2"), "claimed for canonical pi:ses-2");

  // 3. session_shutdown stops the loop
  mockPi.emit("session_shutdown");
  assert.equal(consumer2.isRunning, false, "consumer2 must be stopped after session_shutdown");
  assert.equal(lifecycle.getActiveConsumer(), null);

  const countAfterShutdown = claimedBySession.length;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(claimedBySession.length, countAfterShutdown, "no further polling after session_shutdown");

  // 4. session_shutdown with reason: 'reload' also stops the loop
  mockPi.emit("session_start", { sessionId: "ses-3" });
  const consumer3 = lifecycle.getActiveConsumer();
  assert.ok(consumer3, "consumer3 started");
  assert.equal(consumer3.isRunning, true);

  mockPi.emit("session_shutdown", { reason: "reload" });
  assert.equal(consumer3.isRunning, false, "consumer3 must be stopped after session_shutdown {reason: 'reload'}");
  assert.equal(lifecycle.getActiveConsumer(), null);

  lifecycle.stop();
});

test("two separately attached mock Pi instances do not stop or overwrite each other's consumers", async () => {
  const mockInteraction = {
    claimNextUserMessage: async () => null,
    settleUserMessage: async () => {},
  };

  const mockPi1 = createMockPi();
  const mockPi2 = createMockPi();

  const lifecycle1 = extension.attachInboxConsumer(mockPi1, {
    interaction: mockInteraction,
    pollIntervalMs: 50,
  });
  const lifecycle2 = extension.attachInboxConsumer(mockPi2, {
    interaction: mockInteraction,
    pollIntervalMs: 50,
  });

  // Start consumer on Pi 1
  mockPi1.emit("session_start", { sessionId: "ses-pi-1" });
  const consumer1 = lifecycle1.getActiveConsumer();
  assert.ok(consumer1, "consumer1 started");
  assert.equal(consumer1.sessionId, "pi:ses-pi-1");
  assert.equal(consumer1.isRunning, true);
  assert.equal(lifecycle2.getActiveConsumer(), null, "lifecycle2 has no active consumer yet");

  // Start consumer on Pi 2
  mockPi2.emit("session_start", { sessionId: "ses-pi-2" });
  const consumer2 = lifecycle2.getActiveConsumer();
  assert.ok(consumer2, "consumer2 started");
  assert.equal(consumer2.sessionId, "pi:ses-pi-2");
  assert.equal(consumer2.isRunning, true);
  assert.equal(consumer1.isRunning, true, "consumer1 on pi1 must still be running after pi2 session_start");

  // Shutdown Pi 1 only
  mockPi1.emit("session_shutdown", { reason: "exit" });
  assert.equal(consumer1.isRunning, false, "consumer1 stopped after pi1 shutdown");
  assert.equal(lifecycle1.getActiveConsumer(), null);
  assert.equal(consumer2.isRunning, true, "consumer2 on pi2 MUST still be running after pi1 shutdown");
  assert.equal(lifecycle2.getActiveConsumer(), consumer2);

  // Restart Pi 1 with a new session
  mockPi1.emit("session_start", { sessionId: "ses-pi-1-restarted" });
  const consumer1Restarted = lifecycle1.getActiveConsumer();
  assert.ok(consumer1Restarted, "consumer1 restarted");
  assert.equal(consumer1Restarted.sessionId, "pi:ses-pi-1-restarted");
  assert.equal(consumer1Restarted.isRunning, true);
  assert.equal(consumer2.isRunning, true, "consumer2 on pi2 must not be affected by pi1 restart");

  // Shutdown Pi 2 with reload reason
  mockPi2.emit("session_shutdown", { reason: "reload" });
  assert.equal(consumer2.isRunning, false, "consumer2 stopped after pi2 reload");
  assert.equal(lifecycle2.getActiveConsumer(), null);
  assert.equal(consumer1Restarted.isRunning, true, "consumer1Restarted must still be running after pi2 shutdown");

  lifecycle1.stop();
  lifecycle2.stop();
});

test("resolveSessionId handles throwing getters and function candidates safely without crashing", () => {
  // 1. Getter that throws on event.sessionId
  const throwingEventSessionId = {};
  Object.defineProperty(throwingEventSessionId, "sessionId", {
    get() {
      throw new Error("explosive event.sessionId getter");
    },
  });
  assert.equal(extension.resolveSessionId(throwingEventSessionId), null);

  // 2. Throwing sessionManager.getSessionId on event
  const throwingEventSessionManager = {
    sessionManager: {
      getSessionId() {
        throw new Error("explosive event getSessionId");
      },
    },
  };
  assert.equal(extension.resolveSessionId(throwingEventSessionManager), null);

  // 3. Fallback to ctx when event.sessionId getter throws
  const throwingEventWithValidCtx = {};
  Object.defineProperty(throwingEventWithValidCtx, "sessionId", {
    get() {
      throw new Error("event.sessionId error");
    },
  });
  const validCtx = { sessionId: "ses-recovered-from-ctx" };
  assert.equal(
    extension.resolveSessionId(throwingEventWithValidCtx, validCtx),
    "pi:ses-recovered-from-ctx"
  );

  // 4. Throwing sessionManager on ctx falls back to pi
  const throwingCtx = {
    sessionManager: {
      getSessionId() {
        throw new Error("ctx getSessionId error");
      },
    },
  };
  const validPi = { sessionId: "ses-recovered-from-pi" };
  assert.equal(extension.resolveSessionId(null, throwingCtx, validPi), "pi:ses-recovered-from-pi");

  // 5. Throwing pi.getSessionId returns null safely
  const throwingPi = {
    getSessionId() {
      throw new Error("pi getSessionId error");
    },
  };
  assert.equal(extension.resolveSessionId(null, null, throwingPi), null);

  // 6. Throwing session property getter on event
  const throwingEventSessionObj = {};
  Object.defineProperty(throwingEventSessionObj, "session", {
    get() {
      throw new Error("event.session getter error");
    },
  });
  assert.equal(extension.resolveSessionId(throwingEventSessionObj), null);
});

test("session_start does not crash startup when getSessionId throws", () => {
  const mockPi = createMockPi();
  const lifecycle = extension.attachInboxConsumer(mockPi);

  // session_start with throwing getter/function
  const throwingEvent = {
    sessionManager: {
      getSessionId() {
        throw new Error("Startup sessionManager error");
      },
    },
  };

  assert.doesNotThrow(() => {
    mockPi.emit("session_start", throwingEvent);
  });
  assert.equal(lifecycle.getActiveConsumer(), null);

  lifecycle.stop();
});

test("timer async callback does not produce unhandled promise rejection", async () => {
  let unhandledRejections = 0;
  const onUnhandled = () => {
    unhandledRejections++;
  };
  process.on("unhandledRejection", onUnhandled);

  try {
    const mockInteraction = {
      claimNextUserMessage: async () => {
        throw new Error("Unhandled tick simulation error");
      },
      settleUserMessage: async () => {},
    };

    const mockPi = createMockPi();
    const consumer = extension.createInboxConsumer(mockPi, {
      sessionId: "ses-no-unhandled",
      interaction: mockInteraction,
      pollIntervalMs: 10,
    });

    consumer.start();
    await new Promise((r) => setTimeout(r, 50));
    consumer.stop();

    assert.equal(unhandledRejections, 0, "no unhandled promise rejections should occur");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("own-session isolation via mocked runtime: profileId defaults to local and routes to matching session only", async () => {
  const inboxes = {
    "pi:session-alpha": [
      {
        commandId: "cmd-1",
        claimToken: "tok-1",
        petId: "pet-alpha",
        text: "Message for alpha",
        expiresAtMs: Date.now() + 10000,
      },
    ],
    "pi:session-beta": [
      {
        commandId: "cmd-2",
        claimToken: "tok-2",
        petId: "pet-beta",
        text: "Message for beta",
        expiresAtMs: Date.now() + 10000,
      },
    ],
  };

  const claimsReceived = [];
  const settlements = [];

  const mockInteraction = {
    claimNextUserMessage: async (req) => {
      claimsReceived.push(req);
      const queue = inboxes[req.rawSessionId];
      if (queue && queue.length > 0) {
        return queue.shift();
      }
      return null;
    },
    settleUserMessage: async (settlement) => {
      settlements.push(settlement);
    },
  };

  const oldEnvProfile = process.env.PI_PET_PROFILE_ID;
  delete process.env.PI_PET_PROFILE_ID;

  try {
    const mockPi = createMockPi();
    const consumer = extension.createInboxConsumer(mockPi, {
      sessionId: "session-alpha",
      interaction: mockInteraction,
      pollIntervalMs: 50,
      drainIntervalMs: 0,
    });

    assert.equal(consumer.profileId, "local", "profileId defaults to 'local'");
    await consumer.pollOnce();

    assert.equal(mockPi.sentUserMessages.length, 1);
    assert.equal(mockPi.sentUserMessages[0].text, "Message for alpha");

    // Session alpha inbox is drained, session beta remains untouched
    assert.equal(inboxes["pi:session-alpha"].length, 0);
    assert.equal(inboxes["pi:session-beta"].length, 1, "session-beta message must not be touched");

    assert.equal(claimsReceived[0].agentId, "pi");
    assert.equal(claimsReceived[0].profileId, "local");
    assert.equal(claimsReceived[0].rawSessionId, "pi:session-alpha");
    assert.ok(typeof claimsReceived[0].claimantId === "string");
    assert.equal(typeof claimsReceived[0].now, "function", "claimNextUserMessage receives now as a function");

    assert.equal(settlements.length, 1);
    assert.equal(settlements[0].petId, "pet-alpha");
    assert.equal(settlements[0].commandId, "cmd-1");
    assert.equal(settlements[0].claimToken, "tok-1");
    assert.equal(settlements[0].status, "dispatched");
    assert.equal(typeof settlements[0].now, "function", "settleUserMessage receives now as a function");

    consumer.stop();
  } finally {
    if (oldEnvProfile !== undefined) {
      process.env.PI_PET_PROFILE_ID = oldEnvProfile;
    }
  }
});

test("honors PI_PET_PROFILE_ID environment override", async () => {
  const claims = [];
  const mockInteraction = {
    claimNextUserMessage: async (req) => {
      claims.push(req);
      return null;
    },
    settleUserMessage: async () => {},
  };

  const mockPi = createMockPi();
  const consumer = extension.createInboxConsumer(mockPi, {
    sessionId: "ses-custom",
    interaction: mockInteraction,
    env: { PI_PET_PROFILE_ID: "custom-profile-xyz" },
  });

  assert.equal(consumer.profileId, "custom-profile-xyz");
  await consumer.pollOnce();
  assert.equal(claims[0].profileId, "custom-profile-xyz");
  consumer.stop();
});

test("TTL expiration: re-checks expiresAtMs immediately before dispatch and settles expired without calling Pi", async () => {
  const fixedNow = 1700000010000;
  const expiredMessage = {
    commandId: "cmd-expired",
    claimToken: "tok-expired",
    petId: "pet-test",
    text: "This message is already stale",
    expiresAtMs: fixedNow - 100, // expired in the past
  };

  const settlements = [];
  const mockInteraction = {
    claimNextUserMessage: async () => expiredMessage,
    settleUserMessage: async (s) => {
      settlements.push(s);
    },
  };

  const nowFn = () => fixedNow;
  const mockPi = createMockPi();
  const consumer = extension.createInboxConsumer(mockPi, {
    sessionId: "ses-ttl",
    interaction: mockInteraction,
    now: nowFn,
  });

  const result = await consumer.pollOnce();

  assert.equal(result.hasMore, true, "expired message indicates queue processing hasMore");
  assert.equal(result.status, "expired");
  assert.equal(mockPi.sentUserMessages.length, 0, "pi.sendUserMessage must NOT be called for expired message");

  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].petId, "pet-test");
  assert.equal(settlements[0].commandId, "cmd-expired");
  assert.equal(settlements[0].claimToken, "tok-expired");
  assert.equal(settlements[0].status, "expired");
  assert.equal(settlements[0].reason, "Message expired before dispatch");
  assert.equal(typeof settlements[0].now, "function", "now option must be a function");
  assert.equal(settlements[0].now(), fixedNow);

  consumer.stop();
});

test("exact options: invokes pi.sendUserMessage with followUp and expandPromptTemplates:false, settles dispatched", async () => {
  const validMessage = {
    commandId: "cmd-valid-1",
    claimToken: "tok-valid-1",
    petId: "pet-1",
    text: "User said something through pet",
    expiresAtMs: Date.now() + 60000,
  };

  const settlements = [];
  const mockInteraction = {
    claimNextUserMessage: async () => validMessage,
    settleUserMessage: async (s) => {
      settlements.push(s);
    },
  };

  const mockPi = createMockPi();
  const consumer = extension.createInboxConsumer(mockPi, {
    sessionId: "ses-options",
    interaction: mockInteraction,
  });

  const result = await consumer.pollOnce();

  assert.equal(result.hasMore, true);
  assert.equal(result.status, "dispatched");

  assert.equal(mockPi.sentUserMessages.length, 1);
  assert.equal(mockPi.sentUserMessages[0].text, "User said something through pet");
  assert.deepEqual(mockPi.sentUserMessages[0].options, {
    deliverAs: "followUp",
    expandPromptTemplates: false,
  });

  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].status, "dispatched", "must settle with status 'dispatched', not 'delivered'");
  assert.equal(settlements[0].commandId, "cmd-valid-1");
  assert.equal(settlements[0].claimToken, "tok-valid-1");
  assert.equal(typeof settlements[0].now, "function", "now option must be a function");

  consumer.stop();
});

test("sync throw in pi.sendUserMessage: catches synchronous errors and settles failed without crashing", async () => {
  const message = {
    commandId: "cmd-throw",
    claimToken: "tok-throw",
    petId: "pet-throw",
    text: "Should cause sync throw",
    expiresAtMs: Date.now() + 60000,
  };

  const settlements = [];
  const mockInteraction = {
    claimNextUserMessage: async () => message,
    settleUserMessage: async (s) => {
      settlements.push(s);
    },
  };

  const mockPi = {
    sendUserMessage() {
      throw new Error("Pi session is not accepting follow-up messages");
    },
  };

  const consumer = extension.createInboxConsumer(mockPi, {
    sessionId: "ses-throw",
    interaction: mockInteraction,
  });

  const result = await consumer.pollOnce();

  assert.equal(result.hasMore, true);
  assert.equal(result.status, "failed");
  assert.equal(result.error.message, "Pi session is not accepting follow-up messages");

  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].status, "failed");
  assert.equal(settlements[0].reason, "Pi session is not accepting follow-up messages");
  assert.equal(settlements[0].commandId, "cmd-throw");
  assert.equal(settlements[0].claimToken, "tok-throw");
  assert.equal(typeof settlements[0].now, "function", "now option must be a function");

  consumer.stop();
});

test("no duplicate claim and immediate draining when messages exist", async () => {
  const queue = [
    { commandId: "msg-1", claimToken: "tok-1", petId: "p1", text: "1", expiresAtMs: Date.now() + 10000 },
    { commandId: "msg-2", claimToken: "tok-2", petId: "p1", text: "2", expiresAtMs: Date.now() + 10000 },
    { commandId: "msg-3", claimToken: "tok-3", petId: "p1", text: "3", expiresAtMs: Date.now() + 10000 },
  ];

  let concurrentClaims = 0;
  let maxConcurrentClaims = 0;
  const processedCommands = [];

  const mockInteraction = {
    claimNextUserMessage: async () => {
      concurrentClaims++;
      maxConcurrentClaims = Math.max(maxConcurrentClaims, concurrentClaims);
      await new Promise((r) => setTimeout(r, 5));
      concurrentClaims--;
      return queue.shift() || null;
    },
    settleUserMessage: async ({ commandId }) => {
      processedCommands.push(commandId);
    },
  };

  const mockPi = createMockPi();
  const consumer = extension.createInboxConsumer(mockPi, {
    sessionId: "ses-drain",
    interaction: mockInteraction,
    pollIntervalMs: 50,
    drainIntervalMs: 0,
  });

  consumer.start();

  // Allow draining to run
  await new Promise((r) => setTimeout(r, 80));

  assert.equal(maxConcurrentClaims, 1, "claims must be processed strictly one-at-a-time");
  assert.deepEqual(processedCommands, ["msg-1", "msg-2", "msg-3"], "all 3 messages drained in order");
  assert.equal(mockPi.sentUserMessages.length, 3);
  assert.equal(mockPi.sentUserMessages.map((m) => m.text).join(","), "1,2,3");

  consumer.stop();
});

test("timer unref: custom setTimeout loop unrefs timers", async () => {
  let unrefCalled = 0;
  const customSetTimeout = (fn, delay) => {
    const timer = setTimeout(fn, delay);
    const origUnref = timer.unref;
    timer.unref = function () {
      unrefCalled++;
      return origUnref ? origUnref.apply(this, arguments) : this;
    };
    return timer;
  };

  const mockInteraction = {
    claimNextUserMessage: async () => null,
    settleUserMessage: async () => {},
  };

  const mockPi = createMockPi();
  const consumer = extension.createInboxConsumer(mockPi, {
    sessionId: "ses-unref",
    interaction: mockInteraction,
    pollIntervalMs: 10000,
    setTimeout: customSetTimeout,
  });

  consumer.start();
  assert.ok(unrefCalled >= 1, "setTimeout timer must be unref'ed");

  consumer.stop();
});

test("runtime error in poll loop backs off and does not crash Pi", async () => {
  let attempts = 0;
  const mockInteraction = {
    claimNextUserMessage: async () => {
      attempts++;
      throw new Error("Disk I/O error during claim");
    },
    settleUserMessage: async () => {},
  };

  const mockPi = createMockPi();
  const consumer = extension.createInboxConsumer(mockPi, {
    sessionId: "ses-error",
    interaction: mockInteraction,
    pollIntervalMs: 20,
  });

  consumer.start();

  // Wait long enough for multiple attempts
  await new Promise((r) => setTimeout(r, 60));

  assert.ok(attempts >= 2, "consumer should continue attempting on error without crashing");
  consumer.stop();
});

test("real runtime integration: enqueues user message, claims, dispatches, and persists dispatched receipt with fixed clock", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const realInteraction = require(path.resolve(__dirname, "../../runtime/interaction.js"));

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-inbox-real-"));
  const rawSessionId = "ses-real-integration-1";
  const canonicalSessionId = "pi:ses-real-integration-1";
  const petId = realInteraction.derivePetId({ profileId: "local", agentId: "pi", rawSessionId: canonicalSessionId });

  // Create active session status
  fs.mkdirSync(path.join(dataDir, "status"), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "status", `status-${petId}.json`),
    JSON.stringify({ state: "idle", agentId: "pi", rawSessionId: canonicalSessionId })
  );

  const fixedClock = 1700000000000;
  const nowFn = () => fixedClock;

  // Enqueue a user message via real runtime with fixed clock function
  const enqReceipt = realInteraction.enqueueUserMessage({
    profileId: "local",
    agentId: "pi",
    rawSessionId: canonicalSessionId,
    text: "Hello Pi from user via pet!",
    dataDir,
    now: nowFn,
  });
  assert.equal(enqReceipt.status, "queued");
  assert.ok(enqReceipt.commandId);
  assert.equal(enqReceipt.createdAtMs, fixedClock);

  const mockPi = createMockPi();
  const consumer = extension.createInboxConsumer(mockPi, {
    sessionId: rawSessionId,
    interaction: realInteraction,
    dataDir,
    now: nowFn,
    pollIntervalMs: 20,
    drainIntervalMs: 0,
  });

  const pollResult = await consumer.pollOnce();
  assert.equal(pollResult.status, "dispatched");
  assert.equal(pollResult.hasMore, true);

  // Verify Pi dispatch
  assert.equal(mockPi.sentUserMessages.length, 1);
  assert.equal(mockPi.sentUserMessages[0].text, "Hello Pi from user via pet!");
  assert.deepEqual(mockPi.sentUserMessages[0].options, {
    deliverAs: "followUp",
    expandPromptTemplates: false,
  });

  // Verify settled receipt on disk has fixed clock timestamp
  const rcptPath = path.join(dataDir, "receipts", `rcpt-user-${enqReceipt.commandId}.json`);
  assert.ok(fs.existsSync(rcptPath), "receipt must exist on disk");
  const settledRcpt = JSON.parse(fs.readFileSync(rcptPath, "utf8"));
  assert.equal(settledRcpt.status, "dispatched");
  assert.equal(settledRcpt.commandId, enqReceipt.commandId);
  assert.equal(settledRcpt.text, "Hello Pi from user via pet!");
  assert.equal(settledRcpt.updatedAtMs, fixedClock);

  // Queue should now be empty
  const nextPoll = await consumer.pollOnce();
  assert.equal(nextPoll.hasMore, false);

  consumer.stop();
});

test("real runtime integration with fixed clock: enqueues user message with TTL and verifies fixed-clock expiration and dispatch", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const realInteraction = require(path.resolve(__dirname, "../../runtime/interaction.js"));

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-inbox-clock-"));
  const rawSessionId = "ses-real-clock-1";
  const canonicalSessionId = "pi:ses-real-clock-1";
  const petId = realInteraction.derivePetId({ profileId: "local", agentId: "pi", rawSessionId: canonicalSessionId });

  // Create active session status
  fs.mkdirSync(path.join(dataDir, "status"), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "status", `status-${petId}.json`),
    JSON.stringify({ state: "idle", agentId: "pi", rawSessionId: canonicalSessionId })
  );

  let currentClockMs = 1700000000000;
  const clockFn = () => currentClockMs;

  // 1. Enqueue a message at currentClockMs with 5-second TTL (ttlMs: 5000)
  const enqReceipt1 = realInteraction.enqueueUserMessage({
    profileId: "local",
    agentId: "pi",
    rawSessionId: canonicalSessionId,
    text: "Hello with fixed TTL clock!",
    ttlMs: 5000,
    dataDir,
    now: clockFn,
  });
  assert.equal(enqReceipt1.status, "queued");
  assert.equal(enqReceipt1.createdAtMs, 1700000000000);
  assert.equal(enqReceipt1.expiresAtMs, 1700000005000);

  // 2. Advance clock by 1 second (to 1700000001000 - well before 5s TTL)
  currentClockMs = 1700000001000;

  const mockPi = createMockPi();
  const consumer = extension.createInboxConsumer(mockPi, {
    sessionId: rawSessionId,
    interaction: realInteraction,
    dataDir,
    now: clockFn,
  });

  const pollResult1 = await consumer.pollOnce();
  assert.equal(pollResult1.status, "dispatched");
  assert.equal(mockPi.sentUserMessages.length, 1);
  assert.equal(mockPi.sentUserMessages[0].text, "Hello with fixed TTL clock!");

  // Verify receipt settled on disk with fixed clock timestamp
  const rcptPath1 = path.join(dataDir, "receipts", `rcpt-user-${enqReceipt1.commandId}.json`);
  const settledRcpt1 = JSON.parse(fs.readFileSync(rcptPath1, "utf8"));
  assert.equal(settledRcpt1.status, "dispatched");
  assert.equal(settledRcpt1.updatedAtMs, 1700000001000);

  // 3. Enqueue another message at currentClockMs (1700000001000) with 2-second TTL (expires at 1700000003000)
  const enqReceipt2 = realInteraction.enqueueUserMessage({
    profileId: "local",
    agentId: "pi",
    rawSessionId: canonicalSessionId,
    text: "Message that will expire under fixed clock",
    ttlMs: 2000,
    dataDir,
    now: clockFn,
  });
  assert.equal(enqReceipt2.status, "queued");
  assert.equal(enqReceipt2.expiresAtMs, 1700000003000);

  // 4. Advance fixed clock to 1700000004000 (past 2s TTL)
  currentClockMs = 1700000004000;

  // Polling now will see the expired message
  const pollResult2 = await consumer.pollOnce();
  assert.equal(mockPi.sentUserMessages.length, 1, "pi.sendUserMessage must not be called for expired message");

  // Verify receipt on disk is settled as expired with fixed clock timestamp
  const rcptPath2 = path.join(dataDir, "receipts", `rcpt-user-${enqReceipt2.commandId}.json`);
  assert.ok(fs.existsSync(rcptPath2), "receipt must exist on disk");
  const settledRcpt2 = JSON.parse(fs.readFileSync(rcptPath2, "utf8"));
  assert.equal(settledRcpt2.status, "expired");
  assert.equal(settledRcpt2.updatedAtMs, 1700000004000);

  consumer.stop();
});

test("canonicalizePiSessionId canonicalizes raw Pi session ID and avoids double prefix", () => {
  // Plain IDs get pi: prefix
  assert.equal(extension.canonicalizePiSessionId("ses-1"), "pi:ses-1");
  assert.equal(extension.canonicalizePiSessionId("  ses-2  "), "pi:ses-2");
  assert.equal(extension.canonicalizePiSessionId("pi-session"), "pi:pi-session");

  // Already prefixed with pi: preserved without double prefix
  assert.equal(extension.canonicalizePiSessionId("pi:ses-1"), "pi:ses-1");
  assert.equal(extension.canonicalizePiSessionId("  pi:ses-2  "), "pi:ses-2");
  assert.equal(extension.canonicalizePiSessionId("pi:pi-session"), "pi:pi-session");
  assert.equal(extension.canonicalizePiSessionId("pi:pi:session"), "pi:pi:session");

  // Rejection of default, whitespace, empty, and invalid types
  assert.equal(extension.canonicalizePiSessionId("default"), null);
  assert.equal(extension.canonicalizePiSessionId("  default  "), null);
  assert.equal(extension.canonicalizePiSessionId("pi:default"), null);
  assert.equal(extension.canonicalizePiSessionId("  pi:default  "), null);
  assert.equal(extension.canonicalizePiSessionId("pi:"), null);
  assert.equal(extension.canonicalizePiSessionId("  pi:  "), null);
  assert.equal(extension.canonicalizePiSessionId(""), null);
  assert.equal(extension.canonicalizePiSessionId("   "), null);
  assert.equal(extension.canonicalizePiSessionId(null), null);
  assert.equal(extension.canonicalizePiSessionId(undefined), null);
  assert.equal(extension.canonicalizePiSessionId(12345), null);
  assert.equal(extension.canonicalizePiSessionId({}), null);
});

test("resolveSessionId helper handles multiple formats and rejects default/empty", () => {
  // Direct strings
  assert.equal(extension.resolveSessionId("ses-1"), "pi:ses-1");
  assert.equal(extension.resolveSessionId("  ses-2  "), "pi:ses-2");
  assert.equal(extension.resolveSessionId("pi:ses-1"), "pi:ses-1");
  assert.equal(extension.resolveSessionId("pi:pi-sess"), "pi:pi-sess");
  assert.equal(extension.resolveSessionId("pi-sess"), "pi:pi-sess");
  assert.equal(extension.resolveSessionId("default"), null);
  assert.equal(extension.resolveSessionId("pi:default"), null);
  assert.equal(extension.resolveSessionId("pi:"), null);
  assert.equal(extension.resolveSessionId("   "), null);
  assert.equal(extension.resolveSessionId(""), null);

  // Event object
  assert.equal(extension.resolveSessionId({ sessionId: "ses-3" }), "pi:ses-3");
  assert.equal(extension.resolveSessionId({ rawSessionId: "ses-4" }), "pi:ses-4");
  assert.equal(extension.resolveSessionId({ rawSessionId: "pi:ses-4" }), "pi:ses-4");
  assert.equal(extension.resolveSessionId({ sessionManager: { getSessionId: () => "ses-5" } }), "pi:ses-5");
  assert.equal(extension.resolveSessionId({ session: { id: "ses-6" } }), "pi:ses-6");
  assert.equal(extension.resolveSessionId({ sessionId: "default" }), null);
  assert.equal(extension.resolveSessionId({ sessionId: "pi:default" }), null);

  // Context object
  assert.equal(extension.resolveSessionId(null, { sessionId: "ses-7" }), "pi:ses-7");
  assert.equal(extension.resolveSessionId(null, { sessionId: "pi:ses-7" }), "pi:ses-7");
  assert.equal(extension.resolveSessionId(null, { sessionManager: { getSessionId: () => "ses-8" } }), "pi:ses-8");

  // Pi object
  assert.equal(extension.resolveSessionId(null, null, { sessionId: "ses-9" }), "pi:ses-9");
  assert.equal(extension.resolveSessionId(null, null, { sessionId: "pi:ses-9" }), "pi:ses-9");
  assert.equal(extension.resolveSessionId(null, null, { getSessionId: () => "ses-10" }), "pi:ses-10");
  assert.equal(extension.resolveSessionId(null, null, { sessionManager: { getSessionId: () => "ses-11" } }), "pi:ses-11");
});

test("extractMessageText helper accepts only canonical .text property without guessing aliases", () => {
  assert.equal(extension.extractMessageText({ text: "text-1" }), "text-1");
  assert.equal(extension.extractMessageText({ payload: { text: "text-2" } }), "");
  assert.equal(extension.extractMessageText({ message: "text-3" }), "");
  assert.equal(extension.extractMessageText({ content: "text-4" }), "");
  assert.equal(extension.extractMessageText(null), "");
  assert.equal(extension.extractMessageText({}), "");
  assert.equal(extension.extractMessageText({ text: "" }), "");
  assert.equal(extension.extractMessageText({ text: 12345 }), "");
});

test("malformed and empty claims settle failed without calling pi.sendUserMessage", async () => {
  const malformedCases = [
    { name: "empty text", claim: { commandId: "cmd-empty", claimToken: "tok-empty", petId: "pet-m1", text: "" } },
    { name: "missing text", claim: { commandId: "cmd-missing", claimToken: "tok-missing", petId: "pet-m2" } },
    { name: "non-string text", claim: { commandId: "cmd-nonstr", claimToken: "tok-nonstr", petId: "pet-m3", text: 12345 } },
    { name: "payload alias", claim: { commandId: "cmd-payload", claimToken: "tok-payload", petId: "pet-m4", payload: { text: "aliased" } } },
    { name: "message alias", claim: { commandId: "cmd-message", claimToken: "tok-message", petId: "pet-m5", message: "aliased" } },
    { name: "content alias", claim: { commandId: "cmd-content", claimToken: "tok-content", petId: "pet-m6", content: "aliased" } },
  ];

  for (const c of malformedCases) {
    const settlements = [];
    const mockInteraction = {
      claimNextUserMessage: async () => c.claim,
      settleUserMessage: async (s) => {
        settlements.push(s);
      },
    };

    const mockPi = createMockPi();
    const consumer = extension.createInboxConsumer(mockPi, {
      sessionId: "ses-malformed",
      interaction: mockInteraction,
    });

    const result = await consumer.pollOnce();
    assert.equal(result.hasMore, true, `${c.name}: should have hasMore true`);
    assert.equal(result.status, "failed", `${c.name}: should settle failed`);
    assert.equal(mockPi.sentUserMessages.length, 0, `${c.name}: pi.sendUserMessage must NOT be called`);

    assert.equal(settlements.length, 1, `${c.name}: should settle receipt`);
    assert.equal(settlements[0].status, "failed", `${c.name}: settlement status must be failed`);
    assert.equal(settlements[0].commandId, c.claim.commandId);
    assert.equal(settlements[0].claimToken, c.claim.claimToken);
    assert.ok(typeof settlements[0].reason === "string", `${c.name}: settlement should have failure reason`);

    consumer.stop();
  }
});
