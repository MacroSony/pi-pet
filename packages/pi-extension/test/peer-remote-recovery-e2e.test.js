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
const { createRemoteInboxConsumer } = require("../../../clawd-on-desk/hooks/pi-extension-core.js");
const {
  writeRuntimeConfig,
  readRuntimePort,
  readRuntimeIdentity,
  getPortCandidates,
  ROUTING_NONCE_HEADER,
  CLAWD_SERVER_HEADER,
} = require("../../../clawd-on-desk/hooks/server-config.js");

const PEER_SLOT = Symbol.for("pi-pet.peer-capability.v1");

function makeRawRequest({ port, path = "/", method = "POST", headers = {}, body = "" }) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        agent: false,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload, "utf8"),
          Connection: "close",
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

test("remote peer delivery recovery across closed ingress, transport reconnection, and replacement consumer", async () => {
  let server = null;
  let nativeHttpServer = null;
  let ingress1 = null;
  let ingress2 = null;
  let consumer1 = null;
  let consumer2 = null;
  let tempDir = null;

  const savedEnv = {
    PI_PET_DATA_DIR: process.env.PI_PET_DATA_DIR,
    PI_PET_PROFILE_ID: process.env.PI_PET_PROFILE_ID,
    PI_PET_CLAWD_RUNTIME_CONFIG: process.env.PI_PET_CLAWD_RUNTIME_CONFIG,
    PI_PET_CLAWD_REMOTE_CONFIG: process.env.PI_PET_CLAWD_REMOTE_CONFIG,
    PI_PET_RUNTIME_MODULE: process.env.PI_PET_RUNTIME_MODULE,
  };

  try {
    // 1. Temp directory and active session status files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-peer-remote-recovery-e2e-"));

    const callerRawSessionId = "pi:caller-local";
    const targetRawSessionId = "pi:target-remote";
    const remoteProfileId = "remote-mac";
    const nonce1 = crypto.randomBytes(16).toString("hex");
    const nonce2 = crypto.randomBytes(16).toString("hex");

    const callerPetId = runtime.derivePetId({ profileId: "local", agentId: "pi", rawSessionId: callerRawSessionId });
    const targetPetId = runtime.derivePetId({ profileId: remoteProfileId, agentId: "pi", rawSessionId: targetRawSessionId });
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
      JSON.stringify({ state: "idle", agentId: "pi", rawSessionId: targetRawSessionId, profileId: remoteProfileId }),
      "utf8"
    );

    const tempRuntimeConfigPath = path.join(tempDir, "runtime.json");
    process.env.PI_PET_DATA_DIR = tempDir;
    process.env.PI_PET_PROFILE_ID = "local";
    process.env.PI_PET_CLAWD_RUNTIME_CONFIG = tempRuntimeConfigPath;
    process.env.PI_PET_CLAWD_REMOTE_CONFIG = path.join(tempDir, "nonexistent-clawd-remote.json");
    process.env.PI_PET_RUNTIME_MODULE = path.resolve(__dirname, "../../runtime/index.js");

    // 2. initServer with real peer + user runtime methods and session snapshot
    const callerSnapshot = {
      id: callerRawSessionId,
      rawSessionId: callerRawSessionId,
      agentId: "pi",
      profileId: "local",
      displayTitle: "Caller Local",
      state: "idle",
      host: "local",
    };
    const targetSnapshot = {
      id: targetRawSessionId,
      rawSessionId: targetRawSessionId,
      agentId: "pi",
      profileId: remoteProfileId,
      displayTitle: "Target Remote",
      state: "idle",
      host: "macbook",
    };

    server = initServer({
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
      writeRuntimeConfig: (port, options) =>
        writeRuntimeConfig(port, { ...options, runtimeConfigPath: tempRuntimeConfigPath, ownerPid: process.pid }),
      isAgentEnabled: () => true,
      STATE_SVGS: { idle: "idle.svg" },
      getSessionSnapshot: () => ({ sessions: [callerSnapshot, targetSnapshot] }),
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

    const boundPort = await server.startHttpServer();
    assert.ok(typeof boundPort === "number" && boundPort >= 23333 && boundPort <= 23337, `Clawd server must bind within range, got: ${boundPort}`);
    assert.ok(fs.existsSync(tempRuntimeConfigPath), "runtime.json must be written by Clawd server");

    // 3. Register caller and target capabilities in server registries
    const callerToken = crypto.randomBytes(32).toString("hex");
    const targetPeerToken = crypto.randomBytes(32).toString("hex");
    const targetUserToken = crypto.randomBytes(32).toString("hex");
    assert.notEqual(callerToken, targetPeerToken);
    assert.notEqual(targetPeerToken, targetUserToken);

    assert.equal(
      server.petPeerCapabilityRegistry.registerCapability({
        profileId: "local",
        agentId: "pi",
        rawSessionId: callerRawSessionId,
        token: callerToken,
      }),
      true
    );
    assert.equal(
      server.petPeerCapabilityRegistry.registerCapability({
        profileId: remoteProfileId,
        agentId: "pi",
        rawSessionId: targetRawSessionId,
        token: targetPeerToken,
      }),
      true
    );
    assert.equal(
      server.petInboxCapabilityRegistry.registerCapability({
        profileId: remoteProfileId,
        agentId: "pi",
        rawSessionId: targetRawSessionId,
        token: targetUserToken,
      }),
      true
    );

    // 4. Register extension tools on fake caller Pi and queue peer send via tools
    const registeredTools = new Map();
    const fakeCallerPi = {
      registerTool(def) {
        if (def && def.name) registeredTools.set(def.name, def);
      },
    };
    extension(fakeCallerPi, { Type: typeboxStub.Type });
    assert.ok(registeredTools.has("pet_list_sessions") && registeredTools.has("pet_send"));

    const callerCtx = { sessionManager: { getSessionId: () => callerRawSessionId } };

    globalThis[PEER_SLOT] = Object.freeze({ version: 1, token: callerToken });
    let listResult;
    try {
      listResult = await registeredTools.get("pet_list_sessions").execute("call_list_001", {}, undefined, undefined, callerCtx);
    } finally {
      delete globalThis[PEER_SLOT];
    }
    assert.equal(listResult.isError, false, "pet_list_sessions must succeed");
    assert.equal(listResult.details.sessions.length, 1, "Catalog must return remote target session");
    const targetEntry = listResult.details.sessions[0];
    assert.ok(typeof targetEntry.handle === "string" && targetEntry.handle.startsWith("psh_"));

    const sendText = "Peer recovery test payload from local to remote!";
    globalThis[PEER_SLOT] = Object.freeze({ version: 1, token: callerToken });
    let sendResult;
    try {
      sendResult = await registeredTools.get("pet_send").execute("call_send_001", { target: targetEntry.handle, text: sendText }, undefined, undefined, callerCtx);
    } finally {
      delete globalThis[PEER_SLOT];
    }
    assert.equal(sendResult.isError, false, "pet_send must succeed without error");
    assert.equal(sendResult.details.status, "queued");
    const messageId = sendResult.details.messageId;
    const threadId = sendResult.details.threadId;
    assert.ok(typeof messageId === "string" && /^msg_[a-z0-9]+$/i.test(messageId));

    // Verify pending file exists in target queue
    const pendingDir = path.join(tempDir, "peer-inbox", targetPetId, "pending");
    assert.ok(fs.existsSync(pendingDir), "Target pending directory must exist");
    assert.equal(fs.readdirSync(pendingDir).length, 1, "Target pending directory must contain 1 file");

    // 5. Setup fake target Pi and real HTTP tracing wrapper
    const targetSentMessages = [];
    const targetSentUserMessages = [];
    const fakeTargetPi = {
      sendMessage(customMessage, options) {
        targetSentMessages.push({ customMessage, options });
      },
      sendUserMessage(text, options) {
        targetSentUserMessages.push({ text, options });
      },
    };

    const httpPathTrace = [];
    const tracingHttpRequest = (options, cb) => {
      httpPathTrace.push({
        method: options.method,
        path: options.path,
        port: options.port,
        headers: options.headers ? { ...options.headers } : {},
      });
      return http.request(options, cb);
    };

    // 6. Start ingress1 and consumer1
    ingress1 = server.openRemoteSshIngress({
      remoteProfile: { profileId: remoteProfileId, host: "macbook" },
      getAcceptedNonces: () => [nonce1],
    });
    const ingressPort1 = await ingress1.start();
    assert.ok(typeof ingressPort1 === "number" && ingressPort1 > 0, `Ingress1 must bind ephemeral port, got: ${ingressPort1}`);
    assert.equal(ingress1.getStatus().listening, true, "Ingress1 must report listening");

    const scheduledTicks1 = [];
    consumer1 = createRemoteInboxConsumer({
      pi: fakeTargetPi,
      identity: { ok: true, remotePort: ingressPort1, routingNonce: nonce1 },
      rawSessionId: targetRawSessionId,
      capabilityToken: targetUserToken,
      peerCapabilityToken: targetPeerToken,
      httpRequest: tracingHttpRequest,
      setTimeout: (fn, ms) => {
        const item = { fn, ms };
        scheduledTicks1.push(item);
        return item;
      },
      clearTimeout: (item) => {
        const idx = scheduledTicks1.indexOf(item);
        if (idx !== -1) scheduledTicks1.splice(idx, 1);
      },
      pollIntervalMs: 1000,
    });
    assert.equal(scheduledTicks1.length, 1, "Consumer1 must schedule initial tick");

    // 7. Close ingress1 before its first tick and wait until the TCP listener is actually gone.
    const ingress1Closed = ingress1.server.listening
      ? new Promise((resolve) => ingress1.server.once("close", resolve))
      : Promise.resolve();
    ingress1.close();
    await ingress1Closed;
    assert.equal(ingress1.getStatus().listening, false, "Ingress1 must report closed/not listening");

    // 8. Run tick on consumer1 and prove failure handling
    httpPathTrace.length = 0;
    await scheduledTicks1.shift().fn();

    // Prove no sendUserMessage / sendMessage were called
    assert.equal(targetSentUserMessages.length, 0, "No user messages must be sent when ingress is closed");
    assert.equal(targetSentMessages.length, 0, "No peer messages must be sent when ingress is closed");

    // Prove no /pet-peer fallthrough occurred in outgoing paths
    assert.deepEqual(
      httpPathTrace.map((r) => r.path),
      ["/pet-inbox/claim"],
      "Failed user claim attempt must not fall through to pet-peer paths"
    );
    assert.equal(
      httpPathTrace.some((r) => r.path.startsWith("/pet-peer")),
      false,
      "No /pet-peer request must be attempted when user inbox claim fails"
    );

    // Prove peer remains pending / no terminal receipt
    assert.equal(fs.readdirSync(pendingDir).length, 1, "Pending peer message must remain in queue");
    const receiptBeforeRecovery = runtime.getPeerMessageReceipt({
      sourcePetId: callerPetId,
      targetPetId,
      messageId,
      dataDir: tempDir,
    });
    assert.ok(receiptBeforeRecovery, "Receipt must exist");
    assert.equal(receiptBeforeRecovery.status, "queued", "Receipt must remain queued before recovery");

    // Prove no event bubble exists
    const eventFilePath = path.join(tempDir, "events", `event-${targetPetId}.json`);
    assert.equal(fs.existsSync(eventFilePath), false, "No event bubble file must exist before dispatch");

    // Stop consumer1
    consumer1.stop();

    // 9. Start ingress2 with same trusted remote profile and a fresh accepted nonce
    ingress2 = server.openRemoteSshIngress({
      remoteProfile: { profileId: remoteProfileId, host: "macbook" },
      getAcceptedNonces: () => [nonce2],
    });
    const ingressPort2 = await ingress2.start();
    assert.ok(typeof ingressPort2 === "number" && ingressPort2 > 0, `Ingress2 must bind ephemeral port, got: ${ingressPort2}`);
    assert.equal(ingress2.getStatus().listening, true, "Ingress2 must report listening");

    // Assert bad old nonce is rejected on ingress2
    const badOldNonceRes = await makeRawRequest({
      port: ingressPort2,
      path: "/pet-inbox/claim",
      headers: { [ROUTING_NONCE_HEADER]: nonce1 },
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "user_message_claim",
        rawSessionId: targetRawSessionId,
        capabilityToken: targetUserToken,
      }),
    });
    assert.equal(badOldNonceRes.statusCode, 404, "Old nonce against ingress2 must be rejected with HTTP 404");
    assert.equal(badOldNonceRes.headers[CLAWD_SERVER_HEADER], undefined, "Rejected old nonce must not expose Clawd header");
    assert.equal(badOldNonceRes.headers[CLAWD_SERVER_HEADER.toLowerCase()], undefined);
    assert.equal(ingress2.getStatus().rejectedCount, 1, "Ingress2 must record rejected count of 1");

    // 10. Create replacement consumer2 with updated identity (realistic tunnel refresh/reload)
    const scheduledTicks2 = [];
    consumer2 = createRemoteInboxConsumer({
      pi: fakeTargetPi,
      identity: { ok: true, remotePort: ingressPort2, routingNonce: nonce2 },
      rawSessionId: targetRawSessionId,
      capabilityToken: targetUserToken,
      peerCapabilityToken: targetPeerToken,
      httpRequest: tracingHttpRequest,
      setTimeout: (fn, ms) => {
        const item = { fn, ms };
        scheduledTicks2.push(item);
        return item;
      },
      clearTimeout: (item) => {
        const idx = scheduledTicks2.indexOf(item);
        if (idx !== -1) scheduledTicks2.splice(idx, 1);
      },
      pollIntervalMs: 1000,
    });
    assert.equal(scheduledTicks2.length, 1, "Consumer2 must schedule initial tick");

    // 11. Run Tick 1 on consumer2: observe empty user claim, claim peer note, dispatch, and settle
    httpPathTrace.length = 0;
    await scheduledTicks2.shift().fn();

    assert.deepEqual(
      httpPathTrace.map((r) => r.path),
      ["/pet-inbox/claim", "/pet-peer/claim", "/pet-peer/settle"],
      "Tick 1 must observe empty user inbox then claim and settle peer message"
    );
    assert.equal(targetSentUserMessages.length, 0, "No user messages sent");
    assert.equal(targetSentMessages.length, 1, "Target Pi must receive exactly one peer message");

    const dispatched = targetSentMessages[0];
    assert.deepEqual(dispatched.options, { deliverAs: "followUp", triggerTurn: false }, "Must dispatch with deliverAs: followUp and triggerTurn: false");
    assert.equal(dispatched.customMessage.customType, "pi-pet-peer-message");
    assert.equal(dispatched.customMessage.display, true);
    assert.ok(dispatched.customMessage.content.includes(sendText), "Dispatched message content must contain the original sendText");
    assert.ok(dispatched.customMessage.content.includes("Caller Local · Pi @ local"));
    assert.deepEqual(dispatched.customMessage.details, {
      schemaVersion: "1",
      messageId,
      sourceDisplayName: "Caller Local · Pi",
      sourceHost: "local",
      threadId,
      hopCount: 0,
      maxHops: 1,
      replyHandle: dispatched.customMessage.details.replyHandle,
    });
    assert.ok(
      typeof dispatched.customMessage.details.replyHandle === "string" && dispatched.customMessage.details.replyHandle.startsWith("psh_"),
      "replyHandle must be a valid psh_ handle"
    );

    // Assert real peer receipt dispatched, pending and claimed queues empty
    const receiptAfterRecovery = runtime.getPeerMessageReceipt({
      sourcePetId: callerPetId,
      targetPetId,
      messageId,
      dataDir: tempDir,
    });
    assert.ok(receiptAfterRecovery, "Peer message receipt must be found after recovery");
    assert.equal(receiptAfterRecovery.schemaVersion, "1");
    assert.equal(receiptAfterRecovery.kind, "peer_message");
    assert.equal(receiptAfterRecovery.status, "dispatched");
    assert.equal(receiptAfterRecovery.messageId, messageId);
    assert.equal(receiptAfterRecovery.targetPetId, targetPetId);
    assert.equal(receiptAfterRecovery.sourcePetId, callerPetId);

    assert.equal(fs.readdirSync(pendingDir).length, 0, "Pending directory must be empty after dispatch");
    const claimedDir = path.join(tempDir, "peer-inbox", targetPetId, "claimed");
    if (fs.existsSync(claimedDir)) {
      assert.equal(fs.readdirSync(claimedDir).length, 0, "Claimed directory must be empty after dispatch");
    }

    // Assert source bubble (expression event file)
    assert.ok(fs.existsSync(eventFilePath), `Target event file ${eventFilePath} must exist`);
    const eventData = JSON.parse(fs.readFileSync(eventFilePath, "utf8"));
    assert.equal(eventData.schemaVersion, "1");
    assert.equal(eventData.kind, "expression");
    assert.equal(eventData.petId, targetPetId);
    assert.equal(eventData.payload.text, "Message from Caller Local · Pi @ local");
    assert.equal(eventData.payload.speak, false);
    assert.equal(eventData.payload.priority, 3);
    assert.equal(eventData.payload.durationMs, 2500);

    const eventDataSerialized = JSON.stringify(eventData);
    for (const secret of [sendText, messageId, threadId, callerToken, targetPeerToken, targetUserToken, callerPetId, callerRawSessionId, remoteProfileId]) {
      assert.equal(eventDataSerialized.includes(secret), false, `Event file must not contain ${secret}`);
    }

    // 12. Run Tick 2 on consumer2: prove no duplicate dispatch
    assert.equal(scheduledTicks2.length, 1, "Consumer2 must schedule next tick");
    httpPathTrace.length = 0;
    await scheduledTicks2.shift().fn();

    assert.deepEqual(
      httpPathTrace.map((r) => r.path),
      ["/pet-inbox/claim", "/pet-peer/claim"],
      "Tick 2 must observe empty user claim followed by empty peer claim"
    );
    assert.equal(targetSentMessages.length, 1, "Must not dispatch duplicate peer message on subsequent tick");
    assert.equal(targetSentUserMessages.length, 0, "Must not dispatch any user message on subsequent tick");
  } finally {
    // 13. Robust cleanup
    delete globalThis[PEER_SLOT];

    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }

    if (consumer1) {
      try { consumer1.stop(); } catch {}
    }
    if (consumer2) {
      try { consumer2.stop(); } catch {}
    }

    if (ingress1) {
      try { ingress1.close(); } catch {}
    }
    if (ingress2) {
      try { ingress2.close(); } catch {}
    }

    if (nativeHttpServer) {
      try {
        if (typeof nativeHttpServer.closeAllConnections === "function") {
          nativeHttpServer.closeAllConnections();
        }
      } catch {}
      await new Promise((resolve) => {
        try {
          nativeHttpServer.close(() => {
            resolve();
          });
        } catch {
          resolve();
        }
      });
    }

    if (server) {
      try { server.cleanup(); } catch {}
    }

    await new Promise((resolve) => setTimeout(resolve, 50));

    if (tempDir && tempDir.startsWith(os.tmpdir())) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  }
});
