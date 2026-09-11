"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
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
const { createInboxConsumer } = extension;

const rootRuntimePath = path.resolve(__dirname, "../../runtime/index.js");
const { derivePetId } = require(path.resolve(__dirname, "../../runtime/identity.js"));
const { handlePetInboxPost } = require(path.resolve(__dirname, "../../../clawd-on-desk/src/server-route-pet-inbox.js"));
const { CLAWD_SERVER_HEADER, CLAWD_SERVER_ID } = require(path.resolve(__dirname, "../../../clawd-on-desk/hooks/server-config.js"));

function createMockPi() {
  const sentUserMessages = [];
  return {
    sentUserMessages,
    sendUserMessage(text, options) {
      sentUserMessages.push({ text, options });
    },
  };
}

function createMockReq({ method = "POST", url = "/pet-inbox", headers = {}, body = "" } = {}) {
  const payloadBuffer = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  const stream = Readable.from([payloadBuffer]);
  stream.method = method;
  stream.url = url;
  stream.headers = { ...headers };
  return stream;
}

function createMockRes() {
  const result = {
    statusCode: null,
    headers: {},
    body: "",
  };
  const res = {
    writeHead(statusCode, headers = {}) {
      result.statusCode = statusCode;
      result.headers = headers;
    },
    end(chunk = "") {
      result.body += typeof chunk === "string" ? chunk : (chunk ? chunk.toString("utf8") : "");
      if (res._resolve) res._resolve(result);
    },
  };
  result.done = new Promise((resolve) => {
    res._resolve = resolve;
  });
  return { res, result };
}

test("end-to-end local own-session inbox flow with route, root runtime, Pi consumer, session isolation, and dedup resend", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-inbox-e2e-suite-"));

  try {
    const rawSessionA = "session-e2e-pi-a";
    const rawSessionB = "session-e2e-pi-b";
    const canonicalSessionA = "pi:session-e2e-pi-a";
    const canonicalSessionB = "pi:session-e2e-pi-b";

    const petIdA = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: canonicalSessionA });
    const petIdB = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: canonicalSessionB });

    assert.notEqual(petIdA, petIdB, "Pet A and Pet B IDs must be distinct");

    const statusDir = path.join(tempDir, "status");
    fs.mkdirSync(statusDir, { recursive: true });

    // Active session status files for both sessions
    fs.writeFileSync(
      path.join(statusDir, `status-${petIdA}.json`),
      JSON.stringify({ state: "idle", agentId: "pi", rawSessionId: canonicalSessionA }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(statusDir, `status-${petIdB}.json`),
      JSON.stringify({ state: "idle", agentId: "pi", rawSessionId: canonicalSessionB }),
      "utf8"
    );

    const testEnv = {
      ...process.env,
      CLAWD_PET_RUNTIME_MODULE: rootRuntimePath,
      PI_PET_RUNTIME_MODULE: rootRuntimePath,
      PI_PET_DATA_DIR: tempDir,
      PI_PET_PROFILE_ID: "local",
    };

    const commandIdA = "cmd_e2e_a_001";
    const dedupKeyA = "dedup_e2e_a_001";
    const messageTextA = "Hello Pi session A from local desktop pet!";

    // 1. Simulate HTTP POST /pet-inbox request body for pet A
    const { res: res1, result: result1 } = createMockRes();
    const req1 = createMockReq({
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "user_message",
        petId: petIdA,
        text: messageTextA,
        deliverAs: "followUp",
        commandId: commandIdA,
        dedupKey: dedupKeyA,
        ttlMs: 60000,
      }),
    });

    handlePetInboxPost(req1, res1, {
      env: testEnv,
      dataDir: tempDir,
    });

    await result1.done;

    // 2. Assert route 202 queued response
    assert.equal(result1.statusCode, 202, "Route must return HTTP 202 Accepted for newly queued message");
    assert.equal(result1.headers["Content-Type"], "application/json; charset=utf-8");
    assert.equal(result1.headers[CLAWD_SERVER_HEADER], CLAWD_SERVER_ID);

    const queuedReceipt = JSON.parse(result1.body);
    assert.equal(queuedReceipt.schemaVersion, "1");
    assert.equal(queuedReceipt.kind, "user_message");
    assert.equal(queuedReceipt.commandId, commandIdA);
    assert.equal(queuedReceipt.dedupKey, dedupKeyA);
    assert.equal(queuedReceipt.petId, petIdA);
    assert.equal(queuedReceipt.status, "queued");
    assert.equal(queuedReceipt.deliverAs, "followUp");
    assert.equal(queuedReceipt.text, messageTextA);

    // Assert pending message file exists on disk for pet A
    const pendingDirA = path.join(tempDir, "inbox", petIdA, "pending");
    assert.ok(fs.existsSync(pendingDirA), "Pending directory for pet A must exist");
    const pendingFilesA = fs.readdirSync(pendingDirA).filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"));
    assert.equal(pendingFilesA.length, 1, "Exactly one pending message file should exist for pet A");

    // 3. Ensure a consumer for session B cannot consume A's message
    const mockPiB = createMockPi();
    const consumerB = createInboxConsumer(mockPiB, {
      sessionId: rawSessionB,
      env: testEnv,
      dataDir: tempDir,
    });
    assert.ok(consumerB, "Consumer for session B created");

    const pollResultB = await consumerB.pollOnce();
    assert.equal(pollResultB.hasMore, false, "Consumer B should find no messages in its own session inbox");
    assert.equal(mockPiB.sentUserMessages.length, 0, "Consumer B must NOT call pi.sendUserMessage");

    // Verify pet A's message remains pending on disk
    const pendingFilesAfterB = fs.readdirSync(pendingDirA).filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"));
    assert.equal(pendingFilesAfterB.length, 1, "Pet A pending message must remain intact after consumer B poll");

    // 4. Run consumer bound to raw session A
    const mockPiA = createMockPi();
    const consumerA = createInboxConsumer(mockPiA, {
      sessionId: rawSessionA,
      env: testEnv,
      dataDir: tempDir,
    });
    assert.ok(consumerA, "Consumer for session A created");

    const pollResultA = await consumerA.pollOnce();
    assert.equal(pollResultA.hasMore, true, "Consumer A should indicate more processing after claim");
    assert.equal(pollResultA.status, "dispatched", "Consumer A poll status must be dispatched");

    // 5. Assert exactly one pi.sendUserMessage call with followUp and expandPromptTemplates:false
    assert.equal(mockPiA.sentUserMessages.length, 1, "pi.sendUserMessage must be called exactly once");
    assert.equal(mockPiA.sentUserMessages[0].text, messageTextA);
    assert.deepEqual(mockPiA.sentUserMessages[0].options, {
      deliverAs: "followUp",
      expandPromptTemplates: false,
    });

    // 6. Assert terminal dispatched receipt persisted on disk
    const receiptPath = path.join(tempDir, "receipts", `rcpt-user-${commandIdA}.json`);
    assert.ok(fs.existsSync(receiptPath), "Receipt file must exist on disk");

    const settledReceipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    assert.equal(settledReceipt.schemaVersion, "1");
    assert.equal(settledReceipt.kind, "user_message");
    assert.equal(settledReceipt.commandId, commandIdA);
    assert.equal(settledReceipt.dedupKey, dedupKeyA);
    assert.equal(settledReceipt.petId, petIdA);
    assert.equal(settledReceipt.status, "dispatched");
    assert.equal(settledReceipt.text, messageTextA);
    assert.equal(settledReceipt.deliverAs, "followUp");

    // Verify pending queue for pet A is now empty
    const pendingFilesAfterA = fs.readdirSync(pendingDirA).filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"));
    assert.equal(pendingFilesAfterA.length, 0, "Pending queue for pet A must be empty after dispatch");

    // Verify session B still cannot consume anything
    const pollResultB2 = await consumerB.pollOnce();
    assert.equal(pollResultB2.hasMore, false);
    assert.equal(mockPiB.sentUserMessages.length, 0);

    // 7. Dedup resend through route proving no second dispatch
    const { res: resDedup, result: resultDedup } = createMockRes();
    const reqDedup = createMockReq({
      body: JSON.stringify({
        schemaVersion: "1",
        kind: "user_message",
        petId: petIdA,
        text: messageTextA,
        deliverAs: "followUp",
        commandId: commandIdA,
        dedupKey: dedupKeyA,
        ttlMs: 60000,
      }),
    });

    handlePetInboxPost(reqDedup, resDedup, {
      env: testEnv,
      dataDir: tempDir,
    });

    await resultDedup.done;

    // Route returns existing dispatched receipt (HTTP 200)
    assert.equal(resultDedup.statusCode, 200, "Dedup resend of already-dispatched message should return HTTP 200");
    const dedupReceipt = JSON.parse(resultDedup.body);
    assert.equal(dedupReceipt.status, "dispatched", "Dedup receipt must reflect dispatched status");
    assert.equal(dedupReceipt.commandId, commandIdA);
    assert.equal(dedupReceipt.dedupKey, dedupKeyA);

    // Verify no new pending file was written
    const pendingFilesDedup = fs.readdirSync(pendingDirA).filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"));
    assert.equal(pendingFilesDedup.length, 0, "No pending message file should be created on dedup resend");

    // Polling consumer A again finds no new messages
    const pollResultA2 = await consumerA.pollOnce();
    assert.equal(pollResultA2.hasMore, false, "Consumer A should find no new messages");

    // Verify pi.sendUserMessage was NOT called a second time
    assert.equal(mockPiA.sentUserMessages.length, 1, "pi.sendUserMessage must still have been called exactly once");

    // Ensure consumer B still has zero dispatches
    assert.equal(mockPiB.sentUserMessages.length, 0, "Consumer B must have zero dispatches throughout test");

    consumerA.stop();
    consumerB.stop();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
