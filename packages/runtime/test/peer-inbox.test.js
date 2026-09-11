"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DEFAULT_PEER_MESSAGE_TTL_MS,
  MAX_PEER_INBOX_QUEUE_CAPACITY,
  MAX_PEER_MESSAGE_TTL_MS,
  MIN_PEER_MESSAGE_TTL_MS,
  PEER_CLAIM_TIMEOUT_MS,
  claimNextPeerMessage,
  claimNextUserMessage,
  derivePetId,
  enqueuePeerMessage,
  enqueueUserMessage,
  expressExpression,
  getPeerMessageReceipt,
  getUserMessageReceipt,
  settlePeerMessage,
  settleUserMessage,
} = require("..");

const runtimeModule = require("..");
const interactionModule = require("../interaction");
const peerInboxModule = require("../peer-inbox");

const temporaryDirs = [];

afterEach(() => {
  while (temporaryDirs.length) {
    fs.rmSync(temporaryDirs.pop(), { recursive: true, force: true });
  }
});

function createTestEnvironment() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-test-peer-inbox-"));
  temporaryDirs.push(dataDir);
  const statusDir = path.join(dataDir, "status");
  const eventsDir = path.join(dataDir, "events");
  const receiptsDir = path.join(dataDir, "receipts");
  fs.mkdirSync(statusDir, { recursive: true });
  fs.mkdirSync(eventsDir, { recursive: true });
  fs.mkdirSync(receiptsDir, { recursive: true });
  return { dataDir, statusDir, eventsDir, receiptsDir };
}

function createActiveSession(statusDir, petId, state = "idle") {
  const statusPath = path.join(statusDir, `status-${petId}.json`);
  const status = {
    state,
    detail: "Active session",
    tool: "",
    event: "StatusUpdate",
    session_id: petId,
    session_name: "Pi / test-session",
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(statusPath, JSON.stringify(status, null, 2), "utf8");
  return statusPath;
}

const defaultSource = {
  sourcePetId: derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-source-1" }),
  sourceDisplayName: "backend · Pi",
  sourceHost: "local",
};

describe("Peer Message Inbox: Validation", () => {
  it("rejects non-object options or null", () => {
    assert.strictEqual(enqueuePeerMessage(null).status, "rejected");
    assert.strictEqual(enqueuePeerMessage(undefined).status, "rejected");
    assert.strictEqual(enqueuePeerMessage("hello").status, "rejected");
    assert.strictEqual(enqueuePeerMessage([]).status, "rejected");
  });

  it("rejects payloads exceeding 16 KiB", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-oversize" });
    createActiveSession(statusDir, targetPetId);

    const oversizedText = "x".repeat(17000);
    const result = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: oversizedText,
      dataDir,
    });
    assert.strictEqual(result.status, "rejected");
    assert.match(result.reason, /16 KiB/);
  });

  it("allows enqueueing tiny valid message even when huge env is injected", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-huge-env" });
    createActiveSession(statusDir, targetPetId);

    const hugeEnv = {
      HUGE_VAR: "A".repeat(64 * 1024),
      OTHER_VAR: "B".repeat(64 * 1024),
    };

    const result = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "hello peer",
      dataDir,
      env: hugeEnv,
    });
    assert.strictEqual(result.status, "queued");
    assert.strictEqual(result.text, "hello peer");
    assert.strictEqual(result.targetPetId, targetPetId);
  });

  it("rejects missing, empty, or oversized text", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-text-val" });
    createActiveSession(statusDir, targetPetId);

    const missing = enqueuePeerMessage({ ...defaultSource, targetPetId, dataDir });
    assert.strictEqual(missing.status, "rejected");
    assert.match(missing.reason, /text must be a string/);

    const empty = enqueuePeerMessage({ ...defaultSource, targetPetId, text: "", dataDir });
    assert.strictEqual(empty.status, "rejected");
    assert.match(empty.reason, /text length must be between 1 and 2000/);

    const nonString = enqueuePeerMessage({ ...defaultSource, targetPetId, text: 12345, dataDir });
    assert.strictEqual(nonString.status, "rejected");
    assert.match(nonString.reason, /text must be a string/);

    const oversized = enqueuePeerMessage({ ...defaultSource, targetPetId, text: "a".repeat(2001), dataDir });
    assert.strictEqual(oversized.status, "rejected");
    assert.match(oversized.reason, /text length must be between 1 and 2000/);
  });

  it("rejects invalid deliverAs value", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-deliv" });
    createActiveSession(statusDir, targetPetId);

    const badDeliver = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "hello",
      deliverAs: "urgent",
      dataDir,
    });
    assert.strictEqual(badDeliver.status, "rejected");
    assert.match(badDeliver.reason, /deliverAs must be 'followUp'/);
  });

  it("validates TTL limits (1s..300s, default 60s) and canonical queued status", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-ttl" });
    createActiveSession(statusDir, targetPetId);

    const defaultTtlRes = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "default ttl",
      dataDir,
    });
    assert.strictEqual(defaultTtlRes.status, "queued");
    assert.strictEqual(defaultTtlRes.expiresAtMs - defaultTtlRes.createdAtMs, 60000);

    const minTtlRes = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "min ttl",
      ttlMs: 1000,
      dataDir,
    });
    assert.strictEqual(minTtlRes.status, "queued");
    assert.strictEqual(minTtlRes.expiresAtMs - minTtlRes.createdAtMs, 1000);

    const maxTtlRes = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "max ttl",
      ttlMs: 300000,
      dataDir,
    });
    assert.strictEqual(maxTtlRes.status, "queued");
    assert.strictEqual(maxTtlRes.expiresAtMs - maxTtlRes.createdAtMs, 300000);

    const tooLow = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "too low",
      ttlMs: 999,
      dataDir,
    });
    assert.strictEqual(tooLow.status, "rejected");
    assert.match(tooLow.reason, /ttlMs must be a number between 1000 and 300000/);

    const tooHigh = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "too high",
      ttlMs: 300001,
      dataDir,
    });
    assert.strictEqual(tooHigh.status, "rejected");
    assert.match(tooHigh.reason, /ttlMs must be a number between 1000 and 300000/);

    const fractional = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "fractional ttl",
      ttlMs: 1000.5,
      dataDir,
    });
    assert.strictEqual(fractional.status, "rejected");
  });

  it("validates messageId, dedupKey, and threadId characters and length", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-safe-id" });
    createActiveSession(statusDir, targetPetId);

    const badMessageId = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "bad msg id",
      messageId: "bad/id/with/slash",
      dataDir,
    });
    assert.strictEqual(badMessageId.status, "rejected");
    assert.match(badMessageId.reason, /messageId must be a non-empty string/);

    const badDedupKey = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "bad dedup",
      dedupKey: "bad dedup with spaces",
      dataDir,
    });
    assert.strictEqual(badDedupKey.status, "rejected");
    assert.match(badDedupKey.reason, /dedupKey must be a non-empty string/);

    const badThreadId = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "bad thread",
      threadId: "bad:thread:id",
      dataDir,
    });
    assert.strictEqual(badThreadId.status, "rejected");
    assert.match(badThreadId.reason, /threadId must be a non-empty string/);
  });

  it("validates hopCount and maxHops constraints (0 <= hopCount <= maxHops <= 1)", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-hop" });
    createActiveSession(statusDir, targetPetId);

    // Initial note (hop 0) with replyHandle
    const hop0Res = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "hop 0 note",
      hopCount: 0,
      maxHops: 1,
      replyHandle: "psh_handle123",
      dataDir,
    });
    assert.strictEqual(hop0Res.status, "queued");
    assert.strictEqual(hop0Res.hopCount, 0);
    assert.strictEqual(hop0Res.maxHops, 1);
    assert.strictEqual(hop0Res.replyHandle, "psh_handle123");

    const unsafeOpaqueHandle = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "unsafe reply handle",
      replyHandle: "../../another-session",
      dataDir,
    });
    assert.strictEqual(unsafeOpaqueHandle.status, "rejected");
    assert.match(unsafeOpaqueHandle.reason, /safe psh_ opaque handle/);

    // Reply note (hop 1) without replyHandle
    const hop1Res = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "hop 1 note",
      hopCount: 1,
      maxHops: 1,
      dataDir,
    });
    assert.strictEqual(hop1Res.status, "queued");
    assert.strictEqual(hop1Res.hopCount, 1);
    assert.strictEqual(hop1Res.maxHops, 1);

    // Reply note (hop 1) specifying a replyHandle must be rejected
    const badReplyHandle = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "hop 1 with replyHandle",
      hopCount: 1,
      maxHops: 1,
      replyHandle: "psh_handle_illegal",
      dataDir,
    });
    assert.strictEqual(badReplyHandle.status, "rejected");
    assert.match(badReplyHandle.reason, /reply message \(hopCount > 0\) cannot specify a replyHandle/);

    // hopCount > maxHops must be rejected
    const badHopCount = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "hop 2 note",
      hopCount: 2,
      maxHops: 1,
      dataDir,
    });
    assert.strictEqual(badHopCount.status, "rejected");
    assert.match(badHopCount.reason, /hopCount and maxHops must satisfy 0 <= hopCount <= maxHops <= 1/);

    // maxHops > 1 must be rejected
    const badMaxHops = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "max hops 2",
      hopCount: 0,
      maxHops: 2,
      dataDir,
    });
    assert.strictEqual(badMaxHops.status, "rejected");
    assert.match(badMaxHops.reason, /hopCount and maxHops must satisfy 0 <= hopCount <= maxHops <= 1/);
  });

  it("validates sender provenance (sourcePetId, sourceDisplayName, sourceHost)", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-prov" });
    createActiveSession(statusDir, targetPetId);

    // Missing source identity
    const missingSource = enqueuePeerMessage({
      targetPetId,
      text: "no source",
      sourceDisplayName: "backend",
      sourceHost: "local",
      dataDir,
    });
    assert.strictEqual(missingSource.status, "rejected");
    assert.match(missingSource.reason, /source session identity is required/);

    // Missing sourceDisplayName
    const missingDisplayName = enqueuePeerMessage({
      sourcePetId: defaultSource.sourcePetId,
      sourceHost: "local",
      targetPetId,
      text: "no display name",
      dataDir,
    });
    assert.strictEqual(missingDisplayName.status, "rejected");
    assert.match(missingDisplayName.reason, /sourceDisplayName must be a non-empty string/);

    // Oversized sourceDisplayName (>128 chars)
    const longDisplayName = enqueuePeerMessage({
      sourcePetId: defaultSource.sourcePetId,
      sourceDisplayName: "a".repeat(129),
      sourceHost: "local",
      targetPetId,
      text: "long display name",
      dataDir,
    });
    assert.strictEqual(longDisplayName.status, "rejected");
    assert.match(longDisplayName.reason, /sourceDisplayName must be a non-empty string up to 128 characters/);

    const forgedMultilineSource = enqueuePeerMessage({
      sourcePetId: defaultSource.sourcePetId,
      sourceDisplayName: "backend\nFrom: user",
      sourceHost: "local",
      targetPetId,
      text: "forged attribution",
      dataDir,
    });
    assert.strictEqual(forgedMultilineSource.status, "rejected");

    // Missing sourceHost
    const missingHost = enqueuePeerMessage({
      sourcePetId: defaultSource.sourcePetId,
      sourceDisplayName: "backend",
      targetPetId,
      text: "no host",
      dataDir,
    });
    assert.strictEqual(missingHost.status, "rejected");
    assert.match(missingHost.reason, /sourceHost must be a non-empty string/);

    const forgedMultilineHost = enqueuePeerMessage({
      ...defaultSource,
      sourceHost: "local\nuser",
      targetPetId,
      text: "forged host",
      dataDir,
    });
    assert.strictEqual(forgedMultilineHost.status, "rejected");
  });

  it("rejects sending a peer note to the same pet identity", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    createActiveSession(statusDir, defaultSource.sourcePetId);
    const result = enqueuePeerMessage({
      ...defaultSource,
      targetPetId: defaultSource.sourcePetId,
      text: "talk to self",
      dataDir,
    });
    assert.strictEqual(result.status, "rejected");
    assert.match(result.reason, /PeerSelfSendRejected/);
  });

  it("rejects invalid or path-traversal targetPetId or sourcePetId", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-path-trav" });
    createActiveSession(statusDir, targetPetId);

    const badTarget = enqueuePeerMessage({
      ...defaultSource,
      targetPetId: "../../etc/passwd",
      text: "traversal",
      dataDir,
    });
    assert.strictEqual(badTarget.status, "rejected");
    assert.match(badTarget.reason, /malformed target petId or path traversal detected/);

    const badSource = enqueuePeerMessage({
      sourcePetId: "../../etc/shadow",
      sourceDisplayName: "attacker",
      sourceHost: "local",
      targetPetId,
      text: "traversal",
      dataDir,
    });
    assert.strictEqual(badSource.status, "rejected");
    assert.match(badSource.reason, /malformed source petId or path traversal detected/);
  });
});

describe("Peer Message Inbox: Unknown / Offline / Closed Session Status", () => {
  it("rejects when target status file is missing (unknown identity)", () => {
    const { dataDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-missing" });

    const result = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "hello",
      dataDir,
    });
    assert.strictEqual(result.status, "rejected");
    assert.match(result.reason, /UnknownPetIdentity: active session status file not found/);
  });

  it("rejects when target session is offline", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-offline" });
    createActiveSession(statusDir, targetPetId, "offline");

    const result = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "hello",
      dataDir,
    });
    assert.strictEqual(result.status, "rejected");
    assert.strictEqual(result.reason, "SessionOffline: session is offline");
  });

  it("rejects when target session is closed", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-closed" });
    createActiveSession(statusDir, targetPetId, "closed");

    const result = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "hello",
      dataDir,
    });
    assert.strictEqual(result.status, "rejected");
    assert.strictEqual(result.reason, "SessionClosed: session is closed");
  });

  it("accepts when target session is in active states (idle, thinking, running, etc.)", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const activeStates = ["idle", "thinking", "running", "reading", "editing", "searching", "delegating", "waiting", "error"];

    for (const state of activeStates) {
      const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: `s-active-${state}` });
      createActiveSession(statusDir, targetPetId, state);

      const result = enqueuePeerMessage({
        ...defaultSource,
        targetPetId,
        text: `state test for ${state}`,
        dataDir,
      });
      assert.strictEqual(result.status, "queued", `Should accept in state ${state}`);
    }
  });
});

describe("Peer Message Inbox: FIFO Queue Ordering", () => {
  it("claims messages in strict FIFO order and returns null when empty", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-fifo" });
    createActiveSession(statusDir, targetPetId);

    const baseTime = Date.now();
    const msg1 = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "first note",
      createdAtMs: baseTime,
      now: () => baseTime,
      dataDir,
    });
    const msg2 = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "second note",
      createdAtMs: baseTime + 100,
      now: () => baseTime + 100,
      dataDir,
    });
    const msg3 = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "third note",
      createdAtMs: baseTime + 200,
      now: () => baseTime + 200,
      dataDir,
    });

    assert.strictEqual(msg1.status, "queued");
    assert.strictEqual(msg2.status, "queued");
    assert.strictEqual(msg3.status, "queued");

    const claim1 = claimNextPeerMessage({ targetPetId, dataDir, now: () => baseTime + 300 });
    assert.ok(claim1);
    assert.strictEqual(claim1.text, "first note");
    assert.strictEqual(claim1.messageId, msg1.messageId);

    const claim2 = claimNextPeerMessage({ targetPetId, dataDir, now: () => baseTime + 400 });
    assert.ok(claim2);
    assert.strictEqual(claim2.text, "second note");
    assert.strictEqual(claim2.messageId, msg2.messageId);

    const claim3 = claimNextPeerMessage({ targetPetId, dataDir, now: () => baseTime + 500 });
    assert.ok(claim3);
    assert.strictEqual(claim3.text, "third note");
    assert.strictEqual(claim3.messageId, msg3.messageId);

    const claim4 = claimNextPeerMessage({ targetPetId, dataDir, now: () => baseTime + 600 });
    assert.strictEqual(claim4, null);
  });
});

describe("Peer Message Inbox: Deduplication & Receipt Separation", () => {
  it("deduplicates same (sourcePetId, targetPetId, dedupKey) and preserves original receipt without re-enqueueing", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-dedup" });
    createActiveSession(statusDir, targetPetId);

    const dedupKey = "dedup_peer_123";
    const res1 = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "initial peer note",
      dedupKey,
      dataDir,
    });
    assert.strictEqual(res1.status, "queued");

    const res2 = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "resend peer note",
      dedupKey,
      dataDir,
    });
    assert.strictEqual(res2.status, "queued");
    assert.strictEqual(res2.messageId, res1.messageId);
    assert.strictEqual(res2.text, "initial peer note");

    const pendingDir = path.join(dataDir, "peer-inbox", targetPetId, "pending");
    const pendingFiles = fs.readdirSync(pendingDir).filter((f) => f.endsWith(".json"));
    assert.strictEqual(pendingFiles.length, 1);
  });

  it("does not confuse peer-message receipts with user-message or expression receipts", () => {
    const { dataDir, statusDir, receiptsDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-rcpt-iso" });
    createActiveSession(statusDir, targetPetId);

    // 1. Write an expression receipt: rcpt-cmd1.json
    fs.writeFileSync(
      path.join(receiptsDir, "rcpt-cmd1.json"),
      JSON.stringify({ schemaVersion: "1", commandId: "cmd1", petId: targetPetId, status: "delivered", kind: "expression" }),
      "utf8"
    );

    // 2. Write a user-message receipt: rcpt-user-cmd1.json
    fs.writeFileSync(
      path.join(receiptsDir, "rcpt-user-cmd1.json"),
      JSON.stringify({ schemaVersion: "1", commandId: "cmd1", petId: targetPetId, status: "dispatched", kind: "user_message" }),
      "utf8"
    );

    // 3. Enqueue a peer message with messageId "cmd1"
    const peerRes = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "peer message with same ID as expression/user",
      messageId: "cmd1",
      dataDir,
    });
    assert.strictEqual(peerRes.status, "queued");
    assert.strictEqual(peerRes.messageId, "cmd1");

    // Verify separate files exist in receiptsDir
    assert.ok(fs.existsSync(path.join(receiptsDir, "rcpt-cmd1.json")));
    assert.ok(fs.existsSync(path.join(receiptsDir, "rcpt-user-cmd1.json")));
    assert.ok(fs.existsSync(path.join(receiptsDir, "rcpt-peer-cmd1.json")));
  });

  it("rejects MessageIdConflict across different targets or sources", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetA = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-target-a" });
    const targetPetB = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-target-b" });
    createActiveSession(statusDir, targetPetA);
    createActiveSession(statusDir, targetPetB);

    const messageId = "msg_shared_123";
    const resA = enqueuePeerMessage({
      ...defaultSource,
      targetPetId: targetPetA,
      text: "note for A",
      messageId,
      dataDir,
    });
    assert.strictEqual(resA.status, "queued");

    // Same messageId, different target pet
    const resB = enqueuePeerMessage({
      ...defaultSource,
      targetPetId: targetPetB,
      text: "note for B with same messageId",
      messageId,
      dataDir,
    });
    assert.strictEqual(resB.status, "rejected");
    assert.match(resB.reason, /MessageIdConflict: messageId "msg_shared_123" already exists for a different source or target pet/);

    // Same messageId, different source pet
    const sourceB = {
      sourcePetId: derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-source-2" }),
      sourceDisplayName: "other source",
      sourceHost: "local",
    };
    const resDiffSource = enqueuePeerMessage({
      ...sourceB,
      targetPetId: targetPetA,
      text: "note from source B with same messageId",
      messageId,
      dataDir,
    });
    assert.strictEqual(resDiffSource.status, "rejected");
    assert.match(resDiffSource.reason, /MessageIdConflict: messageId "msg_shared_123" already exists for a different source or target pet/);
  });

  it("enforces dedup triplet (source, target, dedupKey) and never returns receipts across sources", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-triplet" });
    createActiveSession(statusDir, targetPetId);

    const sourceA = defaultSource;
    const sourceB = {
      sourcePetId: derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-source-b" }),
      sourceDisplayName: "source B",
      sourceHost: "local",
    };

    const sharedDedupKey = "dedup_shared_key_456";

    // Source A enqueues with dedupKey
    const resA = enqueuePeerMessage({
      ...sourceA,
      targetPetId,
      text: "note from source A",
      dedupKey: sharedDedupKey,
      dataDir,
    });
    assert.strictEqual(resA.status, "queued");
    assert.strictEqual(resA.sourcePetId, sourceA.sourcePetId);

    // Source B enqueues with same dedupKey -> must NOT match Source A's receipt!
    const resB = enqueuePeerMessage({
      ...sourceB,
      targetPetId,
      text: "note from source B",
      dedupKey: sharedDedupKey,
      dataDir,
    });
    assert.strictEqual(resB.status, "queued");
    assert.strictEqual(resB.sourcePetId, sourceB.sourcePetId);
    assert.notStrictEqual(resB.messageId, resA.messageId, "Different sources must receive separate messageIds and not reuse receipts");

    // 2 pending files exist
    const pendingDir = path.join(dataDir, "peer-inbox", targetPetId, "pending");
    const pendingFiles = fs.readdirSync(pendingDir).filter((f) => f.endsWith(".json"));
    assert.strictEqual(pendingFiles.length, 2);
  });

  it("performs opportunistic GC on rcpt-peer-* older than 24h without touching rcpt-user-* or rcpt-*", () => {
    const { dataDir, statusDir, receiptsDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-gc" });
    createActiveSession(statusDir, targetPetId);

    const now = Date.now();
    const oldTime = now - 25 * 60 * 60 * 1000; // 25 hours ago

    // 1. Old peer receipt
    const oldPeerPath = path.join(receiptsDir, "rcpt-peer-old.json");
    fs.writeFileSync(
      oldPeerPath,
      JSON.stringify({ schemaVersion: "1", messageId: "old", targetPetId, sourcePetId: defaultSource.sourcePetId, status: "dispatched", createdAtMs: oldTime, updatedAtMs: oldTime }),
      "utf8"
    );

    // 2. Old user receipt (must not be unlinked by peer enqueue)
    const oldUserPath = path.join(receiptsDir, "rcpt-user-old.json");
    fs.writeFileSync(
      oldUserPath,
      JSON.stringify({ schemaVersion: "1", commandId: "old", petId: targetPetId, status: "dispatched", createdAtMs: oldTime, updatedAtMs: oldTime }),
      "utf8"
    );

    // 3. Old expression receipt (must not be unlinked by peer enqueue)
    const oldExprPath = path.join(receiptsDir, "rcpt-old.json");
    fs.writeFileSync(
      oldExprPath,
      JSON.stringify({ schemaVersion: "1", commandId: "old", petId: targetPetId, status: "delivered", createdAtMs: oldTime, updatedAtMs: oldTime }),
      "utf8"
    );

    // Enqueue a new peer message to trigger opportunistic GC
    enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "trigger gc",
      now: () => now,
      dataDir,
    });

    // Verify old peer receipt was unlinked, but user and expression receipts were preserved
    assert.strictEqual(fs.existsSync(oldPeerPath), false, "Old peer receipt should be deleted");
    assert.strictEqual(fs.existsSync(oldUserPath), true, "Old user receipt must NOT be deleted by peer inbox GC");
    assert.strictEqual(fs.existsSync(oldExprPath), true, "Old expression receipt must NOT be deleted by peer inbox GC");
  });
});

describe("Peer Message Inbox: Queue Capacity (Cap at 16)", () => {
  it("caps pending + claimed at 16 and rejects newest messages", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-cap-16" });
    createActiveSession(statusDir, targetPetId);

    // Enqueue 16 messages
    for (let i = 0; i < 16; i++) {
      const res = enqueuePeerMessage({
        ...defaultSource,
        targetPetId,
        text: `note ${i}`,
        dataDir,
      });
      assert.strictEqual(res.status, "queued", `Message ${i} should be queued`);
    }

    // 17th message must be rejected
    const res17 = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "overflow note 17",
      dataDir,
    });
    assert.strictEqual(res17.status, "rejected");
    assert.match(res17.reason, /QueueCapacityExceeded: peer inbox queue capacity limit of 16 reached/);

    // Claim one message (moves from pending to claimed, total remains 16)
    const claimed = claimNextPeerMessage({ targetPetId, dataDir });
    assert.ok(claimed);

    // Attempting to enqueue when pending + claimed == 16 is still rejected
    const res18 = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "overflow note 18",
      dataDir,
    });
    assert.strictEqual(res18.status, "rejected");
    assert.match(res18.reason, /QueueCapacityExceeded/);

    // Settle the claimed message to dispatched (frees one slot)
    const settled = settlePeerMessage({
      targetPetId,
      messageId: claimed.messageId,
      claimToken: claimed.claimToken,
      status: "dispatched",
      dataDir,
    });
    assert.strictEqual(settled.status, "dispatched");

    // Now a new message can be enqueued
    const res19 = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "note 19 after settle",
      dataDir,
    });
    assert.strictEqual(res19.status, "queued");
  });

  it("does not mix capacity with user message inbox", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-cap-iso" });
    createActiveSession(statusDir, petId);

    // Enqueue 16 peer messages
    for (let i = 0; i < 16; i++) {
      const res = enqueuePeerMessage({
        ...defaultSource,
        targetPetId: petId,
        text: `peer ${i}`,
        dataDir,
      });
      assert.strictEqual(res.status, "queued");
    }

    // Peer inbox is full (16)
    const peerOverflow = enqueuePeerMessage({
      ...defaultSource,
      targetPetId: petId,
      text: "peer overflow",
      dataDir,
    });
    assert.strictEqual(peerOverflow.status, "rejected");

    // User inbox can still accept messages (its capacity is 32)
    const userMsg = enqueueUserMessage({
      petId,
      text: "user message unaffected by peer queue",
      dataDir,
    });
    assert.strictEqual(userMsg.status, "queued");
  });
});

describe("Peer Message Inbox: TTL and Stale Message Handling", () => {
  it("expires stale message at ingestion without writing to pending queue", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-ttl-ingest" });
    createActiveSession(statusDir, targetPetId);

    const nowMs = 2000000;
    const createdAtMs = nowMs - 70000; // 70s ago with 60s TTL
    const res = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "already stale",
      createdAtMs,
      ttlMs: 60000,
      now: () => nowMs,
      dataDir,
    });
    assert.strictEqual(res.status, "expired");
    assert.match(res.reason, /Message expired before processing/);

    const pendingDir = path.join(dataDir, "peer-inbox", targetPetId, "pending");
    const files = fs.existsSync(pendingDir) ? fs.readdirSync(pendingDir) : [];
    assert.strictEqual(files.length, 0);
  });

  it("skips and expires stale messages in queue during claimNextPeerMessage", () => {
    const { dataDir, statusDir, receiptsDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-ttl-claim" });
    createActiveSession(statusDir, targetPetId);

    const baseTime = 1000000;
    const msg1 = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "message 1 will expire",
      createdAtMs: baseTime,
      ttlMs: 5000,
      now: () => baseTime,
      dataDir,
    });
    const msg2 = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "message 2 remains valid",
      createdAtMs: baseTime + 1000,
      ttlMs: 60000,
      now: () => baseTime + 1000,
      dataDir,
    });

    assert.strictEqual(msg1.status, "queued");
    assert.strictEqual(msg2.status, "queued");

    // Claim at baseTime + 10000 (msg1 expired, msg2 still valid)
    const claimed = claimNextPeerMessage({
      targetPetId,
      now: () => baseTime + 10000,
      dataDir,
    });
    assert.ok(claimed);
    assert.strictEqual(claimed.messageId, msg2.messageId);
    assert.strictEqual(claimed.text, "message 2 remains valid");

    // Verify msg1 receipt was written with expired status
    const rcpt1Path = path.join(receiptsDir, `rcpt-peer-${msg1.messageId}.json`);
    assert.ok(fs.existsSync(rcpt1Path));
    const rcpt1 = JSON.parse(fs.readFileSync(rcpt1Path, "utf8"));
    assert.strictEqual(rcpt1.status, "expired");
    assert.strictEqual(rcpt1.reason, "Message expired in queue before delivery");
  });
});

describe("Peer Message Inbox: Claim Token and Settlement", () => {
  it("requires valid claimToken in settlePeerMessage and rejects bad tokens", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-token" });
    createActiveSession(statusDir, targetPetId);

    const enqueued = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "settle test",
      dataDir,
    });
    const claimed = claimNextPeerMessage({ targetPetId, dataDir });
    assert.ok(claimed);

    // Settle with wrong token
    const wrongTokenRes = settlePeerMessage({
      targetPetId,
      messageId: claimed.messageId,
      claimToken: "wrong-claim-token-12345",
      status: "dispatched",
      dataDir,
    });
    assert.strictEqual(wrongTokenRes.status, "rejected");
    assert.match(wrongTokenRes.reason, /InvalidClaimToken: claimToken does not match active claim/);

    // Settle with correct token
    const correctSettle = settlePeerMessage({
      targetPetId,
      messageId: claimed.messageId,
      claimToken: claimed.claimToken,
      status: "dispatched",
      dataDir,
    });
    assert.strictEqual(correctSettle.status, "dispatched");
    assert.strictEqual(correctSettle.messageId, claimed.messageId);
  });

  it("rejects settle with status 'delivered' or unknown status", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-bad-status" });
    createActiveSession(statusDir, targetPetId);

    const enqueued = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "bad status test",
      dataDir,
    });
    const claimed = claimNextPeerMessage({ targetPetId, dataDir });

    const deliveredRes = settlePeerMessage({
      targetPetId,
      messageId: claimed.messageId,
      claimToken: claimed.claimToken,
      status: "delivered",
      dataDir,
    });
    assert.strictEqual(deliveredRes.status, "rejected");
    assert.match(deliveredRes.reason, /Invalid settle status 'delivered'/);

    const randomStatusRes = settlePeerMessage({
      targetPetId,
      messageId: claimed.messageId,
      claimToken: claimed.claimToken,
      status: "unknown_status",
      dataDir,
    });
    assert.strictEqual(randomStatusRes.status, "rejected");
    assert.match(randomStatusRes.reason, /status must be one of: dispatched, failed, expired/);
  });

  it("validates settle reason: string <= 1024 or null accepted; other types or >1024 rejected", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-settle-reason" });
    createActiveSession(statusDir, targetPetId);

    // Settle with null reason
    const enq1 = enqueuePeerMessage({ ...defaultSource, targetPetId, text: "note null reason", dataDir });
    const claim1 = claimNextPeerMessage({ targetPetId, dataDir });
    const settle1 = settlePeerMessage({
      targetPetId,
      messageId: claim1.messageId,
      claimToken: claim1.claimToken,
      status: "dispatched",
      reason: null,
      dataDir,
    });
    assert.strictEqual(settle1.status, "dispatched");
    assert.strictEqual(settle1.reason, null);

    // Settle with 1024-character string
    const enq2 = enqueuePeerMessage({ ...defaultSource, targetPetId, text: "note 1024 reason", dataDir });
    const claim2 = claimNextPeerMessage({ targetPetId, dataDir });
    const longReason1024 = "R".repeat(1024);
    const settle2 = settlePeerMessage({
      targetPetId,
      messageId: claim2.messageId,
      claimToken: claim2.claimToken,
      status: "failed",
      reason: longReason1024,
      dataDir,
    });
    assert.strictEqual(settle2.status, "failed");
    assert.strictEqual(settle2.reason, longReason1024);

    // Settle with 1025-character string (rejected)
    const enq3 = enqueuePeerMessage({ ...defaultSource, targetPetId, text: "note 1025 reason", dataDir });
    const claim3 = claimNextPeerMessage({ targetPetId, dataDir });
    const longReason1025 = "R".repeat(1025);
    const settle3 = settlePeerMessage({
      targetPetId,
      messageId: claim3.messageId,
      claimToken: claim3.claimToken,
      status: "failed",
      reason: longReason1025,
      dataDir,
    });
    assert.strictEqual(settle3.status, "rejected");
    assert.match(settle3.reason, /settle reason length must be at most 1024 characters/);

    // Settle with non-string, non-null types (number, object, boolean, array -> rejected)
    const badTypes = [12345, true, { reason: "nested" }, ["reason"]];
    for (const badReason of badTypes) {
      const settleBad = settlePeerMessage({
        targetPetId,
        messageId: claim3.messageId,
        claimToken: claim3.claimToken,
        status: "failed",
        reason: badReason,
        dataDir,
      });
      assert.strictEqual(settleBad.status, "rejected");
      assert.match(settleBad.reason, /settle reason must be a string or null/);
    }
  });

  it("allows settling message even when huge env is injected", () => {
    const { dataDir, statusDir, eventsDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-huge-env-settle" });
    createActiveSession(statusDir, targetPetId);

    const enq = enqueuePeerMessage({ ...defaultSource, targetPetId, text: "settle env test", dataDir });
    const claim = claimNextPeerMessage({ targetPetId, dataDir });

    const hugeEnv = {
      BIG_1: "X".repeat(64 * 1024),
      BIG_2: "Y".repeat(64 * 1024),
    };

    const settleRes = settlePeerMessage({
      targetPetId,
      messageId: claim.messageId,
      claimToken: claim.claimToken,
      status: "dispatched",
      dataDir,
      env: hugeEnv,
    });
    assert.strictEqual(settleRes.status, "dispatched");
    const eventPath = path.join(eventsDir, `event-${targetPetId}.json`);
    assert.ok(fs.existsSync(eventPath), "bubble event file should exist when huge env is injected");
  });

  it("if pending write succeeds but receipt write fails, deletes pending before returning failed", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-io-fail" });
    createActiveSession(statusDir, targetPetId);

    const realFs = fs;
    const customFs = {
      ...realFs,
      writeFileSync(targetPath, data, encoding) {
        if (targetPath.includes("rcpt-peer-")) {
          throw new Error("Disk full simulating receipt write failure");
        }
        return realFs.writeFileSync(targetPath, data, encoding);
      },
    };

    const res = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "io fail test",
      dataDir,
      fsApi: customFs,
    });
    assert.strictEqual(res.status, "failed");
    assert.match(res.reason, /IO failure writing initial receipt/);

    // Verify pending directory is empty
    const pendingDir = path.join(dataDir, "peer-inbox", targetPetId, "pending");
    const files = fs.readdirSync(pendingDir).filter((f) => f.endsWith(".json"));
    assert.strictEqual(files.length, 0);
  });

  it("normal settle leaves claim if receipt write fails (I/O evidence preservation)", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-io-settle" });
    createActiveSession(statusDir, targetPetId);

    const enq = enqueuePeerMessage({ ...defaultSource, targetPetId, text: "io settle fail", dataDir });
    const claim = claimNextPeerMessage({ targetPetId, dataDir });

    const realFs = fs;
    const customFs = {
      ...realFs,
      writeFileSync(targetPath, data, encoding) {
        if (targetPath.includes("rcpt-peer-")) {
          throw new Error("Disk full simulating settle receipt write failure");
        }
        return realFs.writeFileSync(targetPath, data, encoding);
      },
    };

    const res = settlePeerMessage({
      targetPetId,
      messageId: claim.messageId,
      claimToken: claim.claimToken,
      status: "dispatched",
      dataDir,
      fsApi: customFs,
    });
    assert.strictEqual(res.status, "failed");
    assert.match(res.reason, /IO failure writing settled receipt/);

    // Verify claimed file was retained
    const claimedPath = path.join(dataDir, "peer-inbox", targetPetId, "claimed", `${claim.messageId}.json`);
    assert.strictEqual(fs.existsSync(claimedPath), true);
  });
});

describe("Peer Message Inbox: Stale Claimed Items and Rename Window Safety", () => {
  it("marks stale claimed items older than 60s as terminal failed/delivery-unknown and never replays", () => {
    const { dataDir, statusDir, receiptsDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-stale-claim" });
    createActiveSession(statusDir, targetPetId);

    const baseTime = Date.now();
    const enqueued = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "stale claim note",
      createdAtMs: baseTime,
      now: () => baseTime,
      dataDir,
    });

    const claimed = claimNextPeerMessage({ targetPetId, now: () => baseTime, dataDir });
    assert.ok(claimed);

    // 65 seconds later (>60s claim timeout), next claimNextPeerMessage triggers cleanup
    const nextClaim = claimNextPeerMessage({ targetPetId, now: () => baseTime + 65000, dataDir });
    assert.strictEqual(nextClaim, null);

    // Verify terminal receipt was written with failed status
    const rcptPath = path.join(receiptsDir, `rcpt-peer-${claimed.messageId}.json`);
    assert.ok(fs.existsSync(rcptPath));
    const rcpt = JSON.parse(fs.readFileSync(rcptPath, "utf8"));
    assert.strictEqual(rcpt.status, "failed");
    assert.match(rcpt.reason, /stale claimed item older than 60s \(delivery-unknown\)/);

    // Claim directory must be clean
    const claimedDir = path.join(dataDir, "peer-inbox", targetPetId, "claimed");
    const claimedFiles = fs.readdirSync(claimedDir).filter((f) => f.endsWith(".json"));
    assert.strictEqual(claimedFiles.length, 0);

    // Never replays: pending directory must be empty
    const pendingDir = path.join(dataDir, "peer-inbox", targetPetId, "pending");
    const pendingFiles = fs.readdirSync(pendingDir).filter((f) => f.endsWith(".json"));
    assert.strictEqual(pendingFiles.length, 0);
  });

  it("skips claimed files with missing or illegal claimedAtMs without falling back to createdAtMs (prevents killing rename window)", () => {
    const { dataDir, statusDir, receiptsDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-rename-win" });
    createActiveSession(statusDir, targetPetId);

    const nowMs = 1000000;
    const oldCreatedAtMs = nowMs - 70000; // 70s ago

    const claimedDir = path.join(dataDir, "peer-inbox", targetPetId, "claimed");
    fs.mkdirSync(claimedDir, { recursive: true });

    // 1. File during rename window: has createdAtMs 70s ago, but claimedAtMs is undefined
    const renameWinPath = path.join(claimedDir, "msg_rename_win.json");
    fs.writeFileSync(
      renameWinPath,
      JSON.stringify({
        schemaVersion: "1",
        kind: "peer_message",
        messageId: "msg_rename_win",
        targetPetId,
        sourcePetId: defaultSource.sourcePetId,
        sourceDisplayName: defaultSource.sourceDisplayName,
        sourceHost: defaultSource.sourceHost,
        text: "rename window message",
        createdAtMs: oldCreatedAtMs,
      }),
      "utf8"
    );

    // 2. File with illegal claimedAtMs (string, float, NaN)
    const illegalPath = path.join(claimedDir, "msg_illegal_claimed.json");
    fs.writeFileSync(
      illegalPath,
      JSON.stringify({
        schemaVersion: "1",
        kind: "peer_message",
        messageId: "msg_illegal_claimed",
        targetPetId,
        sourcePetId: defaultSource.sourcePetId,
        sourceDisplayName: defaultSource.sourceDisplayName,
        sourceHost: defaultSource.sourceHost,
        text: "illegal claimed at",
        claimedAtMs: "not_a_number",
        createdAtMs: oldCreatedAtMs,
      }),
      "utf8"
    );

    // Run claimNextPeerMessage (triggers stale cleanup)
    claimNextPeerMessage({ targetPetId, now: () => nowMs, dataDir });

    // Both files must be preserved and NOT deleted or failed
    assert.strictEqual(fs.existsSync(renameWinPath), true, "Rename window file must NOT be killed");
    assert.strictEqual(fs.existsSync(illegalPath), true, "Illegal claimedAt file must be skipped without deletion");

    // No failed receipt written
    assert.strictEqual(fs.existsSync(path.join(receiptsDir, "rcpt-peer-msg_rename_win.json")), false);
  });

  it("stale cleanup does not overwrite or downgrade existing terminal receipt", () => {
    const { dataDir, statusDir, receiptsDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-stale-term" });
    createActiveSession(statusDir, targetPetId);

    const baseTime = Date.now();
    const enqueued = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "already dispatched note",
      createdAtMs: baseTime,
      now: () => baseTime,
      dataDir,
    });

    const claimed = claimNextPeerMessage({ targetPetId, now: () => baseTime, dataDir });
    assert.ok(claimed);

    // Settle to dispatched
    settlePeerMessage({
      targetPetId,
      messageId: claimed.messageId,
      claimToken: claimed.claimToken,
      status: "dispatched",
      now: () => baseTime + 5000,
      dataDir,
    });

    // Manually create a leftover claim file to simulate crash right before unlink
    const claimedPath = path.join(dataDir, "peer-inbox", targetPetId, "claimed", `${claimed.messageId}.json`);
    fs.writeFileSync(claimedPath, JSON.stringify({ ...claimed, claimedAtMs: baseTime }), "utf8");

    // Clean up at baseTime + 70000 (>60s)
    claimNextPeerMessage({ targetPetId, now: () => baseTime + 70000, dataDir });

    // Receipt must still be dispatched, NOT downgraded to failed
    const rcptPath = path.join(receiptsDir, `rcpt-peer-${claimed.messageId}.json`);
    const rcpt = JSON.parse(fs.readFileSync(rcptPath, "utf8"));
    assert.strictEqual(rcpt.status, "dispatched");
    assert.strictEqual(fs.existsSync(claimedPath), false);
  });
});

describe("Peer Message Inbox: createdAtMs Trusted Test Seam Validation", () => {
  it("accepts safe integer createdAtMs within [now - 300000, now + 10000]", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-created-ok" });
    createActiveSession(statusDir, targetPetId);

    const nowMs = 1000000;

    // Lower bound: now - 300000
    const lowerRes = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "lower bound",
      createdAtMs: nowMs - 300000,
      now: () => nowMs,
      dataDir,
    });
    // Note: at now - 300000 with default 60s TTL, it is expired at ingestion, but status is expired, not rejected!
    assert.strictEqual(lowerRes.status, "expired");

    // Upper bound: now + 10000
    const upperRes = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "upper bound",
      createdAtMs: nowMs + 10000,
      now: () => nowMs,
      dataDir,
    });
    assert.strictEqual(upperRes.status, "queued");
    assert.strictEqual(upperRes.createdAtMs, nowMs + 10000);

    // Exact now
    const exactRes = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "exact now",
      createdAtMs: nowMs,
      now: () => nowMs,
      dataDir,
    });
    assert.strictEqual(exactRes.status, "queued");
    assert.strictEqual(exactRes.createdAtMs, nowMs);
  });

  it("rejects createdAtMs outside [now - 300000, now + 10000] or non-safe-integer", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-created-bad" });
    createActiveSession(statusDir, targetPetId);

    const nowMs = 1000000;

    // Below lower bound: now - 300001
    const tooOld = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "too old",
      createdAtMs: nowMs - 300001,
      now: () => nowMs,
      dataDir,
    });
    assert.strictEqual(tooOld.status, "rejected");
    assert.match(tooOld.reason, /createdAtMs must be a safe integer within \[now - 300000, now \+ 10000\]/);

    // Above upper bound: now + 10001
    const tooFarFuture = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "too far future",
      createdAtMs: nowMs + 10001,
      now: () => nowMs,
      dataDir,
    });
    assert.strictEqual(tooFarFuture.status, "rejected");
    assert.match(tooFarFuture.reason, /createdAtMs must be a safe integer within \[now - 300000, now \+ 10000\]/);

    // Float / non-integer
    const floatRes = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "float timestamp",
      createdAtMs: nowMs + 0.5,
      now: () => nowMs,
      dataDir,
    });
    assert.strictEqual(floatRes.status, "rejected");
    assert.match(floatRes.reason, /createdAtMs must be a safe integer/);

    // NaN / Infinity / string
    const badValues = [NaN, Infinity, -Infinity, "1000000", {}];
    for (const val of badValues) {
      const res = enqueuePeerMessage({
        ...defaultSource,
        targetPetId,
        text: "bad timestamp",
        createdAtMs: val,
        now: () => nowMs,
        dataDir,
      });
      assert.strictEqual(res.status, "rejected");
      assert.match(res.reason, /createdAtMs must be a safe integer/);
    }
  });
});

describe("Peer Message Inbox: Removal of Ambiguous Dual-Role Aliases", () => {
  it("rejects petId, rawSession, profile, and commandId aliases in enqueuePeerMessage", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-alias-enq" });
    createActiveSession(statusDir, targetPetId);

    // Passing petId instead of targetPetId must be rejected
    const resNoTarget = enqueuePeerMessage({
      ...defaultSource,
      petId: targetPetId,
      text: "hello",
      dataDir,
    });
    assert.strictEqual(resNoTarget.status, "rejected");
    assert.match(resNoTarget.reason, /target session identity is required/);

    // Passing rawSessionId / profileId without targetPetId must be rejected
    const resDeriveTarget = enqueuePeerMessage({
      ...defaultSource,
      rawSessionId: "s-alias-enq",
      profileId: "local",
      agentId: "pi",
      text: "hello",
      dataDir,
    });
    assert.strictEqual(resDeriveTarget.status, "rejected");
    assert.match(resDeriveTarget.reason, /target session identity is required/);

    // Passing sourceRawSessionId without sourcePetId must be rejected
    const resDeriveSource = enqueuePeerMessage({
      sourceRawSessionId: "s-source-1",
      sourceDisplayName: "backend",
      sourceHost: "local",
      targetPetId,
      text: "hello",
      dataDir,
    });
    assert.strictEqual(resDeriveSource.status, "rejected");
    assert.match(resDeriveSource.reason, /source session identity is required/);
  });

  it("rejects petId and rawSession aliases in claimNextPeerMessage", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-alias-claim" });
    createActiveSession(statusDir, targetPetId);

    enqueuePeerMessage({ ...defaultSource, targetPetId, text: "for claim alias test", dataDir });

    // claim with petId instead of targetPetId returns null
    const claimPetId = claimNextPeerMessage({ petId: targetPetId, dataDir });
    assert.strictEqual(claimPetId, null);

    // claim with rawSessionId instead of targetPetId returns null
    const claimRawSession = claimNextPeerMessage({ rawSessionId: "s-alias-claim", dataDir });
    assert.strictEqual(claimRawSession, null);

    // claim with targetPetId succeeds
    const claimTarget = claimNextPeerMessage({ targetPetId, dataDir });
    assert.ok(claimTarget);
  });

  it("rejects petId, commandId, and rawSession aliases in settlePeerMessage", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-alias-settle" });
    createActiveSession(statusDir, targetPetId);

    enqueuePeerMessage({ ...defaultSource, targetPetId, text: "for settle alias test", dataDir });
    const claimed = claimNextPeerMessage({ targetPetId, dataDir });
    assert.ok(claimed);

    // settle with petId instead of targetPetId is rejected
    const resPetId = settlePeerMessage({
      petId: targetPetId,
      messageId: claimed.messageId,
      claimToken: claimed.claimToken,
      status: "dispatched",
      dataDir,
    });
    assert.strictEqual(resPetId.status, "rejected");
    assert.match(resPetId.reason, /target session identity is required/);

    // settle with commandId instead of messageId is rejected
    const resCommandId = settlePeerMessage({
      targetPetId,
      commandId: claimed.messageId,
      claimToken: claimed.claimToken,
      status: "dispatched",
      dataDir,
    });
    assert.strictEqual(resCommandId.status, "rejected");
    assert.match(resCommandId.reason, /messageId is required/);
  });
});

describe("Peer Message Inbox: getPeerMessageReceipt Fail-Closed Authorization", () => {
  it("requires caller source identity and only allows receipt.sourcePetId === caller sourcePetId", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-auth-strict" });
    createActiveSession(statusDir, targetPetId);

    const enq = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "private peer message",
      dataDir,
    });
    assert.strictEqual(enq.status, "queued");

    // 1. Target cannot read receipt (fails closed)
    const targetRead = getPeerMessageReceipt({
      targetPetId,
      messageId: enq.messageId,
      dataDir,
    });
    assert.strictEqual(targetRead, null, "Target pet must NOT be able to read peer message receipt");

    // 2. Missing caller identity cannot read (fails closed)
    const noIdentityRead = getPeerMessageReceipt({
      messageId: enq.messageId,
      dataDir,
    });
    assert.strictEqual(noIdentityRead, null, "No-identity query must return null");

    // 3. Stranger source cannot read
    const strangerPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-stranger-source" });
    const strangerRead = getPeerMessageReceipt({
      sourcePetId: strangerPetId,
      messageId: enq.messageId,
      dataDir,
    });
    assert.strictEqual(strangerRead, null, "Stranger sourcePetId must return null");

    // 4. Obsolete petId alias cannot read
    const petIdAliasRead = getPeerMessageReceipt({
      petId: defaultSource.sourcePetId,
      messageId: enq.messageId,
      dataDir,
    });
    assert.strictEqual(petIdAliasRead, null, "petId alias without sourcePetId must return null");

    // 5. Authorized sourcePetId successfully reads receipt
    const authorizedRead = getPeerMessageReceipt({
      sourcePetId: defaultSource.sourcePetId,
      messageId: enq.messageId,
      dataDir,
    });
    assert.ok(authorizedRead);
    assert.strictEqual(authorizedRead.messageId, enq.messageId);
    assert.strictEqual(authorizedRead.sourcePetId, defaultSource.sourcePetId);
  });

  it("triggers stale claim cleanup during query and marks terminal failed", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-query-stale" });
    createActiveSession(statusDir, targetPetId);

    const baseTime = Date.now();
    const enq = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "will become stale claim",
      createdAtMs: baseTime,
      now: () => baseTime,
      dataDir,
    });

    const claimed = claimNextPeerMessage({ targetPetId, now: () => baseTime, dataDir });
    assert.ok(claimed);

    // Query receipt 70 seconds later (>60s claim timeout)
    const rcpt = getPeerMessageReceipt({
      sourcePetId: defaultSource.sourcePetId,
      messageId: enq.messageId,
      now: () => baseTime + 70000,
      dataDir,
    });
    assert.ok(rcpt);
    assert.strictEqual(rcpt.status, "failed");
    assert.match(rcpt.reason, /stale claimed item older than 60s \(delivery-unknown\)/);
  });

  it("terminates expired pending message to terminal expired receipt during query when consumer is disconnected", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-query-ttl" });
    createActiveSession(statusDir, targetPetId);

    const baseTime = Date.now();
    const enq = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "will expire in queue",
      createdAtMs: baseTime,
      ttlMs: 10000,
      now: () => baseTime,
      dataDir,
    });
    assert.strictEqual(enq.status, "queued");

    // Query 15 seconds later (>10s TTL) while message is still in pending queue
    const rcpt = getPeerMessageReceipt({
      sourcePetId: defaultSource.sourcePetId,
      messageId: enq.messageId,
      now: () => baseTime + 15000,
      dataDir,
    });
    assert.ok(rcpt);
    assert.strictEqual(rcpt.status, "expired");
    assert.strictEqual(rcpt.reason, "Message expired in queue before delivery");

    // Pending file must have been cleared
    const pendingDir = path.join(dataDir, "peer-inbox", targetPetId, "pending");
    const pendingFiles = fs.readdirSync(pendingDir).filter((f) => f.endsWith(".json"));
    assert.strictEqual(pendingFiles.length, 0);
  });
});

describe("Peer Message Inbox: Internal Scope of buildPeerMessageReceipt", () => {
  it("does not export buildPeerMessageReceipt from root runtime or interaction module", () => {
    assert.strictEqual(runtimeModule.buildPeerMessageReceipt, undefined, "buildPeerMessageReceipt must not be exported from root runtime");
    assert.strictEqual(interactionModule.buildPeerMessageReceipt, undefined, "buildPeerMessageReceipt must not be exported from interaction module");
  });
});

describe("Peer Message Inbox: Competing Claims & Concurrency", () => {
  it("safely handles competing claims atomically without duplicate claims", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-compete" });
    createActiveSession(statusDir, targetPetId);

    // Enqueue 5 messages
    for (let i = 0; i < 5; i++) {
      enqueuePeerMessage({
        ...defaultSource,
        targetPetId,
        text: `compete note ${i}`,
        dataDir,
      });
    }

    const claimsWorkerA = [];
    const claimsWorkerB = [];

    for (let i = 0; i < 5; i++) {
      const claimA = claimNextPeerMessage({ targetPetId, dataDir });
      if (claimA) claimsWorkerA.push(claimA.messageId);

      const claimB = claimNextPeerMessage({ targetPetId, dataDir });
      if (claimB) claimsWorkerB.push(claimB.messageId);
    }

    const allClaimed = [...claimsWorkerA, ...claimsWorkerB];
    assert.strictEqual(allClaimed.length, 5);
    const uniqueClaimed = new Set(allClaimed);
    assert.strictEqual(uniqueClaimed.size, 5, "Every claimed messageId must be unique across workers");
  });
});

describe("Peer Message Inbox: Malformed / Unsafe Pending Quarantine and Capacity Recovery", () => {
  it("quarantines malformed/unsafe files, frees 16-capacity slot, and claims valid messages", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-quarantine" });
    createActiveSession(statusDir, targetPetId);

    const pendingDir = path.join(dataDir, "peer-inbox", targetPetId, "pending");
    fs.mkdirSync(pendingDir, { recursive: true });

    // 1. Write a corrupt JSON file
    fs.writeFileSync(path.join(pendingDir, "0000000000000001-corrupt.json"), "{ invalid json", "utf8");

    // 2. Write an invalid schema file (missing provenance)
    fs.writeFileSync(
      path.join(pendingDir, "0000000000000002-invalid-schema.json"),
      JSON.stringify({ schemaVersion: "1", messageId: "invalid-schema", text: "no source info" }),
      "utf8"
    );

    // 3. Enqueue a valid peer message
    const valid = enqueuePeerMessage({
      ...defaultSource,
      targetPetId,
      text: "valid note following malformed",
      dataDir,
    });
    assert.strictEqual(valid.status, "queued");

    // Claim next: should quarantine the bad files and claim the valid message
    const claimed = claimNextPeerMessage({ targetPetId, dataDir });
    assert.ok(claimed);
    assert.strictEqual(claimed.messageId, valid.messageId);
    assert.strictEqual(claimed.text, "valid note following malformed");

    // Verify quarantine files were created
    const entries = fs.readdirSync(pendingDir);
    const quarantineFiles = entries.filter((f) => f.includes(".quarantine"));
    assert.strictEqual(quarantineFiles.length, 2);
  });
});

describe("Peer Message Inbox: User Inbox & Peer Inbox Coexistence & Isolation", () => {
  it("operates concurrently in the same data directory without interfering", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-coexist" });
    createActiveSession(statusDir, petId);

    // 1. Enqueue user message
    const userRes = enqueueUserMessage({
      petId,
      text: "user task instruction",
      commandId: "cmd_user_1",
      dataDir,
    });
    assert.strictEqual(userRes.status, "queued");

    // 2. Enqueue peer message
    const peerRes = enqueuePeerMessage({
      ...defaultSource,
      targetPetId: petId,
      text: "peer collaboration note",
      messageId: "msg_peer_1",
      dataDir,
    });
    assert.strictEqual(peerRes.status, "queued");

    // 3. User queue and peer queue are isolated
    const userClaim = claimNextUserMessage({ petId, dataDir });
    assert.ok(userClaim);
    assert.strictEqual(userClaim.commandId, "cmd_user_1");
    assert.strictEqual(userClaim.kind, "user_message");

    const peerClaim = claimNextPeerMessage({ targetPetId: petId, dataDir });
    assert.ok(peerClaim);
    assert.strictEqual(peerClaim.messageId, "msg_peer_1");
    assert.strictEqual(peerClaim.kind, "peer_message");

    // 4. Settle user and peer messages
    const userSettled = settleUserMessage({
      petId,
      commandId: userClaim.commandId,
      claimToken: userClaim.claimToken,
      status: "dispatched",
      dataDir,
    });
    assert.strictEqual(userSettled.status, "dispatched");

    const peerSettled = settlePeerMessage({
      targetPetId: petId,
      messageId: peerClaim.messageId,
      claimToken: peerClaim.claimToken,
      status: "dispatched",
      dataDir,
    });
    assert.strictEqual(peerSettled.status, "dispatched");

    // 5. Query user receipt and peer receipt
    const userRcpt = getUserMessageReceipt({ petId, commandId: "cmd_user_1", dataDir });
    assert.strictEqual(userRcpt.status, "dispatched");
    assert.strictEqual(userRcpt.kind, "user_message");

    const peerRcpt = getPeerMessageReceipt({
      sourcePetId: defaultSource.sourcePetId,
      messageId: "msg_peer_1",
      dataDir,
    });
    assert.strictEqual(peerRcpt.status, "dispatched");
    assert.strictEqual(peerRcpt.kind, "peer_message");
  });
});

describe("Peer Message Inbox: Target Pet Source Bubble & at-most-once Dispatch", () => {
  it("new dispatched settle writes exactly one expression event with target petId and bounded sanitized source wording", () => {
    const { dataDir, statusDir, eventsDir, receiptsDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-bubble-1" });
    createActiveSession(statusDir, targetPetId);

    const sourceDisplayName = "Alice Developer";
    const sourceHost = "workstation-mac";
    const peerText = "Secret peer message body that MUST NEVER appear in bubble";

    const enqueued = enqueuePeerMessage({
      sourcePetId: "pet-source-abc",
      sourceDisplayName,
      sourceHost,
      targetPetId,
      text: peerText,
      dataDir,
    });
    assert.strictEqual(enqueued.status, "queued");

    const claimed = claimNextPeerMessage({ targetPetId, dataDir });
    assert.ok(claimed);

    const settled = settlePeerMessage({
      targetPetId,
      messageId: claimed.messageId,
      claimToken: claimed.claimToken,
      status: "dispatched",
      dataDir,
    });
    assert.strictEqual(settled.status, "dispatched");

    // Verify expression event was written for targetPetId
    const eventPath = path.join(eventsDir, `event-${targetPetId}.json`);
    assert.ok(fs.existsSync(eventPath), "event file should exist");
    const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));

    assert.strictEqual(event.schemaVersion, "1");
    assert.strictEqual(event.kind, "expression");
    assert.strictEqual(event.petId, targetPetId);
    assert.strictEqual(event.payload.text, `Message from ${sourceDisplayName} @ ${sourceHost}`);
    assert.strictEqual(event.payload.speak, false);
    assert.strictEqual(event.payload.priority, 3);
    assert.strictEqual(event.payload.durationMs, 2500);

    // Verify deterministic eventId
    const expectedHash = crypto.createHash("sha256").update(claimed.messageId).digest("hex").slice(0, 40);
    const expectedEventId = `notice_${expectedHash}`;
    assert.strictEqual(event.eventId, expectedEventId);
    assert.strictEqual(expectedEventId.length, 47);
    assert.ok(expectedEventId.length <= 64);

    // Verify expression receipt was written with status delivered
    const bubbleRcptPath = path.join(receiptsDir, `rcpt-${expectedEventId}.json`);
    assert.ok(fs.existsSync(bubbleRcptPath), "bubble receipt file should exist");
    const bubbleRcpt = JSON.parse(fs.readFileSync(bubbleRcptPath, "utf8"));
    assert.strictEqual(bubbleRcpt.status, "delivered");
    assert.strictEqual(bubbleRcpt.petId, targetPetId);
    assert.strictEqual(bubbleRcpt.commandId, expectedEventId);
    assert.strictEqual(bubbleRcpt.dedupKey, expectedEventId);
    assert.strictEqual(bubbleRcpt.payloadEcho.text, `Message from ${sourceDisplayName} @ ${sourceHost}`);

    // Verify peer receipt also exists and is distinct
    const peerRcptPath = path.join(receiptsDir, `rcpt-peer-${claimed.messageId}.json`);
    assert.ok(fs.existsSync(peerRcptPath), "peer receipt should exist");
    const peerRcpt = JSON.parse(fs.readFileSync(peerRcptPath, "utf8"));
    assert.strictEqual(peerRcpt.status, "dispatched");
  });

  it("bubble sanitizes C0/C1 controls, bidi controls, collapses whitespace, clamps code points to <= 120, and falls back to Pi and local", () => {
    const { dataDir, statusDir, eventsDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-bubble-sanitize" });
    createActiveSession(statusDir, targetPetId);

    // Test 1: Bidi controls and C1 / invisible controls in provenance
    const bidiName = "\u202eEvilName\u202c \x7f\x80\x9f \t  Worker \u061C\u200E";
    const bidiHost = "  Host\u2066\u2069\u202A\u202E   Box\uFEFF  ";

    const enq1 = enqueuePeerMessage({
      sourcePetId: "pet-source-1",
      sourceDisplayName: bidiName,
      sourceHost: bidiHost,
      targetPetId,
      text: "test sanitization",
      dataDir,
    });
    assert.strictEqual(enq1.status, "queued");
    const claim1 = claimNextPeerMessage({ targetPetId, dataDir });
    assert.ok(claim1);
    settlePeerMessage({
      targetPetId,
      messageId: claim1.messageId,
      claimToken: claim1.claimToken,
      status: "dispatched",
      dataDir,
    });

    const event1 = JSON.parse(fs.readFileSync(path.join(eventsDir, `event-${targetPetId}.json`), "utf8"));
    assert.strictEqual(event1.payload.text, "Message from EvilName Worker @ Host Box");

    // Test 2: Fallbacks to Pi and local when missing, null, or all controls/empty
    const targetPetId2 = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-bubble-fallback" });
    createActiveSession(statusDir, targetPetId2);

    const claimRecord = {
      schemaVersion: "1",
      kind: "peer_message",
      messageId: "msg_fallback_1",
      dedupKey: "msg_fallback_1",
      targetPetId: targetPetId2,
      sourcePetId: "pet-fallback",
      sourceDisplayName: "\x00\x1f\u200E   \u202E",
      sourceHost: "\t  \r\n",
      text: "test fallback",
      deliverAs: "followUp",
      threadId: "thr_msg_fallback_1",
      hopCount: 0,
      maxHops: 1,
      replyHandle: null,
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60000,
      claimToken: "claim-tok-fallback",
      claimedAtMs: Date.now(),
    };
    const claimedPath = path.join(dataDir, "peer-inbox", targetPetId2, "claimed", "msg_fallback_1.json");
    fs.mkdirSync(path.dirname(claimedPath), { recursive: true });
    fs.writeFileSync(claimedPath, JSON.stringify(claimRecord), "utf8");

    settlePeerMessage({
      targetPetId: targetPetId2,
      messageId: "msg_fallback_1",
      claimToken: "claim-tok-fallback",
      status: "dispatched",
      dataDir,
    });

    const event2 = JSON.parse(fs.readFileSync(path.join(eventsDir, `event-${targetPetId2}.json`), "utf8"));
    assert.strictEqual(event2.payload.text, "Message from Pi @ local");

    // Test 3: Unicode code point clamp <= 120 with emojis
    const targetPetId3 = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-bubble-clamp" });
    createActiveSession(statusDir, targetPetId3);

    const longEmojiName = "🤖".repeat(80);
    const longEmojiHost = "🚀".repeat(80);

    const claimRecord3 = {
      ...claimRecord,
      messageId: "msg_clamp_1",
      targetPetId: targetPetId3,
      sourceDisplayName: longEmojiName,
      sourceHost: longEmojiHost,
      claimToken: "claim-tok-clamp",
    };
    const claimedPath3 = path.join(dataDir, "peer-inbox", targetPetId3, "claimed", "msg_clamp_1.json");
    fs.mkdirSync(path.dirname(claimedPath3), { recursive: true });
    fs.writeFileSync(claimedPath3, JSON.stringify(claimRecord3), "utf8");

    settlePeerMessage({
      targetPetId: targetPetId3,
      messageId: "msg_clamp_1",
      claimToken: "claim-tok-clamp",
      status: "dispatched",
      dataDir,
    });

    const event3 = JSON.parse(fs.readFileSync(path.join(eventsDir, `event-${targetPetId3}.json`), "utf8"));
    const codePoints = Array.from(event3.payload.text);
    assert.strictEqual(codePoints.length, 120);
    assert.ok(event3.payload.text.startsWith("Message from 🤖"));
  });

  it("never includes peer message body, IDs, handles, tokens, thread, or cwd in bubble text", () => {
    const { dataDir, statusDir, eventsDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-bubble-leak-check" });
    createActiveSession(statusDir, targetPetId);

    const sensitiveBody = "TOP_SECRET_SESSION_TOKEN_123456789";
    const sensitiveMsgId = "msg_sensitive_987654";
    const sensitiveThreadId = "thr_sensitive_112233";
    const sensitiveReplyHandle = "psh_sensitive_reply_handle_998877";

    const enq = enqueuePeerMessage({
      sourcePetId: "pet-source-secrets",
      sourceDisplayName: "SenderAgent",
      sourceHost: "SenderHost",
      targetPetId,
      text: sensitiveBody,
      messageId: sensitiveMsgId,
      threadId: sensitiveThreadId,
      replyHandle: sensitiveReplyHandle,
      dataDir,
    });
    const claim = claimNextPeerMessage({ targetPetId, dataDir });

    settlePeerMessage({
      targetPetId,
      messageId: sensitiveMsgId,
      claimToken: claim.claimToken,
      status: "dispatched",
      dataDir,
    });

    const event = JSON.parse(fs.readFileSync(path.join(eventsDir, `event-${targetPetId}.json`), "utf8"));
    const bubbleText = event.payload.text;

    assert.strictEqual(bubbleText, "Message from SenderAgent @ SenderHost");
    assert.strictEqual(bubbleText.includes(sensitiveBody), false, "must not leak body text");
    assert.strictEqual(bubbleText.includes(sensitiveMsgId), false, "must not leak messageId");
    assert.strictEqual(bubbleText.includes(sensitiveThreadId), false, "must not leak threadId");
    assert.strictEqual(bubbleText.includes(sensitiveReplyHandle), false, "must not leak replyHandle");
    assert.strictEqual(bubbleText.includes(claim.claimToken), false, "must not leak claimToken");
    assert.strictEqual(bubbleText.includes("pet-source-secrets"), false, "must not leak sourcePetId");
    assert.strictEqual(bubbleText.includes(targetPetId), false, "must not leak targetPetId in text");
    assert.strictEqual(bubbleText.includes(process.cwd()), false, "must not leak cwd");
  });

  it("failed or expired settlements emit NO bubble event", () => {
    const { dataDir, statusDir, eventsDir, receiptsDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-bubble-failed" });
    createActiveSession(statusDir, targetPetId);

    // 1. Failed settlement
    const enq1 = enqueuePeerMessage({ ...defaultSource, targetPetId, text: "msg failed test", dataDir });
    const claim1 = claimNextPeerMessage({ targetPetId, dataDir });
    const settleFailed = settlePeerMessage({
      targetPetId,
      messageId: claim1.messageId,
      claimToken: claim1.claimToken,
      status: "failed",
      reason: "Handler execution failed",
      dataDir,
    });
    assert.strictEqual(settleFailed.status, "failed");
    assert.strictEqual(fs.existsSync(path.join(eventsDir, `event-${targetPetId}.json`)), false, "no event on failed");

    // 2. Expired settlement
    const enq2 = enqueuePeerMessage({ ...defaultSource, targetPetId, text: "msg expired test", dataDir });
    const claim2 = claimNextPeerMessage({ targetPetId, dataDir });
    const settleExpired = settlePeerMessage({
      targetPetId,
      messageId: claim2.messageId,
      claimToken: claim2.claimToken,
      status: "expired",
      reason: "TTL expired during processing",
      dataDir,
    });
    assert.strictEqual(settleExpired.status, "expired");
    assert.strictEqual(fs.existsSync(path.join(eventsDir, `event-${targetPetId}.json`)), false, "no event on expired");

    // Verify no notice receipt was written
    const receiptFiles = fs.readdirSync(receiptsDir);
    const noticeReceipts = receiptFiles.filter((f) => f.startsWith("rcpt-notice_"));
    assert.strictEqual(noticeReceipts.length, 0);
  });

  it("at-most-once: settle retry / existing terminal receipt emits NO second callback or event", () => {
    const { dataDir, statusDir, eventsDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-bubble-dedup" });
    createActiveSession(statusDir, targetPetId);

    let callbackCount = 0;
    const customOnDispatched = () => {
      callbackCount++;
    };

    const enq = enqueuePeerMessage({ ...defaultSource, targetPetId, text: "dedup test", dataDir });
    const claim = claimNextPeerMessage({ targetPetId, dataDir });

    // Initial settlement with simulated unlink failure (claim file retained to test existing terminal receipt path)
    const claimedPath = path.join(dataDir, "peer-inbox", targetPetId, "claimed", `${claim.messageId}.json`);
    const realFs = fs;
    const retainClaimFs = {
      ...realFs,
      unlinkSync(targetPath) {
        if (targetPath === claimedPath) {
          // Simulate unlink failure / crash after receipt write
          return;
        }
        return realFs.unlinkSync(targetPath);
      },
    };

    const settle1 = settlePeerMessage({
      targetPetId,
      messageId: claim.messageId,
      claimToken: claim.claimToken,
      status: "dispatched",
      onDispatched: customOnDispatched,
      dataDir,
      fsApi: retainClaimFs,
    });
    assert.strictEqual(settle1.status, "dispatched");
    assert.strictEqual(callbackCount, 1);
    assert.strictEqual(fs.existsSync(claimedPath), true, "claim was retained");

    const eventPath = path.join(eventsDir, `event-${targetPetId}.json`);
    assert.ok(fs.existsSync(eventPath));

    // Retry settlement with existing terminal receipt on disk
    const settleRetry = settlePeerMessage({
      targetPetId,
      messageId: claim.messageId,
      claimToken: claim.claimToken,
      status: "dispatched",
      onDispatched: customOnDispatched,
      dataDir,
    });
    assert.strictEqual(settleRetry.status, "dispatched");
    assert.strictEqual(callbackCount, 1, "callback must NOT be called second time on retry");
    assert.strictEqual(fs.existsSync(claimedPath), false, "retry unlinked leftover claim");

    // Third call after claim unlinked: returns ClaimNotFound without callback
    const settleThird = settlePeerMessage({
      targetPetId,
      messageId: claim.messageId,
      claimToken: claim.claimToken,
      status: "dispatched",
      onDispatched: customOnDispatched,
      dataDir,
    });
    assert.strictEqual(settleThird.status, "rejected");
    assert.strictEqual(callbackCount, 1, "callback still not called on missing claim");
  });

  it("callback throw or rejected expression does not alter dispatched receipt", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-bubble-errors" });
    createActiveSession(statusDir, targetPetId, "idle");

    // 1. Caller onDispatched throws sync error
    const enq1 = enqueuePeerMessage({ ...defaultSource, targetPetId, text: "error test 1", dataDir });
    const claim1 = claimNextPeerMessage({ targetPetId, dataDir });

    const settle1 = settlePeerMessage({
      targetPetId,
      messageId: claim1.messageId,
      claimToken: claim1.claimToken,
      status: "dispatched",
      onDispatched: () => {
        throw new Error("Synchronous callback error simulation");
      },
      dataDir,
    });
    assert.strictEqual(settle1.status, "dispatched", "dispatched receipt must remain dispatched even if callback throws");

    // 2. Caller onDispatched returns a rejected thenable
    const enq2 = enqueuePeerMessage({ ...defaultSource, targetPetId, text: "error test 2", dataDir });
    const claim2 = claimNextPeerMessage({ targetPetId, dataDir });

    const settle2 = settlePeerMessage({
      targetPetId,
      messageId: claim2.messageId,
      claimToken: claim2.claimToken,
      status: "dispatched",
      onDispatched: () => Promise.reject(new Error("Async rejection simulation")),
      dataDir,
    });
    assert.strictEqual(settle2.status, "dispatched", "dispatched receipt must remain dispatched even if callback returns rejected promise");

    // 3. expressExpression rejects (e.g. status file missing / unknown session during bubble emission)
    const targetPetId3 = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-bubble-unknown-status" });
    createActiveSession(statusDir, targetPetId3);
    const enq3 = enqueuePeerMessage({ ...defaultSource, targetPetId: targetPetId3, text: "error test 3", dataDir });
    const claim3 = claimNextPeerMessage({ targetPetId: targetPetId3, dataDir });

    // Remove status file right before settle so expressExpression fails with UnknownPetIdentity
    fs.unlinkSync(path.join(statusDir, `status-${targetPetId3}.json`));

    const settle3 = settlePeerMessage({
      targetPetId: targetPetId3,
      messageId: claim3.messageId,
      claimToken: claim3.claimToken,
      status: "dispatched",
      dataDir,
    });
    assert.strictEqual(settle3.status, "dispatched", "peer settlement succeeds even when expression rejects");
  });

  it("core peer-inbox module exposes onDispatched seam invoked only on new dispatched receipt", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-core-seam" });
    createActiveSession(statusDir, targetPetId);

    let seamCalled = 0;
    let seamReceipt = null;

    const enq = enqueuePeerMessage({ ...defaultSource, targetPetId, text: "core seam test", dataDir });
    const claim = claimNextPeerMessage({ targetPetId, dataDir });

    const coreSettle = peerInboxModule.settlePeerMessage({
      targetPetId,
      messageId: claim.messageId,
      claimToken: claim.claimToken,
      status: "dispatched",
      onDispatched: (receipt) => {
        seamCalled++;
        seamReceipt = receipt;
      },
      dataDir,
    });

    assert.strictEqual(coreSettle.status, "dispatched");
    assert.strictEqual(seamCalled, 1);
    assert.strictEqual(seamReceipt.messageId, claim.messageId);
    assert.strictEqual(seamReceipt.status, "dispatched");

    // Retry core settle: seam must not be re-invoked
    peerInboxModule.settlePeerMessage({
      targetPetId,
      messageId: claim.messageId,
      claimToken: claim.claimToken,
      status: "dispatched",
      onDispatched: () => {
        seamCalled++;
      },
      dataDir,
    });
    assert.strictEqual(seamCalled, 1, "must not re-invoke on retry");
  });

  it("root runtime module exported settlePeerMessage is remote-compatible wrapper with huge env and PI_PET_DATA_DIR", () => {
    const { dataDir, statusDir, eventsDir, receiptsDir } = createTestEnvironment();
    const targetPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-root-export" });
    createActiveSession(statusDir, targetPetId);

    const hugeEnv = {
      PI_PET_DATA_DIR: dataDir,
      HUGE_ENV_VAR_1: "A".repeat(64 * 1024),
      HUGE_ENV_VAR_2: "B".repeat(64 * 1024),
    };

    const enq = runtimeModule.enqueuePeerMessage({
      ...defaultSource,
      sourceDisplayName: "RemotePi",
      sourceHost: "coordinator-ssh",
      targetPetId,
      text: "remote wrapper test",
      env: hugeEnv,
    });
    assert.strictEqual(enq.status, "queued");

    const claim = runtimeModule.claimNextPeerMessage({ targetPetId, env: hugeEnv });
    assert.ok(claim);

    const settled = runtimeModule.settlePeerMessage({
      targetPetId,
      messageId: claim.messageId,
      claimToken: claim.claimToken,
      status: "dispatched",
      env: hugeEnv,
    });

    assert.strictEqual(settled.status, "dispatched");

    // Verify source bubble expression event was written via env.PI_PET_DATA_DIR resolution
    const eventPath = path.join(eventsDir, `event-${targetPetId}.json`);
    assert.ok(fs.existsSync(eventPath), "bubble event file should exist");
    const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
    assert.strictEqual(event.payload.text, "Message from RemotePi @ coordinator-ssh");

    // Verify bubble expression receipt was written with delivered status
    const expectedHash = crypto.createHash("sha256").update(claim.messageId).digest("hex").slice(0, 40);
    const bubbleRcptPath = path.join(receiptsDir, `rcpt-notice_${expectedHash}.json`);
    assert.ok(fs.existsSync(bubbleRcptPath), "bubble receipt file should exist");
    const bubbleRcpt = JSON.parse(fs.readFileSync(bubbleRcptPath, "utf8"));
    assert.strictEqual(bubbleRcpt.status, "delivered");
  });
});
