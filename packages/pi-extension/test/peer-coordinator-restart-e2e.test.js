"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

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
const runtime = require("../../runtime/index.js");
const initServer = require("../../../clawd-on-desk/src/server.js");
const { attach, postStateToClawd } = require("../../../clawd-on-desk/hooks/pi-extension-core.js");
const {
  writeRuntimeConfig,
  readRuntimePort,
  readRuntimeIdentity,
  getPortCandidates,
} = require("../../../clawd-on-desk/hooks/server-config.js");

const PEER_SLOT = Symbol.for("pi-pet.peer-capability.v1");

function createFakePi() {
  const handlers = new Map();
  const registeredTools = new Map();
  const sentCustomMessages = [];
  const sentUserMessages = [];

  return {
    handlers,
    registeredTools,
    sentCustomMessages,
    sentUserMessages,
    on(event, handler) {
      if (!handlers.has(event)) {
        handlers.set(event, []);
      }
      handlers.get(event).push(handler);
    },
    emit(event, nativeEvent, ctx) {
      const list = handlers.get(event) || [];
      const results = [];
      for (const fn of list) {
        results.push(fn(nativeEvent, ctx));
      }
      return results;
    },
    registerTool(def) {
      if (def && def.name) {
        registeredTools.set(def.name, def);
      }
    },
    sendMessage(message, options) {
      sentCustomMessages.push({ message, options });
    },
    sendUserMessage(text, options) {
      sentUserMessages.push({ text, options });
    },
  };
}

async function waitForRegistration(registry, profileId, rawSessionId, token, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (registry && typeof registry.verifyCapability === "function") {
      if (registry.verifyCapability({ profileId, agentId: "pi", rawSessionId, token })) {
        return true;
      }
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timeout waiting for registration of ${rawSessionId} with token ${token.slice(0, 8)}...`);
}

function createClawdServer(tempRuntimeConfigPath, getSessionSnapshot) {
  let nativeHttpServer = null;

  const server = initServer({
    createHttpServer: (handler) => {
      nativeHttpServer = http.createServer(handler);
      return nativeHttpServer;
    },
    setImmediate: () => {},
    runtimeConfigPath: tempRuntimeConfigPath,
    getPortCandidates: () => getPortCandidates(),
    readRuntimePort: () => readRuntimePort({ runtimeConfigPath: tempRuntimeConfigPath }),
    readRuntimeIdentity: () => readRuntimeIdentity({ runtimeConfigPath: tempRuntimeConfigPath }),
    clearRuntimeConfig: () => {
      try { fs.unlinkSync(tempRuntimeConfigPath); } catch {}
      return true;
    },
    writeRuntimeConfig: (port, options) => {
      return writeRuntimeConfig(port, {
        ...options,
        runtimeConfigPath: tempRuntimeConfigPath,
        ownerPid: process.pid,
      });
    },
    isAgentEnabled: () => true,
    STATE_SVGS: { idle: "idle.svg" },
    getSessionSnapshot,
    derivePetId: runtime.derivePetId,
    enqueuePeerMessage: runtime.enqueuePeerMessage,
    claimNextPeerMessage: runtime.claimNextPeerMessage,
    settlePeerMessage: runtime.settlePeerMessage,
    getPeerMessageReceipt: runtime.getPeerMessageReceipt,
    claimNextUserMessage: runtime.claimNextUserMessage,
    settleUserMessage: runtime.settleUserMessage,
    getUserMessageReceipt: runtime.getUserMessageReceipt,
    enqueueUserMessage: runtime.enqueueUserMessage,
  });

  return {
    server,
    getNativeServer: () => nativeHttpServer,
  };
}

async function closeClawdServer(serverInstance, getNativeServer) {
  const nativeHttpServer = getNativeServer ? getNativeServer() : null;
  if (nativeHttpServer) {
    if (typeof nativeHttpServer.closeIdleConnections === "function") {
      nativeHttpServer.closeIdleConnections();
    }
    if (typeof nativeHttpServer.closeAllConnections === "function") {
      nativeHttpServer.closeAllConnections();
    }
  }
  let closePromise = Promise.resolve();
  if (nativeHttpServer && nativeHttpServer.listening) {
    closePromise = new Promise((resolve) => {
      nativeHttpServer.once("close", resolve);
    });
  }
  if (serverInstance) {
    serverInstance.cleanup();
  }
  await closePromise;
}

test("peer coordinator restart recovery: retained tokens re-registered via heartbeat and replacement attach rotates token", async () => {
  let server1Handle = null;
  let server2Handle = null;
  let callerAttach1 = null;
  let targetAttach = null;
  let callerAttach2 = null;
  let tempDir = null;

  const savedEnv = {
    PI_PET_DATA_DIR: process.env.PI_PET_DATA_DIR,
    PI_PET_PROFILE_ID: process.env.PI_PET_PROFILE_ID,
    PI_PET_CLAWD_RUNTIME_CONFIG: process.env.PI_PET_CLAWD_RUNTIME_CONFIG,
    PI_PET_CLAWD_REMOTE_CONFIG: process.env.PI_PET_CLAWD_REMOTE_CONFIG,
    PI_PET_RUNTIME_MODULE: process.env.PI_PET_RUNTIME_MODULE,
  };

  try {
    // 1. Setup temp environment and session status files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-peer-restart-e2e-"));

    const callerRawSessionId = "pi:caller-restart-e2e";
    const targetRawSessionId = "pi:target-restart-e2e";

    const callerPetId = runtime.derivePetId({ profileId: "local", agentId: "pi", rawSessionId: callerRawSessionId });
    const targetPetId = runtime.derivePetId({ profileId: "local", agentId: "pi", rawSessionId: targetRawSessionId });
    assert.notEqual(callerPetId, targetPetId, "Caller and target pet IDs must be distinct");

    const statusDir = path.join(tempDir, "status");
    fs.mkdirSync(statusDir, { recursive: true });

    fs.writeFileSync(
      path.join(statusDir, `status-${callerPetId}.json`),
      JSON.stringify({ state: "idle", agentId: "pi", rawSessionId: callerRawSessionId, profileId: "local" }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(statusDir, `status-${targetPetId}.json`),
      JSON.stringify({ state: "idle", agentId: "pi", rawSessionId: targetRawSessionId, profileId: "local" }),
      "utf8"
    );

    const tempRuntimeConfigPath = path.join(tempDir, "runtime.json");

    process.env.PI_PET_DATA_DIR = tempDir;
    process.env.PI_PET_PROFILE_ID = "local";
    process.env.PI_PET_CLAWD_RUNTIME_CONFIG = tempRuntimeConfigPath;
    process.env.PI_PET_CLAWD_REMOTE_CONFIG = path.join(tempDir, "nonexistent-clawd-remote.json");
    process.env.PI_PET_RUNTIME_MODULE = path.resolve(__dirname, "../../runtime/index.js");

    const callerSnapshot = {
      id: callerRawSessionId,
      rawSessionId: callerRawSessionId,
      agentId: "pi",
      profileId: "local",
      displayTitle: "Caller Restart E2E",
      state: "idle",
      host: "local",
    };

    const targetSnapshot = {
      id: targetRawSessionId,
      rawSessionId: targetRawSessionId,
      agentId: "pi",
      profileId: "local",
      displayTitle: "Target Restart E2E",
      state: "idle",
      host: "local",
    };

    const snapshotGetter = () => ({ sessions: [callerSnapshot, targetSnapshot] });

    // 2. Start server1 on real Node HTTP using Clawd initServer
    server1Handle = createClawdServer(tempRuntimeConfigPath, snapshotGetter);
    const boundPort1 = await server1Handle.server.startHttpServer();
    assert.ok(
      typeof boundPort1 === "number" && boundPort1 >= 23333 && boundPort1 <= 23337,
      `Server1 must bind within port range 23333..23337, got: ${boundPort1}`
    );
    assert.ok(fs.existsSync(tempRuntimeConfigPath), "runtime.json must be written by Server1");

    // 3. Create fake Pi instances and attach capability producers using production core.attach & postStateToClawd
    const postStateProductionTransport = (payload) => {
      const currentPort = readRuntimePort({ runtimeConfigPath: tempRuntimeConfigPath });
      return postStateToClawd(payload, {
        runtimeConfigPath: tempRuntimeConfigPath,
        runtimePort: currentPort,
        httpRequest: http.request,
      });
    };

    const fakeCallerPi = createFakePi();
    let callerHeartbeatCallback1 = null;
    callerAttach1 = attach(fakeCallerPi, {
      postState: postStateProductionTransport,
      setInterval: (cb) => {
        callerHeartbeatCallback1 = cb;
        return { unref: () => {} };
      },
      clearInterval: () => {
        callerHeartbeatCallback1 = null;
      },
    });

    const callerToken1 = globalThis[PEER_SLOT]?.token;
    assert.ok(typeof callerToken1 === "string" && /^[0-9a-f]{64}$/.test(callerToken1), "Caller token 1 must be valid 64-hex");

    const fakeTargetPi = createFakePi();
    let targetHeartbeatCallback = null;
    targetAttach = attach(fakeTargetPi, {
      postState: postStateProductionTransport,
      setInterval: (cb) => {
        targetHeartbeatCallback = cb;
        return { unref: () => {} };
      },
      clearInterval: () => {
        targetHeartbeatCallback = null;
      },
    });

    const targetToken1 = globalThis[PEER_SLOT]?.token;
    assert.ok(typeof targetToken1 === "string" && /^[0-9a-f]{64}$/.test(targetToken1), "Target token 1 must be valid 64-hex");
    assert.notEqual(callerToken1, targetToken1, "Caller and target tokens must be distinct");

    // Register root extension tools on caller Pi
    extension(fakeCallerPi, { Type: typeboxStub.Type });
    assert.ok(fakeCallerPi.registeredTools.has("pet_list_sessions"), "pet_list_sessions must be registered");
    assert.ok(fakeCallerPi.registeredTools.has("pet_send"), "pet_send must be registered");

    const callerCtx = {
      sessionManager: { getSessionId: () => "caller-restart-e2e" },
      hasUI: true,
    };
    const targetCtx = {
      sessionManager: { getSessionId: () => "target-restart-e2e" },
      hasUI: true,
    };

    // 4. Emit session_start so /state reaches server1 and registers peer tokens
    fakeCallerPi.emit("session_start", { type: "session_start" }, callerCtx);
    fakeTargetPi.emit("session_start", { type: "session_start" }, targetCtx);

    await waitForRegistration(server1Handle.server.petPeerCapabilityRegistry, "local", callerRawSessionId, callerToken1);
    await waitForRegistration(server1Handle.server.petPeerCapabilityRegistry, "local", targetRawSessionId, targetToken1);

    assert.equal(
      server1Handle.server.petPeerCapabilityRegistry.verifyCapability({
        profileId: "local",
        agentId: "pi",
        rawSessionId: callerRawSessionId,
        token: callerToken1,
      }),
      true,
      "Caller token 1 must be registered in server1"
    );
    assert.equal(
      server1Handle.server.petPeerCapabilityRegistry.verifyCapability({
        profileId: "local",
        agentId: "pi",
        rawSessionId: targetRawSessionId,
        token: targetToken1,
      }),
      true,
      "Target token 1 must be registered in server1"
    );

    // 5. Prove tools can catalog target and send message on server1
    globalThis[PEER_SLOT] = Object.freeze({ version: 1, token: callerToken1 });
    let listResult1;
    try {
      listResult1 = await fakeCallerPi.registeredTools.get("pet_list_sessions").execute(
        "call_list_s1",
        {},
        undefined,
        undefined,
        callerCtx
      );
    } finally {
      delete globalThis[PEER_SLOT];
    }

    assert.equal(listResult1.isError, false, "pet_list_sessions on server1 must succeed");
    assert.equal(listResult1.details.kind, "peer_catalog");
    assert.equal(listResult1.details.sessions.length, 1, "Catalog must return target session");
    const targetHandle1 = listResult1.details.sessions[0].handle;
    assert.ok(typeof targetHandle1 === "string" && targetHandle1.startsWith("psh_"));

    globalThis[PEER_SLOT] = Object.freeze({ version: 1, token: callerToken1 });
    let sendResult1;
    try {
      sendResult1 = await fakeCallerPi.registeredTools.get("pet_send").execute(
        "call_send_s1",
        { target: targetHandle1, text: "Message to server1 target" },
        undefined,
        undefined,
        callerCtx
      );
    } finally {
      delete globalThis[PEER_SLOT];
    }

    assert.equal(sendResult1.isError, false, "pet_send on server1 must succeed");
    assert.equal(sendResult1.details.status, "queued");

    // 6. Cleanup and fully close server1
    await closeClawdServer(server1Handle.server, server1Handle.getNativeServer);
    assert.equal(server1Handle.getNativeServer().listening, false, "Server1 native HTTP must be closed");
    assert.equal(server1Handle.server.petPeerCapabilityRegistry.size, 0, "Server1 registry must be cleared on cleanup");

    // 7. Start fresh server2 with new registries writing same runtime config
    server2Handle = createClawdServer(tempRuntimeConfigPath, snapshotGetter);
    const boundPort2 = await server2Handle.server.startHttpServer();
    assert.ok(
      typeof boundPort2 === "number" && boundPort2 >= 23333 && boundPort2 <= 23337,
      `Server2 must bind within port range 23333..23337, got: ${boundPort2}`
    );
    assert.ok(fs.existsSync(tempRuntimeConfigPath), "runtime.json must be rewritten by Server2");
    assert.notEqual(
      server1Handle.server.petPeerCapabilityRegistry,
      server2Handle.server.petPeerCapabilityRegistry,
      "Server1 and Server2 must have distinct capability registries"
    );

    // Prove server2 initially has no capabilities registered
    assert.equal(server2Handle.server.petPeerCapabilityRegistry.size, 0, "Server2 registry must start empty");
    assert.equal(
      server2Handle.server.petPeerCapabilityRegistry.verifyCapability({
        profileId: "local",
        agentId: "pi",
        rawSessionId: callerRawSessionId,
        token: callerToken1,
      }),
      false,
      "Caller must not be registered on server2 before hook/heartbeat"
    );

    // Prove tool call fails before re-registration on server2
    globalThis[PEER_SLOT] = Object.freeze({ version: 1, token: callerToken1 });
    let prematureListResult;
    try {
      prematureListResult = await fakeCallerPi.registeredTools.get("pet_list_sessions").execute(
        "call_list_premature",
        {},
        undefined,
        undefined,
        callerCtx
      );
    } finally {
      delete globalThis[PEER_SLOT];
    }
    assert.equal(prematureListResult.isError, true, "Tool call must fail before re-registration on server2");
    assert.equal(prematureListResult.details.status, "rejected");

    // 8. Trigger heartbeat from existing attaches: retained tokens rediscover server2 from runtime.json
    assert.ok(typeof callerHeartbeatCallback1 === "function", "Caller heartbeat hook must be active");
    assert.ok(typeof targetHeartbeatCallback === "function", "Target heartbeat hook must be active");

    callerHeartbeatCallback1();
    targetHeartbeatCallback();

    await waitForRegistration(server2Handle.server.petPeerCapabilityRegistry, "local", callerRawSessionId, callerToken1);
    await waitForRegistration(server2Handle.server.petPeerCapabilityRegistry, "local", targetRawSessionId, targetToken1);

    assert.equal(
      server2Handle.server.petPeerCapabilityRegistry.verifyCapability({
        profileId: "local",
        agentId: "pi",
        rawSessionId: callerRawSessionId,
        token: callerToken1,
      }),
      true,
      "Caller token 1 must be successfully re-registered in server2"
    );
    assert.equal(
      server2Handle.server.petPeerCapabilityRegistry.verifyCapability({
        profileId: "local",
        agentId: "pi",
        rawSessionId: targetRawSessionId,
        token: targetToken1,
      }),
      true,
      "Target token 1 must be successfully re-registered in server2"
    );

    // 9. Prove post-restart pet_list_sessions and pet_send work on server2
    globalThis[PEER_SLOT] = Object.freeze({ version: 1, token: callerToken1 });
    let listResult2;
    try {
      listResult2 = await fakeCallerPi.registeredTools.get("pet_list_sessions").execute(
        "call_list_s2",
        {},
        undefined,
        undefined,
        callerCtx
      );
    } finally {
      delete globalThis[PEER_SLOT];
    }

    assert.equal(listResult2.isError, false, "pet_list_sessions on server2 must succeed after heartbeat recovery");
    assert.equal(listResult2.details.sessions.length, 1);
    const targetHandle2 = listResult2.details.sessions[0].handle;
    assert.ok(typeof targetHandle2 === "string" && targetHandle2.startsWith("psh_"));
    assert.notEqual(targetHandle2, targetHandle1, "Server2 must issue fresh session handles");

    globalThis[PEER_SLOT] = Object.freeze({ version: 1, token: callerToken1 });
    let sendResult2;
    try {
      sendResult2 = await fakeCallerPi.registeredTools.get("pet_send").execute(
        "call_send_s2",
        { target: targetHandle2, text: "Message to server2 target after recovery" },
        undefined,
        undefined,
        callerCtx
      );
    } finally {
      delete globalThis[PEER_SLOT];
    }

    assert.equal(sendResult2.isError, false, "pet_send on server2 must succeed after recovery");
    assert.equal(sendResult2.details.status, "queued");

    // 10. Simulate replacement attach for caller with fresh token and report state to server2
    const fakeCallerPiReplacement = createFakePi();
    callerAttach2 = attach(fakeCallerPiReplacement, {
      postState: postStateProductionTransport,
      setInterval: () => ({ unref: () => {} }),
      clearInterval: () => {},
    });

    const callerToken2 = globalThis[PEER_SLOT]?.token;
    assert.ok(typeof callerToken2 === "string" && /^[0-9a-f]{64}$/.test(callerToken2), "Fresh caller token must be 64-hex");
    assert.notEqual(callerToken2, callerToken1, "Fresh attach must generate a distinct token from token 1");

    extension(fakeCallerPiReplacement, { Type: typeboxStub.Type });

    fakeCallerPiReplacement.emit("session_start", { type: "session_start" }, callerCtx);
    await waitForRegistration(server2Handle.server.petPeerCapabilityRegistry, "local", callerRawSessionId, callerToken2);

    // 11. Prove old token is retired/rejected and new tool call succeeds
    assert.equal(
      server2Handle.server.petPeerCapabilityRegistry.verifyCapability({
        profileId: "local",
        agentId: "pi",
        rawSessionId: callerRawSessionId,
        token: callerToken1,
      }),
      false,
      "Old caller token 1 must no longer be valid in server2"
    );
    assert.equal(
      server2Handle.server.petPeerCapabilityRegistry.verifyCapability({
        profileId: "local",
        agentId: "pi",
        rawSessionId: callerRawSessionId,
        token: callerToken2,
      }),
      true,
      "New caller token 2 must be the active capability in server2"
    );

    // Attempting pet_list_sessions with retired token 1 must fail
    globalThis[PEER_SLOT] = Object.freeze({ version: 1, token: callerToken1 });
    let retiredTokenResult;
    try {
      retiredTokenResult = await fakeCallerPi.registeredTools.get("pet_list_sessions").execute(
        "call_list_retired",
        {},
        undefined,
        undefined,
        callerCtx
      );
    } finally {
      delete globalThis[PEER_SLOT];
    }
    assert.equal(retiredTokenResult.isError, true, "Tool call with retired token 1 must fail");
    assert.equal(retiredTokenResult.details.status, "rejected");

    // Attempting pet_list_sessions and pet_send with active token 2 must succeed
    globalThis[PEER_SLOT] = Object.freeze({ version: 1, token: callerToken2 });
    let newTokenListResult;
    try {
      newTokenListResult = await fakeCallerPiReplacement.registeredTools.get("pet_list_sessions").execute(
        "call_list_new_token",
        {},
        undefined,
        undefined,
        callerCtx
      );
    } finally {
      delete globalThis[PEER_SLOT];
    }

    assert.equal(newTokenListResult.isError, false, "pet_list_sessions with new token 2 must succeed");
    assert.equal(newTokenListResult.details.sessions.length, 1);
    const targetHandle3 = newTokenListResult.details.sessions[0].handle;
    assert.ok(typeof targetHandle3 === "string" && targetHandle3.startsWith("psh_"));

    globalThis[PEER_SLOT] = Object.freeze({ version: 1, token: callerToken2 });
    let newTokenSendResult;
    try {
      newTokenSendResult = await fakeCallerPiReplacement.registeredTools.get("pet_send").execute(
        "call_send_new_token",
        { target: targetHandle3, text: "Message with new token 2" },
        undefined,
        undefined,
        callerCtx
      );
    } finally {
      delete globalThis[PEER_SLOT];
    }

    assert.equal(newTokenSendResult.isError, false, "pet_send with new token 2 must succeed");
    assert.equal(newTokenSendResult.details.status, "queued");

    // Check no token leaks in tool results
    const listResultSerialized = JSON.stringify(newTokenListResult);
    assert.equal(listResultSerialized.includes(callerToken1), false, "Must not leak callerToken1");
    assert.equal(listResultSerialized.includes(callerToken2), false, "Must not leak callerToken2");
    assert.equal(listResultSerialized.includes(targetToken1), false, "Must not leak targetToken1");
  } finally {
    delete globalThis[PEER_SLOT];

    if (callerAttach1 && typeof callerAttach1.stopHeartbeat === "function") {
      callerAttach1.stopHeartbeat();
    }
    if (targetAttach && typeof targetAttach.stopHeartbeat === "function") {
      targetAttach.stopHeartbeat();
    }
    if (callerAttach2 && typeof callerAttach2.stopHeartbeat === "function") {
      callerAttach2.stopHeartbeat();
    }

    await closeClawdServer(
      server1Handle ? server1Handle.server : null,
      server1Handle ? server1Handle.getNativeServer : null
    );
    await closeClawdServer(
      server2Handle ? server2Handle.server : null,
      server2Handle ? server2Handle.getNativeServer : null
    );

    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }

    for (const [key, val] of Object.entries(savedEnv)) {
      if (val !== undefined) {
        process.env[key] = val;
      } else {
        delete process.env[key];
      }
    }
  }
});
