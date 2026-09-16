const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const extension = require("../index.js");

const VALID_TOKEN = "a".repeat(64);
const PEER_SLOT = Symbol.for("pi-pet.peer-capability.v1");

const typeboxStub = {
  Type: {
    Object: (props) => ({ type: "object", properties: props }),
    Optional: (schema) => ({ ...schema, optional: true }),
    String: (opts) => ({ type: "string", ...opts }),
    Integer: (opts) => ({ type: "integer", ...opts }),
    Union: (schemas) => ({ anyOf: schemas }),
    Literal: (val) => ({ const: val }),
    Array: (items, opts) => ({ type: "array", items, ...opts }),
  },
};

function setPeerCapabilitySlot(token = VALID_TOKEN, wakeMode = "off") {
  globalThis[PEER_SLOT] = Object.freeze({
    version: 1,
    token,
    wakeMode,
  });
}

function clearPeerCapabilitySlot() {
  delete globalThis[PEER_SLOT];
}

function createMockPi() {
  const commands = new Map();
  const listeners = new Map();
  const appendedEntries = [];
  const tools = new Map();

  const pi = {
    commands,
    listeners,
    appendedEntries,
    tools,
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
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
    appendEntry(customType, data) {
      appendedEntries.push({ type: "custom", customType, data });
    },
  };

  return pi;
}

function makeMockCtx(sessionId, branch = [], notifications = []) {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => branch,
    },
    ui: {
      notify: (text, level = "info") => {
        notifications.push({ text, level });
      },
    },
  };
}

describe("Pi Pet Permission State Persistence Slice", () => {
  beforeEach(() => {
    setPeerCapabilitySlot(VALID_TOKEN, "off");
  });

  afterEach(() => {
    clearPeerCapabilitySlot();
  });

  describe("Snapshot Validation", () => {
    test("accepts strictly valid version 1 snapshot", () => {
      const valid = {
        version: 1,
        peerWake: true,
        teamAutonomy: false,
        boardWrite: true,
      };
      const result = extension.validatePermissionSnapshot(valid);
      assert.deepEqual(result, valid);
    });

    test("accepts all boolean combinations", () => {
      for (const pw of [true, false]) {
        for (const ta of [true, false]) {
          for (const bw of [true, false]) {
            const snap = { version: 1, peerWake: pw, teamAutonomy: ta, boardWrite: bw };
            assert.deepEqual(extension.validatePermissionSnapshot(snap), snap);
          }
        }
      }
    });

    test("rejects invalid version", () => {
      assert.equal(extension.validatePermissionSnapshot({ version: 2, peerWake: false, teamAutonomy: false, boardWrite: false }), null);
      assert.equal(extension.validatePermissionSnapshot({ version: "1", peerWake: false, teamAutonomy: false, boardWrite: false }), null);
      assert.equal(extension.validatePermissionSnapshot({ version: 0, peerWake: false, teamAutonomy: false, boardWrite: false }), null);
    });

    test("rejects missing keys", () => {
      assert.equal(extension.validatePermissionSnapshot({ version: 1, peerWake: true, teamAutonomy: false }), null);
      assert.equal(extension.validatePermissionSnapshot({ version: 1, peerWake: true }), null);
      assert.equal(extension.validatePermissionSnapshot({ version: 1 }), null);
    });

    test("rejects unexpected extra keys (including tokens, IDs, handles)", () => {
      assert.equal(extension.validatePermissionSnapshot({
        version: 1, peerWake: true, teamAutonomy: false, boardWrite: false,
        token: VALID_TOKEN,
      }), null);

      assert.equal(extension.validatePermissionSnapshot({
        version: 1, peerWake: true, teamAutonomy: false, boardWrite: false,
        sessionId: "ses-123",
      }), null);

      assert.equal(extension.validatePermissionSnapshot({
        version: 1, peerWake: true, teamAutonomy: false, boardWrite: false,
        petId: "pet_123",
      }), null);

      assert.equal(extension.validatePermissionSnapshot({
        version: 1, peerWake: true, teamAutonomy: false, boardWrite: false,
        handle: "psh_abc",
      }), null);
    });

    test("rejects non-boolean permission values", () => {
      assert.equal(extension.validatePermissionSnapshot({ version: 1, peerWake: "on", teamAutonomy: false, boardWrite: false }), null);
      assert.equal(extension.validatePermissionSnapshot({ version: 1, peerWake: 1, teamAutonomy: false, boardWrite: false }), null);
      assert.equal(extension.validatePermissionSnapshot({ version: 1, peerWake: null, teamAutonomy: false, boardWrite: false }), null);
      assert.equal(extension.validatePermissionSnapshot({ version: 1, peerWake: true, teamAutonomy: undefined, boardWrite: false }), null);
    });

    test("rejects non-objects, arrays, and null", () => {
      assert.equal(extension.validatePermissionSnapshot(null), null);
      assert.equal(extension.validatePermissionSnapshot(undefined), null);
      assert.equal(extension.validatePermissionSnapshot([]), null);
      assert.equal(extension.validatePermissionSnapshot("string"), null);
      assert.equal(extension.validatePermissionSnapshot(123), null);
    });
  });

  describe("New session / No entry default all off", () => {
    test("new session with empty branch defaults all permissions to off", async () => {
      const pi = createMockPi();
      extension(pi, { Type: typeboxStub.Type });

      const notifications = [];
      const ctx = makeMockCtx("ses-new", [], notifications);

      pi.emit("session_start", { sessionId: "ses-new" }, ctx);

      // Verify commands report off
      const wakeCmd = pi.commands.get("pet-peer-wake");
      const autoCmd = pi.commands.get("pet-team-autonomy");
      const boardCmd = pi.commands.get("pet-board-write");

      await wakeCmd.handler("status", ctx);
      assert.match(notifications.at(-1).text, /is off/);

      await autoCmd.handler("status", ctx);
      assert.match(notifications.at(-1).text, /is off/);

      await boardCmd.handler("status", ctx);
      assert.match(notifications.at(-1).text, /is off/);

      assert.equal(globalThis[PEER_SLOT].wakeMode, "off");
      assert.equal(pi.appendedEntries.length, 0);
    });

    test("session with non-permission entries only defaults all to off", async () => {
      const pi = createMockPi();
      extension(pi, { Type: typeboxStub.Type });

      const branch = [
        { type: "message", role: "user", content: "hello" },
        { type: "custom", customType: "other-extension-entry", data: { foo: "bar" } },
      ];

      const notifications = [];
      const ctx = makeMockCtx("ses-messages-only", branch, notifications);

      pi.emit("session_start", { sessionId: "ses-messages-only" }, ctx);

      const wakeCmd = pi.commands.get("pet-peer-wake");
      await wakeCmd.handler("status", ctx);
      assert.match(notifications.at(-1).text, /is off/);
      assert.equal(globalThis[PEER_SLOT].wakeMode, "off");
    });
  });

  describe("Successful on/off persistence via pi.appendEntry", () => {
    test("persists declarative snapshots on successful /pet-peer-wake, /pet-team-autonomy, /pet-board-write changes", async () => {
      const pi = createMockPi();
      extension(pi, { Type: typeboxStub.Type });

      const notifications = [];
      const branch = [];
      const ctx = makeMockCtx("ses-persist", branch, notifications);

      pi.emit("session_start", { sessionId: "ses-persist" }, ctx);
      assert.equal(pi.appendedEntries.length, 0);

      const wakeCmd = pi.commands.get("pet-peer-wake");
      const autoCmd = pi.commands.get("pet-team-autonomy");
      const boardCmd = pi.commands.get("pet-board-write");

      // 1. Turn on peer wake
      await wakeCmd.handler("on", ctx);
      assert.equal(pi.appendedEntries.length, 1);
      assert.equal(pi.appendedEntries[0].customType, "pi-pet-permissions");
      assert.deepEqual(pi.appendedEntries[0].data, {
        version: 1,
        peerWake: true,
        teamAutonomy: false,
        boardWrite: false,
      });
      assert.equal(globalThis[PEER_SLOT].wakeMode, "bounded");

      // 2. Turn on team autonomy
      await autoCmd.handler("on", ctx);
      assert.equal(pi.appendedEntries.length, 2);
      assert.deepEqual(pi.appendedEntries[1].data, {
        version: 1,
        peerWake: true,
        teamAutonomy: true,
        boardWrite: false,
      });

      // 3. Turn on board write
      await boardCmd.handler("on", ctx);
      assert.equal(pi.appendedEntries.length, 3);
      assert.deepEqual(pi.appendedEntries[2].data, {
        version: 1,
        peerWake: true,
        teamAutonomy: true,
        boardWrite: true,
      });

      // 4. Turn off peer wake (tombstone)
      await wakeCmd.handler("off", ctx);
      assert.equal(pi.appendedEntries.length, 4);
      assert.deepEqual(pi.appendedEntries[3].data, {
        version: 1,
        peerWake: false,
        teamAutonomy: true,
        boardWrite: true,
      });
      assert.equal(globalThis[PEER_SLOT].wakeMode, "off");

      // 5. Turn off team autonomy
      await autoCmd.handler("off", ctx);
      assert.equal(pi.appendedEntries.length, 5);
      assert.deepEqual(pi.appendedEntries[4].data, {
        version: 1,
        peerWake: false,
        teamAutonomy: false,
        boardWrite: true,
      });

      // 6. Turn off board write
      await boardCmd.handler("off", ctx);
      assert.equal(pi.appendedEntries.length, 6);
      assert.deepEqual(pi.appendedEntries[5].data, {
        version: 1,
        peerWake: false,
        teamAutonomy: false,
        boardWrite: false,
      });
    });

    test("failed on commands do not append custom entries", async () => {
      const pi = createMockPi();
      extension(pi, { Type: typeboxStub.Type });

      clearPeerCapabilitySlot();

      const notifications = [];
      const ctx = makeMockCtx("ses-fail", [], notifications);

      const wakeCmd = pi.commands.get("pet-peer-wake");
      const autoCmd = pi.commands.get("pet-team-autonomy");
      const boardCmd = pi.commands.get("pet-board-write");

      await wakeCmd.handler("on", ctx);
      assert.match(notifications.at(-1).text, /unavailable/);
      assert.equal(pi.appendedEntries.length, 0);

      await autoCmd.handler("on", ctx);
      assert.match(notifications.at(-1).text, /unavailable/);
      assert.equal(pi.appendedEntries.length, 0);

      await boardCmd.handler("on", ctx);
      assert.match(notifications.at(-1).text, /unavailable/);
      assert.equal(pi.appendedEntries.length, 0);
    });

    test("status queries do not append custom entries", async () => {
      const pi = createMockPi();
      extension(pi, { Type: typeboxStub.Type });

      const ctx = makeMockCtx("ses-status", []);
      const wakeCmd = pi.commands.get("pet-peer-wake");
      await wakeCmd.handler("status", ctx);
      await wakeCmd.handler("", ctx);
      assert.equal(pi.appendedEntries.length, 0);
    });
  });

  describe("Resume / Reload Restoration", () => {
    test("session_start restores active permissions and re-enables shared peer wake mode", async () => {
      const pi = createMockPi();
      extension(pi, { Type: typeboxStub.Type });

      const branch = [
        {
          type: "custom",
          customType: "pi-pet-permissions",
          data: {
            version: 1,
            peerWake: true,
            teamAutonomy: true,
            boardWrite: true,
          },
        },
      ];

      const notifications = [];
      const ctx = makeMockCtx("ses-restore", branch, notifications);

      pi.emit("session_start", { sessionId: "ses-restore" }, ctx);

      // Peer wake shared slot must be re-applied to bounded
      assert.equal(globalThis[PEER_SLOT].wakeMode, "bounded");

      const wakeCmd = pi.commands.get("pet-peer-wake");
      const autoCmd = pi.commands.get("pet-team-autonomy");
      const boardCmd = pi.commands.get("pet-board-write");

      await wakeCmd.handler("status", ctx);
      assert.match(notifications.at(-1).text, /is on/);

      await autoCmd.handler("status", ctx);
      assert.match(notifications.at(-1).text, /is on/);

      await boardCmd.handler("status", ctx);
      assert.match(notifications.at(-1).text, /is on/);
    });

    test("session reload restores last matching snapshot across multiple history entries", async () => {
      const pi = createMockPi();
      extension(pi, { Type: typeboxStub.Type });

      const branch = [
        {
          type: "custom",
          customType: "pi-pet-permissions",
          data: {
            version: 1,
            peerWake: true,
            teamAutonomy: true,
            boardWrite: true,
          },
        },
        {
          type: "message",
          role: "user",
          content: "turn off board write",
        },
        {
          type: "custom",
          customType: "pi-pet-permissions",
          data: {
            version: 1,
            peerWake: true,
            teamAutonomy: false,
            boardWrite: true,
          },
        },
      ];

      const notifications = [];
      const ctx = makeMockCtx("ses-reload", branch, notifications);

      pi.emit("session_start", { sessionId: "ses-reload" }, ctx);

      assert.equal(globalThis[PEER_SLOT].wakeMode, "bounded");

      const wakeCmd = pi.commands.get("pet-peer-wake");
      const autoCmd = pi.commands.get("pet-team-autonomy");
      const boardCmd = pi.commands.get("pet-board-write");

      await wakeCmd.handler("status", ctx);
      assert.match(notifications.at(-1).text, /is on/);

      await autoCmd.handler("status", ctx);
      assert.match(notifications.at(-1).text, /is off/);

      await boardCmd.handler("status", ctx);
      assert.match(notifications.at(-1).text, /is on/);
    });

    test("rejects serialized JSON string in entry.data", async () => {
      const pi = createMockPi();
      extension(pi, { Type: typeboxStub.Type });

      const branch = [
        {
          type: "custom",
          customType: "pi-pet-permissions",
          data: JSON.stringify({
            version: 1,
            peerWake: false,
            teamAutonomy: true,
            boardWrite: false,
          }),
        },
      ];

      const notifications = [];
      const ctx = makeMockCtx("ses-json-str", branch, notifications);

      pi.emit("session_start", { sessionId: "ses-json-str" }, ctx);

      assert.equal(globalThis[PEER_SLOT].wakeMode, "off");

      const autoCmd = pi.commands.get("pet-team-autonomy");
      await autoCmd.handler("status", ctx);
      assert.match(notifications.at(-1).text, /is off/);
    });
  });

  describe("Branch Navigation (session_tree)", () => {
    test("session_tree restores permissions from newly active branch", async () => {
      const pi = createMockPi();
      extension(pi, { Type: typeboxStub.Type });

      const branchA = [
        {
          type: "custom",
          customType: "pi-pet-permissions",
          data: {
            version: 1,
            peerWake: true,
            teamAutonomy: true,
            boardWrite: false,
          },
        },
      ];

      const branchB = [
        {
          type: "custom",
          customType: "pi-pet-permissions",
          data: {
            version: 1,
            peerWake: false,
            teamAutonomy: false,
            boardWrite: true,
          },
        },
      ];

      const notificationsA = [];
      const ctxA = makeMockCtx("ses-tree", branchA, notificationsA);

      // Start on branch A
      pi.emit("session_start", { sessionId: "ses-tree" }, ctxA);
      assert.equal(globalThis[PEER_SLOT].wakeMode, "bounded");

      const wakeCmd = pi.commands.get("pet-peer-wake");
      const autoCmd = pi.commands.get("pet-team-autonomy");
      const boardCmd = pi.commands.get("pet-board-write");

      await wakeCmd.handler("status", ctxA);
      assert.match(notificationsA.at(-1).text, /is on/);
      await autoCmd.handler("status", ctxA);
      assert.match(notificationsA.at(-1).text, /is on/);
      await boardCmd.handler("status", ctxA);
      assert.match(notificationsA.at(-1).text, /is off/);

      // Switch to branch B via session_tree
      const notificationsB = [];
      const ctxB = makeMockCtx("ses-tree", branchB, notificationsB);

      pi.emit("session_tree", { sessionId: "ses-tree" }, ctxB);
      assert.equal(globalThis[PEER_SLOT].wakeMode, "off");

      await wakeCmd.handler("status", ctxB);
      assert.match(notificationsB.at(-1).text, /is off/);
      await autoCmd.handler("status", ctxB);
      assert.match(notificationsB.at(-1).text, /is off/);
      await boardCmd.handler("status", ctxB);
      assert.match(notificationsB.at(-1).text, /is on/);

      // Switch back to branch A via session_tree
      const notificationsA2 = [];
      const ctxA2 = makeMockCtx("ses-tree", branchA, notificationsA2);

      pi.emit("session_tree", { sessionId: "ses-tree" }, ctxA2);
      assert.equal(globalThis[PEER_SLOT].wakeMode, "bounded");

      await wakeCmd.handler("status", ctxA2);
      assert.match(notificationsA2.at(-1).text, /is on/);
      await autoCmd.handler("status", ctxA2);
      assert.match(notificationsA2.at(-1).text, /is on/);
      await boardCmd.handler("status", ctxA2);
      assert.match(notificationsA2.at(-1).text, /is off/);
    });
  });

  describe("Corrupt Latest Entry Fail-Closed", () => {
    test("fails closed on corrupt latest entry without resurrecting older on state", async () => {
      const pi = createMockPi();
      extension(pi, { Type: typeboxStub.Type });

      const branch = [
        {
          type: "custom",
          customType: "pi-pet-permissions",
          data: {
            version: 1,
            peerWake: true,
            teamAutonomy: true,
            boardWrite: true,
          },
        },
        {
          type: "custom",
          customType: "pi-pet-permissions",
          data: {
            corrupted: true,
            // missing version, missing required keys
          },
        },
      ];

      const notifications = [];
      const ctx = makeMockCtx("ses-corrupt", branch, notifications);

      pi.emit("session_start", { sessionId: "ses-corrupt" }, ctx);

      // Must fail closed: all OFF
      assert.equal(globalThis[PEER_SLOT].wakeMode, "off");

      const wakeCmd = pi.commands.get("pet-peer-wake");
      const autoCmd = pi.commands.get("pet-team-autonomy");
      const boardCmd = pi.commands.get("pet-board-write");

      await wakeCmd.handler("status", ctx);
      assert.match(notifications.at(-1).text, /is off/);

      await autoCmd.handler("status", ctx);
      assert.match(notifications.at(-1).text, /is off/);

      await boardCmd.handler("status", ctx);
      assert.match(notifications.at(-1).text, /is off/);
    });

    test("fails closed on corrupt JSON string in latest entry", async () => {
      const pi = createMockPi();
      extension(pi, { Type: typeboxStub.Type });

      const branch = [
        {
          type: "custom",
          customType: "pi-pet-permissions",
          data: { version: 1, peerWake: true, teamAutonomy: true, boardWrite: true },
        },
        {
          type: "custom",
          customType: "pi-pet-permissions",
          data: "{invalid json string",
        },
      ];

      const notifications = [];
      const ctx = makeMockCtx("ses-corrupt-json", branch, notifications);

      pi.emit("session_start", { sessionId: "ses-corrupt-json" }, ctx);

      assert.equal(globalThis[PEER_SLOT].wakeMode, "off");

      const wakeCmd = pi.commands.get("pet-peer-wake");
      await wakeCmd.handler("status", ctx);
      assert.match(notifications.at(-1).text, /is off/);
    });

    test("fails closed when latest entry contains forbidden secret/token fields", async () => {
      const pi = createMockPi();
      extension(pi, { Type: typeboxStub.Type });

      const branch = [
        {
          type: "custom",
          customType: "pi-pet-permissions",
          data: { version: 1, peerWake: true, teamAutonomy: true, boardWrite: true },
        },
        {
          type: "custom",
          customType: "pi-pet-permissions",
          data: {
            version: 1,
            peerWake: true,
            teamAutonomy: true,
            boardWrite: true,
            secretCapabilityToken: VALID_TOKEN, // FORBIDDEN extra field
          },
        },
      ];

      const notifications = [];
      const ctx = makeMockCtx("ses-forbidden-field", branch, notifications);

      pi.emit("session_start", { sessionId: "ses-forbidden-field" }, ctx);

      assert.equal(globalThis[PEER_SLOT].wakeMode, "off");

      const wakeCmd = pi.commands.get("pet-peer-wake");
      await wakeCmd.handler("status", ctx);
      assert.match(notifications.at(-1).text, /is off/);
    });
  });

  describe("Off Tombstone", () => {
    test("explicit off snapshot overrides earlier on snapshot", async () => {
      const pi = createMockPi();
      extension(pi, { Type: typeboxStub.Type });

      const branch = [
        {
          type: "custom",
          customType: "pi-pet-permissions",
          data: {
            version: 1,
            peerWake: true,
            teamAutonomy: true,
            boardWrite: true,
          },
        },
        {
          type: "custom",
          customType: "pi-pet-permissions",
          data: {
            version: 1,
            peerWake: false,
            teamAutonomy: false,
            boardWrite: false,
          },
        },
      ];

      const notifications = [];
      const ctx = makeMockCtx("ses-tombstone", branch, notifications);

      pi.emit("session_start", { sessionId: "ses-tombstone" }, ctx);

      assert.equal(globalThis[PEER_SLOT].wakeMode, "off");

      const wakeCmd = pi.commands.get("pet-peer-wake");
      const autoCmd = pi.commands.get("pet-team-autonomy");
      const boardCmd = pi.commands.get("pet-board-write");

      await wakeCmd.handler("status", ctx);
      assert.match(notifications.at(-1).text, /is off/);
      await autoCmd.handler("status", ctx);
      assert.match(notifications.at(-1).text, /is off/);
      await boardCmd.handler("status", ctx);
      assert.match(notifications.at(-1).text, /is off/);
    });
  });

  describe("Capability Unavailable on Restore", () => {
    test("re-applies peer wake shared slot only when capability is available; otherwise effective off", async () => {
      const pi = createMockPi();
      extension(pi, { Type: typeboxStub.Type });

      // Capability slot is cleared (e.g. desktop pet not running or token expired)
      clearPeerCapabilitySlot();

      const branch = [
        {
          type: "custom",
          customType: "pi-pet-permissions",
          data: {
            version: 1,
            peerWake: true,
            teamAutonomy: true,
            boardWrite: true,
          },
        },
      ];

      const notifications = [];
      const ctx = makeMockCtx("ses-no-cap", branch, notifications);

      pi.emit("session_start", { sessionId: "ses-no-cap" }, ctx);

      // Slot does not exist on globalThis
      assert.equal(globalThis[PEER_SLOT], undefined);

      const wakeCmd = pi.commands.get("pet-peer-wake");
      const autoCmd = pi.commands.get("pet-team-autonomy");
      const boardCmd = pi.commands.get("pet-board-write");

      // Status commands must report effective OFF
      await wakeCmd.handler("status", ctx);
      assert.match(notifications.at(-1).text, /is off/);

      await autoCmd.handler("status", ctx);
      assert.match(notifications.at(-1).text, /is off/);

      await boardCmd.handler("status", ctx);
      assert.match(notifications.at(-1).text, /is off/);

      // Now restore capability and re-trigger session_start (e.g. reconnection)
      setPeerCapabilitySlot(VALID_TOKEN, "off");
      const notifications2 = [];
      const ctx2 = makeMockCtx("ses-no-cap", branch, notifications2);

      pi.emit("session_start", { sessionId: "ses-no-cap" }, ctx2);

      assert.equal(globalThis[PEER_SLOT].wakeMode, "bounded");

      await wakeCmd.handler("status", ctx2);
      assert.match(notifications2.at(-1).text, /is on/);

      await autoCmd.handler("status", ctx2);
      assert.match(notifications2.at(-1).text, /is on/);

      await boardCmd.handler("status", ctx2);
      assert.match(notifications2.at(-1).text, /is on/);
    });
  });

  describe("Session Shutdown", () => {
    test("session shutdown resets in-memory permissions to off without appending any entry", async () => {
      const pi = createMockPi();
      extension(pi, { Type: typeboxStub.Type });

      const notifications = [];
      const ctx = makeMockCtx("ses-shutdown", [], notifications);

      pi.emit("session_start", { sessionId: "ses-shutdown" }, ctx);

      const wakeCmd = pi.commands.get("pet-peer-wake");
      const autoCmd = pi.commands.get("pet-team-autonomy");

      await wakeCmd.handler("on", ctx);
      await autoCmd.handler("on", ctx);
      assert.equal(pi.appendedEntries.length, 2);

      // Trigger session_shutdown
      pi.emit("session_shutdown", { reason: "exit" }, ctx);

      // Shared slot reset to off
      assert.equal(globalThis[PEER_SLOT].wakeMode, "off");

      // No new entry appended on shutdown
      assert.equal(pi.appendedEntries.length, 2);

      // Status after shutdown must be off
      const notificationsAfter = [];
      const ctxAfter = makeMockCtx("ses-shutdown", [], notificationsAfter);
      await wakeCmd.handler("status", ctxAfter);
      assert.match(notificationsAfter.at(-1).text, /is off/);
      await autoCmd.handler("status", ctxAfter);
      assert.match(notificationsAfter.at(-1).text, /is off/);
    });
  });

  describe("Secret and Model-Context Verification", () => {
    test("persisted snapshots never contain IDs, capability tokens, or handles", async () => {
      const pi = createMockPi();
      extension(pi, { Type: typeboxStub.Type });

      const ctx = makeMockCtx("ses-secret-test", []);
      pi.emit("session_start", { sessionId: "ses-secret-test" }, ctx);

      const wakeCmd = pi.commands.get("pet-peer-wake");
      const autoCmd = pi.commands.get("pet-team-autonomy");
      const boardCmd = pi.commands.get("pet-board-write");

      await wakeCmd.handler("on", ctx);
      await autoCmd.handler("on", ctx);
      await boardCmd.handler("on", ctx);

      assert.equal(pi.appendedEntries.length, 3);

      for (const entry of pi.appendedEntries) {
        assert.equal(entry.type, "custom");
        assert.equal(entry.customType, "pi-pet-permissions");

        const dataStr = JSON.stringify(entry.data);
        assert.ok(!dataStr.includes(VALID_TOKEN), "must not leak capability token");
        assert.ok(!dataStr.includes("ses-secret-test"), "must not leak sessionId");
        assert.ok(!dataStr.includes("pet_"), "must not leak petId");
        assert.ok(!dataStr.includes("psh_"), "must not leak session handles");
        assert.ok(!dataStr.includes("pmh_"), "must not leak member handles");

        const keys = Object.keys(entry.data);
        assert.deepEqual(keys.sort(), ["boardWrite", "peerWake", "teamAutonomy", "version"].sort());
      }
    });

    test("permission commands persist only through appendEntry, never message APIs", async () => {
      const pi = createMockPi();
      pi.sendMessage = pi.sendUserMessage = () => assert.fail("must not inject policy into model context");
      extension(pi, { Type: typeboxStub.Type });
      const ctx = makeMockCtx("ses-custom");
      for (const name of ["pet-peer-wake", "pet-team-autonomy", "pet-board-write"]) {
        await pi.commands.get(name).handler("on", ctx);
      }
      assert.equal(pi.appendedEntries.length, 3);
    });
  });
});

describe("Permission persistence acceptance regressions", () => {
  const commands = ["pet-peer-wake", "pet-team-autonomy", "pet-board-write"];
  const on = { version: 1, peerWake: true, teamAutonomy: true, boardWrite: true };
  const entry = (data = on) => ({ type: "custom", customType: extension.PERMISSION_ENTRY_TYPE, data });
  function harness(branch = [], sessionId = "acceptance") {
    const pi = createMockPi();
    extension(pi, { Type: typeboxStub.Type });
    const notes = [];
    const ctx = makeMockCtx(sessionId, branch, notes);
    ctx.sessionManager.getEntries = () => assert.fail("must not scan inactive branches");
    return { pi, ctx, notes };
  }
  async function assertAll(h, mode) {
    for (const cmd of commands) {
      await h.pi.commands.get(cmd).handler("status", h.ctx);
      assert.match(h.notes.at(-1).text, new RegExp(`is ${mode}`));
    }
  }
  beforeEach(() => setPeerCapabilitySlot());
  afterEach(clearPeerCapabilitySlot);

  test("only custom entries with strict object data can enable permissions", async () => {
    for (const malformed of [
      { ...entry(), type: "custom_message" },
      { customType: extension.PERMISSION_ENTRY_TYPE, data: on },
      { type: extension.PERMISSION_ENTRY_TYPE, data: on },
      { type: "custom", customType: extension.PERMISSION_ENTRY_TYPE, payload: on },
      entry(JSON.stringify(on)),
    ]) {
      const h = harness([malformed]);
      h.pi.emit("session_start", {}, h.ctx);
      await assertAll(h, "off");
    }
  });

  test("new extension instances restore saved choices on resume/reload/fork, new stays off", async () => {
    const original = harness();
    for (const cmd of commands) await original.pi.commands.get(cmd).handler("on", original.ctx);
    original.pi.emit("session_shutdown", {}, original.ctx);
    const persisted = JSON.parse(JSON.stringify(original.pi.appendedEntries));
    for (const reason of ["resume", "reload", "fork"]) {
      const h = harness(persisted, reason === "fork" ? "forked-session" : "acceptance");
      h.pi.emit("session_start", { reason }, h.ctx);
      await assertAll(h, "on");
      assert.equal(h.pi.appendedEntries.length, 0);
      h.pi.emit("session_shutdown", {}, h.ctx);
    }
    const fresh = harness();
    fresh.pi.emit("session_start", { reason: "new" }, fresh.ctx);
    await assertAll(fresh, "off");
  });

  test("missing or throwing branch reader clears previous enabled state", async () => {
    for (const getBranch of [undefined, () => { throw new Error("unavailable"); }]) {
      const h = harness([entry()]);
      h.pi.emit("session_start", {}, h.ctx);
      await assertAll(h, "on");
      h.ctx.sessionManager.getBranch = getBranch;
      h.pi.emit("session_tree", {}, h.ctx);
      await assertAll(h, "off");
      assert.equal(globalThis[PEER_SLOT].wakeMode, "off");
    }
  });

  test("failed append during off keeps runtime off and warns previous settings may return", async () => {
    for (const cmd of commands) {
      const h = harness([entry()]);
      h.pi.emit("session_start", {}, h.ctx);
      h.pi.appendEntry = () => { throw new Error("disk full"); };
      await h.pi.commands.get(cmd).handler("off", h.ctx);
      assert.match(h.notes.at(-1).text, /not saved; resume may restore previous settings/);
      assert.equal(h.notes.at(-1).level, "warning");
      await h.pi.commands.get(cmd).handler("status", h.ctx);
      assert.match(h.notes.at(-1).text, /is off/);
    }
  });

  test("missing append API warns without falling back to unofficial context APIs", async () => {
    const h = harness();
    delete h.pi.appendEntry;
    h.ctx.appendEntry = h.ctx.sessionManager.appendCustomEntry = () => assert.fail("unsupported API");
    await h.pi.commands.get(commands[0]).handler("on", h.ctx);
    assert.match(h.notes.at(-1).text, /Current-process only: not saved/);
  });

  test("ephemeral session never claims durable persistence", async () => {
    const h = harness();
    h.ctx.sessionManager.getSessionFile = () => undefined;
    await h.pi.commands.get(commands[0]).handler("on", h.ctx);
    assert.match(h.notes.at(-1).text, /Ephemeral session: no file is saved/);
    assert.equal(h.pi.appendedEntries.length, 1);
  });

  test("off during capability loss preserves other session-bound choices", async () => {
    const h = harness([entry()]);
    h.pi.emit("session_start", {}, h.ctx);
    clearPeerCapabilitySlot();
    await assertAll(h, "off");
    await h.pi.commands.get("pet-board-write").handler("off", h.ctx);
    assert.deepEqual(h.pi.appendedEntries.at(-1).data, { ...on, boardWrite: false });
  });

  test("invalid session identity cannot report another session's enabled state", async () => {
    const h = harness([entry()]);
    h.pi.emit("session_start", {}, h.ctx);
    h.ctx.sessionManager.getSessionId = () => null;
    await assertAll(h, "off");
  });
});
