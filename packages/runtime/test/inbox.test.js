"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  CLAIM_TIMEOUT_MS,
  DEFAULT_USER_MESSAGE_TTL_MS,
  MAX_INBOX_QUEUE_CAPACITY,
  MAX_USER_MESSAGE_TTL_MS,
  MIN_USER_MESSAGE_TTL_MS,
  claimNextUserMessage,
  derivePetId,
  enqueueUserMessage,
  expressExpression,
  settleUserMessage,
} = require("..");

const temporaryDirs = [];

afterEach(() => {
  while (temporaryDirs.length) {
    fs.rmSync(temporaryDirs.pop(), { recursive: true, force: true });
  }
});

function createTestEnvironment() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-test-inbox-"));
  temporaryDirs.push(dataDir);
  const statusDir = path.join(dataDir, "status");
  const receiptsDir = path.join(dataDir, "receipts");
  fs.mkdirSync(statusDir, { recursive: true });
  fs.mkdirSync(receiptsDir, { recursive: true });
  return { dataDir, statusDir, receiptsDir };
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

describe("User Message Inbox: Validation", () => {
  it("rejects non-object options or null", () => {
    assert.strictEqual(enqueueUserMessage(null).status, "rejected");
    assert.strictEqual(enqueueUserMessage(undefined).status, "rejected");
    assert.strictEqual(enqueueUserMessage("hello").status, "rejected");
    assert.strictEqual(enqueueUserMessage([]).status, "rejected");
  });

  it("rejects payloads exceeding 16 KiB", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-oversize" });
    createActiveSession(statusDir, petId);

    const oversizedText = "x".repeat(17000);
    const result = enqueueUserMessage({
      petId,
      text: oversizedText,
      dataDir,
    });
    assert.strictEqual(result.status, "rejected");
    assert.match(result.reason, /16 KiB/);
  });

  it("allows enqueueing tiny valid message even when huge env is injected", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-huge-env" });
    createActiveSession(statusDir, petId);

    const hugeEnv = {
      HUGE_VAR: "A".repeat(64 * 1024), // 64 KiB
      OTHER_VAR: "B".repeat(64 * 1024),
    };

    const result = enqueueUserMessage({
      petId,
      text: "hello world",
      dataDir,
      env: hugeEnv,
    });
    assert.strictEqual(result.status, "queued");
    assert.strictEqual(result.text, "hello world");
    assert.strictEqual(result.petId, petId);
  });

  it("rejects missing, empty, or oversized text", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-text-val" });
    createActiveSession(statusDir, petId);

    // Missing text
    const missing = enqueueUserMessage({ petId, dataDir });
    assert.strictEqual(missing.status, "rejected");
    assert.match(missing.reason, /text must be a string/);

    // Empty text
    const empty = enqueueUserMessage({ petId, text: "", dataDir });
    assert.strictEqual(empty.status, "rejected");
    assert.match(empty.reason, /text length must be between 1 and 2000/);

    // Non-string text
    const nonString = enqueueUserMessage({ petId, text: 12345, dataDir });
    assert.strictEqual(nonString.status, "rejected");
    assert.match(nonString.reason, /text must be a string/);

    // Oversized text (>2000 chars)
    const tooLong = enqueueUserMessage({ petId, text: "a".repeat(2001), dataDir });
    assert.strictEqual(tooLong.status, "rejected");
    assert.match(tooLong.reason, /text length must be between 1 and 2000/);
  });

  it("rejects invalid deliverAs value", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-deliveras" });
    createActiveSession(statusDir, petId);

    const result = enqueueUserMessage({
      petId,
      text: "hello",
      deliverAs: "direct",
      dataDir,
    });
    assert.strictEqual(result.status, "rejected");
    assert.match(result.reason, /deliverAs must be 'followUp'/);
  });

  it("validates TTL limits (1s..300s, default 60s) and canonical queued status", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-ttl-val" });
    createActiveSession(statusDir, petId);

    // Under 1s ttlMs
    const under = enqueueUserMessage({ petId, text: "hi", ttlMs: 500, dataDir });
    assert.strictEqual(under.status, "rejected");
    assert.match(under.reason, /ttlMs must be a number between 1000 and 300000/);

    // Over 300s ttlMs
    const over = enqueueUserMessage({ petId, text: "hi", ttlMs: 400000, dataDir });
    assert.strictEqual(over.status, "rejected");
    assert.match(over.reason, /ttlMs must be a number between 1000 and 300000/);

    // Valid custom ttlMs: returns canonical 'queued' status
    const valid = enqueueUserMessage({ petId, text: "hi", ttlMs: 120000, dataDir });
    assert.strictEqual(valid.status, "queued");
    assert.strictEqual(valid.expiresAtMs - valid.createdAtMs, 120000);

    // Valid default TTL (60s): returns canonical 'queued' status
    const defTtl = enqueueUserMessage({ petId, text: "hi default ttl", dataDir });
    assert.strictEqual(defTtl.status, "queued");
    assert.strictEqual(defTtl.expiresAtMs - defTtl.createdAtMs, DEFAULT_USER_MESSAGE_TTL_MS);
  });

  it("removes unsupported ttl seconds alias; wire contract only ttlMs", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-ttl-seconds" });
    createActiveSession(statusDir, petId);

    // Passing ttl: 5 without ttlMs should use default 60s ttlMs (not 5s)
    const res = enqueueUserMessage({
      petId,
      text: "hello wire contract",
      ttl: 5,
      dataDir,
    });
    assert.strictEqual(res.status, "queued");
    assert.strictEqual(res.expiresAtMs - res.createdAtMs, DEFAULT_USER_MESSAGE_TTL_MS);
  });

  it("validates commandId and dedupKey characters and length", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-ids" });
    createActiveSession(statusDir, petId);

    // Invalid chars in commandId
    const badCmdId = enqueueUserMessage({
      petId,
      text: "hi",
      commandId: "bad id with spaces!",
      dataDir,
    });
    assert.strictEqual(badCmdId.status, "rejected");
    assert.match(badCmdId.reason, /commandId/);

    // Invalid chars in dedupKey
    const badDedupKey = enqueueUserMessage({
      petId,
      text: "hi",
      dedupKey: "bad/key@123",
      dataDir,
    });
    assert.strictEqual(badDedupKey.status, "rejected");
    assert.match(badDedupKey.reason, /dedupKey/);

    // Too long (>64 chars)
    const longId = "a".repeat(65);
    const tooLongCmd = enqueueUserMessage({ petId, text: "hi", commandId: longId, dataDir });
    assert.strictEqual(tooLongCmd.status, "rejected");
  });

  it("rejects invalid or path-traversal petId", () => {
    const { dataDir } = createTestEnvironment();

    const traversal = enqueueUserMessage({
      petId: "../../etc/passwd",
      text: "hi",
      dataDir,
    });
    assert.strictEqual(traversal.status, "rejected");
    assert.match(traversal.reason, /InvalidPetIdentity/);

    const missingIdentity = enqueueUserMessage({
      text: "hi",
      dataDir,
    });
    assert.strictEqual(missingIdentity.status, "rejected");
    assert.match(missingIdentity.reason, /InvalidPetIdentity/);
  });
});

describe("User Message Inbox: Unknown / Offline / Closed Session Status", () => {
  it("rejects when status file is missing (unknown identity)", () => {
    const { dataDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "nonexistent" });

    const result = enqueueUserMessage({
      petId,
      text: "Hello pet",
      dataDir,
    });
    assert.strictEqual(result.status, "rejected");
    assert.match(result.reason, /UnknownPetIdentity/);
  });

  it("rejects when session is offline", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-offline" });
    createActiveSession(statusDir, petId, "offline");

    const result = enqueueUserMessage({
      petId,
      text: "Hello pet",
      dataDir,
    });
    assert.strictEqual(result.status, "rejected");
    assert.match(result.reason, /SessionOffline/);
  });

  it("rejects when session is closed", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-closed" });
    createActiveSession(statusDir, petId, "closed");

    const result = enqueueUserMessage({
      petId,
      text: "Hello pet",
      dataDir,
    });
    assert.strictEqual(result.status, "rejected");
    assert.match(result.reason, /SessionClosed/);
  });

  it("accepts when session is in active states (idle, thinking, running)", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    for (const state of ["idle", "thinking", "reading", "editing", "searching", "running"]) {
      const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: `s-state-${state}` });
      createActiveSession(statusDir, petId, state);

      const result = enqueueUserMessage({
        petId,
        text: `Message in state ${state}`,
        dataDir,
      });
      assert.strictEqual(result.status, "queued", `Failed for active state: ${state}`);
    }
  });
});

describe("User Message Inbox: FIFO Queue Ordering", () => {
  it("claims messages in strict FIFO order and returns null when empty", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-fifo" });
    createActiveSession(statusDir, petId);

    const t0 = Date.now();
    const msg1 = enqueueUserMessage({
      petId,
      text: "Message One",
      commandId: "cmd-001",
      createdAtMs: t0 + 100,
      now: () => t0,
      dataDir,
    });
    const msg2 = enqueueUserMessage({
      petId,
      text: "Message Two",
      commandId: "cmd-002",
      createdAtMs: t0 + 200,
      now: () => t0,
      dataDir,
    });
    const msg3 = enqueueUserMessage({
      petId,
      text: "Message Three",
      commandId: "cmd-003",
      createdAtMs: t0 + 300,
      now: () => t0,
      dataDir,
    });

    assert.strictEqual(msg1.status, "queued");
    assert.strictEqual(msg2.status, "queued");
    assert.strictEqual(msg3.status, "queued");

    // Claim 1: should be Message One
    const claim1 = claimNextUserMessage({ petId, dataDir, now: () => t0 + 400 });
    assert.ok(claim1);
    assert.strictEqual(claim1.commandId, "cmd-001");
    assert.strictEqual(claim1.text, "Message One");
    assert.strictEqual(claim1.deliverAs, "followUp");
    assert.ok(claim1.claimToken);

    // Claim 2: should be Message Two
    const claim2 = claimNextUserMessage({ petId, dataDir, now: () => t0 + 400 });
    assert.ok(claim2);
    assert.strictEqual(claim2.commandId, "cmd-002");
    assert.strictEqual(claim2.text, "Message Two");
    assert.strictEqual(claim2.deliverAs, "followUp");

    // Claim 3: should be Message Three
    const claim3 = claimNextUserMessage({ petId, dataDir, now: () => t0 + 400 });
    assert.ok(claim3);
    assert.strictEqual(claim3.commandId, "cmd-003");
    assert.strictEqual(claim3.text, "Message Three");
    assert.strictEqual(claim3.deliverAs, "followUp");

    // Claim 4: queue is empty -> null
    const claim4 = claimNextUserMessage({ petId, dataDir, now: () => t0 + 400 });
    assert.strictEqual(claim4, null);
  });
});

describe("User Message Inbox: Deduplication & Receipt Separation", () => {
  it("deduplicates same (petId, dedupKey) and preserves original receipt without re-enqueueing", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-dedup" });
    createActiveSession(statusDir, petId);

    const first = enqueueUserMessage({
      petId,
      text: "First turn message",
      dedupKey: "turn-100",
      dataDir,
    });
    assert.strictEqual(first.status, "queued");
    assert.strictEqual(first.dedupKey, "turn-100");

    // Resubmit same dedupKey with different text
    const second = enqueueUserMessage({
      petId,
      text: "Different text attempt",
      dedupKey: "turn-100",
      dataDir,
    });
    assert.strictEqual(second.status, "queued");
    assert.strictEqual(second.commandId, first.commandId);
    assert.strictEqual(second.text, "First turn message");

    // Check that pending directory has only 1 file
    const pendingDir = path.join(dataDir, "inbox", petId, "pending");
    const pendingFiles = fs.readdirSync(pendingDir).filter((f) => f.endsWith(".json"));
    assert.strictEqual(pendingFiles.length, 1);

    // Claim the message
    const claim = claimNextUserMessage({ petId, dataDir });
    assert.ok(claim);
    assert.strictEqual(claim.commandId, first.commandId);

    // Settle the message
    const settle = settleUserMessage({
      petId,
      commandId: claim.commandId,
      claimToken: claim.claimToken,
      status: "dispatched",
      dataDir,
    });
    assert.strictEqual(settle.status, "dispatched");

    // Resubmit after settle -> returns settled receipt
    const third = enqueueUserMessage({
      petId,
      text: "Yet another text",
      dedupKey: "turn-100",
      dataDir,
    });
    assert.strictEqual(third.status, "dispatched");
    assert.strictEqual(third.commandId, first.commandId);
  });

  it("does not confuse user-message receipts with expression receipts", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-separation" });
    createActiveSession(statusDir, petId);

    // Emit an expression with dedupKey "key-shared"
    const expr = expressExpression({
      petId,
      text: "Expression message",
      emotion: "happy",
      dedupKey: "key-shared",
      dataDir,
    });
    assert.strictEqual(expr.status, "delivered");

    // Enqueue a user message with the same dedupKey "key-shared"
    const userMsg = enqueueUserMessage({
      petId,
      text: "User message with same key",
      dedupKey: "key-shared",
      dataDir,
    });
    assert.strictEqual(userMsg.status, "queued");
    assert.strictEqual(userMsg.text, "User message with same key");
    assert.notStrictEqual(userMsg.commandId, expr.commandId);

    // Claim and verify it's the user message
    const claim = claimNextUserMessage({ petId, dataDir });
    assert.ok(claim);
    assert.strictEqual(claim.text, "User message with same key");
  });

  it("enqueue receipt scan only inspects/GCs rcpt-user-* and rejects CommandIdConflict across pets", () => {
    const { dataDir, statusDir, receiptsDir } = createTestEnvironment();
    const petIdA = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-pet-a" });
    const petIdB = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-pet-b" });
    createActiveSession(statusDir, petIdA);
    createActiveSession(statusDir, petIdB);

    const now = Date.now();
    // 1. Create an old expression receipt (>24h old)
    const oldExprRcptPath = path.join(receiptsDir, "rcpt-old-expr.json");
    fs.writeFileSync(
      oldExprRcptPath,
      JSON.stringify({
        schemaVersion: "1",
        commandId: "old-expr",
        petId: petIdA,
        status: "delivered",
        createdAtMs: now - 30 * 60 * 60 * 1000,
        updatedAtMs: now - 30 * 60 * 60 * 1000,
      })
    );

    // 2. Create an existing user receipt for petIdA
    const conflictCmdId = "cmd-shared-id-123";
    const userRcptPath = path.join(receiptsDir, `rcpt-user-${conflictCmdId}.json`);
    fs.writeFileSync(
      userRcptPath,
      JSON.stringify({
        schemaVersion: "1",
        kind: "user_message",
        commandId: conflictCmdId,
        dedupKey: "dedup-a",
        petId: petIdA,
        status: "queued",
        createdAtMs: now,
        updatedAtMs: now,
      })
    );

    // 3. Enqueue user message for petIdB with the same commandId
    const conflictRes = enqueueUserMessage({
      petId: petIdB,
      text: "Trying same commandId on pet B",
      commandId: conflictCmdId,
      now: () => now,
      dataDir,
    });

    // Must return rejected CommandIdConflict rather than pet A's receipt
    assert.strictEqual(conflictRes.status, "rejected");
    assert.match(conflictRes.reason, /CommandIdConflict/);

    // 4. Verify old expression receipt was NEVER touched / deleted by enqueueUserMessage
    assert.ok(fs.existsSync(oldExprRcptPath), "Expression receipt must not be deleted by enqueue scan");
  });
});

describe("User Message Inbox: TTL and Stale Message Handling", () => {
  it("expires stale message at ingestion without writing to pending queue", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-ttl-ingest" });
    createActiveSession(statusDir, petId);

    const now = Date.now();
    const staleCreatedAt = now - 70000; // 70s ago
    const ttlMs = 60000; // 60s TTL -> expired 10s ago

    const result = enqueueUserMessage({
      petId,
      text: "Stale at arrival",
      createdAtMs: staleCreatedAt,
      ttlMs,
      now: () => now,
      dataDir,
    });

    assert.strictEqual(result.status, "expired");
    assert.match(result.reason, /expired/i);

    // Pending directory should be empty
    const pendingDir = path.join(dataDir, "inbox", petId, "pending");
    if (fs.existsSync(pendingDir)) {
      const files = fs.readdirSync(pendingDir).filter((f) => f.endsWith(".json"));
      assert.strictEqual(files.length, 0);
    }
  });

  it("skips and expires stale messages in queue during claimNext", () => {
    const { dataDir, statusDir, receiptsDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-ttl-claim" });
    createActiveSession(statusDir, petId);

    const t0 = Date.now();

    // Enqueue message 1: short TTL (5s)
    const msg1 = enqueueUserMessage({
      petId,
      text: "Message 1 (short lived)",
      commandId: "cmd-short",
      createdAtMs: t0,
      ttlMs: 5000,
      now: () => t0,
      dataDir,
    });
    assert.strictEqual(msg1.status, "queued");

    // Enqueue message 2: normal TTL (60s)
    const msg2 = enqueueUserMessage({
      petId,
      text: "Message 2 (long lived)",
      commandId: "cmd-long",
      createdAtMs: t0 + 1000,
      ttlMs: 60000,
      now: () => t0 + 1000,
      dataDir,
    });
    assert.strictEqual(msg2.status, "queued");

    // Advance time past message 1's expiration (t0 + 10s)
    const claimTime = t0 + 10000;
    const claim = claimNextUserMessage({ petId, dataDir, now: () => claimTime });

    // claimNext should skip expired message 1 and claim message 2
    assert.ok(claim);
    assert.strictEqual(claim.commandId, "cmd-long");
    assert.strictEqual(claim.text, "Message 2 (long lived)");

    // Verify message 1 receipt was marked expired
    const rcpt1Path = path.join(receiptsDir, "rcpt-user-cmd-short.json");
    assert.ok(fs.existsSync(rcpt1Path));
    const rcpt1 = JSON.parse(fs.readFileSync(rcpt1Path, "utf8"));
    assert.strictEqual(rcpt1.status, "expired");
  });
});

describe("User Message Inbox: Queue Capacity (Cap at 32)", () => {
  it("caps pending + claimed at 32 and rejects newest messages", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-cap" });
    createActiveSession(statusDir, petId);

    // Enqueue 32 messages
    for (let i = 0; i < MAX_INBOX_QUEUE_CAPACITY; i++) {
      const res = enqueueUserMessage({
        petId,
        text: `Message ${i}`,
        commandId: `cmd-cap-${i}`,
        dataDir,
      });
      assert.strictEqual(res.status, "queued", `Failed to enqueue message ${i}`);
    }

    // 33rd message should be rejected
    const rejected33 = enqueueUserMessage({
      petId,
      text: "Message 33 (should reject)",
      commandId: "cmd-cap-33",
      dataDir,
    });
    assert.strictEqual(rejected33.status, "rejected");
    assert.match(rejected33.reason, /QueueCapacityExceeded/);

    // Claim 2 messages (now 30 pending, 2 claimed = 32 total)
    const claim1 = claimNextUserMessage({ petId, dataDir });
    const claim2 = claimNextUserMessage({ petId, dataDir });
    assert.ok(claim1);
    assert.ok(claim2);

    // Enqueue should STILL be rejected because pending + claimed = 32
    const rejected34 = enqueueUserMessage({
      petId,
      text: "Message 34 (still full)",
      commandId: "cmd-cap-34",
      dataDir,
    });
    assert.strictEqual(rejected34.status, "rejected");
    assert.match(rejected34.reason, /QueueCapacityExceeded/);

    // Settle claim 1 as dispatched (now 30 pending, 1 claimed = 31 total)
    const settle1 = settleUserMessage({
      petId,
      commandId: claim1.commandId,
      claimToken: claim1.claimToken,
      status: "dispatched",
      dataDir,
    });
    assert.strictEqual(settle1.status, "dispatched");

    // Enqueue should now succeed!
    const accepted35 = enqueueUserMessage({
      petId,
      text: "Message 35 (now room available)",
      commandId: "cmd-cap-35",
      dataDir,
    });
    assert.strictEqual(accepted35.status, "queued");
  });
});

describe("User Message Inbox: Claim Token and Settlement", () => {
  it("requires valid claimToken in settleUserMessage and rejects bad tokens", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-settle-val" });
    createActiveSession(statusDir, petId);

    enqueueUserMessage({
      petId,
      text: "Token test message",
      commandId: "cmd-token-01",
      dataDir,
    });

    const claim = claimNextUserMessage({ petId, dataDir });
    assert.ok(claim);
    assert.strictEqual(claim.commandId, "cmd-token-01");
    const validToken = claim.claimToken;

    // Missing claimToken
    const missingToken = settleUserMessage({
      petId,
      commandId: "cmd-token-01",
      status: "dispatched",
      dataDir,
    });
    assert.strictEqual(missingToken.status, "rejected");
    assert.match(missingToken.reason, /claimToken is required/);

    // Wrong claimToken
    const wrongToken = settleUserMessage({
      petId,
      commandId: "cmd-token-01",
      claimToken: "wrong-uuid-token",
      status: "dispatched",
      dataDir,
    });
    assert.strictEqual(wrongToken.status, "rejected");
    assert.match(wrongToken.reason, /InvalidClaimToken/);

    // Disallow "delivered" status
    const badStatus = settleUserMessage({
      petId,
      commandId: "cmd-token-01",
      claimToken: validToken,
      status: "delivered",
      dataDir,
    });
    assert.strictEqual(badStatus.status, "rejected");
    assert.match(badStatus.reason, /Invalid settle status 'delivered'/);

    // Valid settle with "dispatched"
    const settled = settleUserMessage({
      petId,
      commandId: "cmd-token-01",
      claimToken: validToken,
      status: "dispatched",
      dataDir,
    });
    assert.strictEqual(settled.status, "dispatched");
    assert.strictEqual(settled.commandId, "cmd-token-01");
    assert.strictEqual(settled.text, "Token test message");
    assert.strictEqual(settled.deliverAs, "followUp");
  });

  it("allows settling to failed or expired statuses with optional reason", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-fail-expire" });
    createActiveSession(statusDir, petId);

    enqueueUserMessage({
      petId,
      text: "Failed test",
      commandId: "cmd-fail-01",
      dataDir,
    });

    const claim = claimNextUserMessage({ petId, dataDir });
    assert.ok(claim);

    const settledFail = settleUserMessage({
      petId,
      commandId: "cmd-fail-01",
      claimToken: claim.claimToken,
      status: "failed",
      reason: "Renderer unreachable",
      dataDir,
    });
    assert.strictEqual(settledFail.status, "failed");
    assert.strictEqual(settledFail.reason, "Renderer unreachable");
  });

  it("rejects settle when no active claim exists", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-no-claim" });
    createActiveSession(statusDir, petId);

    const result = settleUserMessage({
      petId,
      commandId: "cmd-nonexistent",
      claimToken: crypto.randomUUID(),
      status: "dispatched",
      dataDir,
    });
    assert.strictEqual(result.status, "rejected");
    assert.match(result.reason, /ClaimNotFound/);
  });
});

describe("User Message Inbox: Stale Claimed Items and No Replay", () => {
  it("marks stale claimed items older than 60s as terminal failed/delivery-unknown and never requeues", () => {
    const { dataDir, statusDir, receiptsDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-stale-claim" });
    createActiveSession(statusDir, petId);

    const t0 = Date.now();

    enqueueUserMessage({
      petId,
      text: "Stale claim message",
      commandId: "cmd-stale-claim",
      createdAtMs: t0,
      now: () => t0,
      dataDir,
    });

    // Claim at t0
    const claim = claimNextUserMessage({ petId, dataDir, now: () => t0 });
    assert.ok(claim);
    assert.strictEqual(claim.commandId, "cmd-stale-claim");

    // Advance time past 60s claim timeout (e.g. t0 + 65s)
    const tExpired = t0 + CLAIM_TIMEOUT_MS + 5000;

    // A subsequent claimNext cleans up stale claims
    const nextClaim = claimNextUserMessage({ petId, dataDir, now: () => tExpired });
    assert.strictEqual(nextClaim, null); // Nothing to claim

    // Verify claimed directory is empty
    const claimedDir = path.join(dataDir, "inbox", petId, "claimed");
    const claimedFiles = fs.readdirSync(claimedDir).filter((f) => f.endsWith(".json"));
    assert.strictEqual(claimedFiles.length, 0);

    // Verify pending directory is empty (NEVER requeued!)
    const pendingDir = path.join(dataDir, "inbox", petId, "pending");
    const pendingFiles = fs.readdirSync(pendingDir).filter((f) => f.endsWith(".json"));
    assert.strictEqual(pendingFiles.length, 0);

    // Verify receipt was marked terminal failed
    const rcptPath = path.join(receiptsDir, "rcpt-user-cmd-stale-claim.json");
    assert.ok(fs.existsSync(rcptPath));
    const rcpt = JSON.parse(fs.readFileSync(rcptPath, "utf8"));
    assert.strictEqual(rcpt.status, "failed");
    assert.match(rcpt.reason, /delivery-unknown/);

    // Resubmitting same dedup returns the terminal failed receipt
    const resubmit = enqueueUserMessage({
      petId,
      text: "Stale claim message resubmitted",
      commandId: "cmd-stale-claim",
      now: () => tExpired,
      dataDir,
    });
    assert.strictEqual(resubmit.status, "failed");
  });
});

describe("User Message Inbox: Competing Claims & Concurrency", () => {
  it("safely handles competing claims atomically without duplicate claims", async () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-competing" });
    createActiveSession(statusDir, petId);

    const t0 = Date.now();
    const messageCount = 10;
    for (let i = 0; i < messageCount; i++) {
      enqueueUserMessage({
        petId,
        text: `Concurrent message ${i}`,
        commandId: `cmd-concurrent-${i}`,
        createdAtMs: t0 + i * 10,
        now: () => t0,
        dataDir,
      });
    }

    // Run 10 parallel claimNextUserMessage calls
    const claimPromises = [];
    for (let i = 0; i < messageCount; i++) {
      claimPromises.push(
        Promise.resolve().then(() => claimNextUserMessage({ petId, dataDir, now: () => t0 + 1000 }))
      );
    }

    const claims = await Promise.all(claimPromises);
    const validClaims = claims.filter(Boolean);
    assert.strictEqual(validClaims.length, messageCount);

    // All claimed commandIds and tokens must be unique
    const claimedCommandIds = new Set(validClaims.map((c) => c.commandId));
    const claimTokens = new Set(validClaims.map((c) => c.claimToken));
    assert.strictEqual(claimedCommandIds.size, messageCount);
    assert.strictEqual(claimTokens.size, messageCount);

    // Next claim should return null
    assert.strictEqual(claimNextUserMessage({ petId, dataDir, now: () => t0 + 1000 }), null);
  });
});

describe("User Message Inbox: Required Fixes & Regressions", () => {
  it("(1) canonical initial status is 'queued', persisted and in-memory", () => {
    const { dataDir, statusDir, receiptsDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-canonical-queued" });
    createActiveSession(statusDir, petId);

    const res = enqueueUserMessage({
      petId,
      text: "Testing canonical status name",
      commandId: "cmd-canonical-1",
      dataDir,
    });

    // In-memory status is 'queued'
    assert.strictEqual(res.status, "queued");

    // Persisted receipt on disk has status 'queued'
    const rcptPath = path.join(receiptsDir, "rcpt-user-cmd-canonical-1.json");
    assert.ok(fs.existsSync(rcptPath));
    const diskRcpt = JSON.parse(fs.readFileSync(rcptPath, "utf8"));
    assert.strictEqual(diskRcpt.status, "queued");
  });

  it("(4) if pending write succeeds but receipt write fails, deletes pending before returning failed", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-receipt-fail" });
    createActiveSession(statusDir, petId);

    const pendingDir = path.join(dataDir, "inbox", petId, "pending");

    // Create a mock fsApi that succeeds on pending write but throws on receipt write
    const customFsApi = {
      ...fs,
      writeFileSync(filePath, data, encoding) {
        if (typeof filePath === "string" && filePath.includes("rcpt-user-")) {
          throw new Error("Disk full while writing receipt");
        }
        return fs.writeFileSync(filePath, data, encoding);
      },
    };

    const res = enqueueUserMessage({
      petId,
      text: "Simulated receipt failure",
      commandId: "cmd-rcpt-fail",
      dataDir,
      fsApi: customFsApi,
    });

    assert.strictEqual(res.status, "failed");
    assert.match(res.reason, /Disk full while writing receipt/);

    // Pending directory should be clean (pending file unlinked upon failure)
    if (fs.existsSync(pendingDir)) {
      const pendingFiles = fs.readdirSync(pendingDir).filter((f) => f.endsWith(".json"));
      assert.strictEqual(pendingFiles.length, 0);
    }
  });

  it("(5) eliminates orphan claim temp window; direct rename to claimed/<commandId>.json; crash before metadata", () => {
    const { dataDir, statusDir, receiptsDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-no-orphan" });
    createActiveSession(statusDir, petId);

    const t0 = Date.now();
    enqueueUserMessage({
      petId,
      text: "Claim test message",
      commandId: "cmd-direct-claim",
      createdAtMs: t0,
      now: () => t0,
      dataDir,
    });

    const claimedDir = path.join(dataDir, "inbox", petId, "claimed");

    // Normal claim: verify direct rename without temp files
    const claim = claimNextUserMessage({ petId, dataDir, now: () => t0 });
    assert.ok(claim);
    assert.strictEqual(claim.commandId, "cmd-direct-claim");

    const claimedFiles = fs.readdirSync(claimedDir);
    assert.deepStrictEqual(claimedFiles, ["cmd-direct-claim.json"]);
    assert.ok(!claimedFiles.some((f) => f.includes(".tmp")), "No temp files in claimed directory");

    // Simulate crash before metadata write: directly write a raw pending message into claimed/<id>.json
    const crashCmdId = "cmd-crash-before-meta";
    const crashClaimedPath = path.join(claimedDir, `${crashCmdId}.json`);
    fs.writeFileSync(
      crashClaimedPath,
      JSON.stringify({
        schemaVersion: "1",
        kind: "user_message",
        commandId: crashCmdId,
        dedupKey: "crash-key",
        petId,
        text: "Crash message without claimToken",
        deliverAs: "followUp",
        createdAtMs: t0,
        expiresAtMs: t0 + 60000,
      })
    );

    // Advance time > 60s
    const tStale = t0 + CLAIM_TIMEOUT_MS + 5000;
    const nextClaim = claimNextUserMessage({ petId, dataDir, now: () => tStale });
    assert.strictEqual(nextClaim, null);

    // Direct claimed file should be unlinked and terminal-failed without replaying
    assert.ok(!fs.existsSync(crashClaimedPath));
    const pendingDir = path.join(dataDir, "inbox", petId, "pending");
    const pendingFiles = fs.existsSync(pendingDir) ? fs.readdirSync(pendingDir).filter((f) => f.endsWith(".json")) : [];
    assert.strictEqual(pendingFiles.length, 0, "Must never requeue/replay direct claimed file");

    const crashRcptPath = path.join(receiptsDir, `rcpt-user-${crashCmdId}.json`);
    assert.ok(fs.existsSync(crashRcptPath));
    const crashRcpt = JSON.parse(fs.readFileSync(crashRcptPath, "utf8"));
    assert.strictEqual(crashRcpt.status, "failed");
  });

  it("(6) stale cleanup removes leftover claim without downgrading existing terminal user receipt", () => {
    const { dataDir, statusDir, receiptsDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-no-downgrade" });
    createActiveSession(statusDir, petId);

    const t0 = Date.now();
    const cmdId = "cmd-terminal-dispatched";
    const claimedDir = path.join(dataDir, "inbox", petId, "claimed");
    fs.mkdirSync(claimedDir, { recursive: true });

    // Leftover claim file older than 60s
    const claimedFilePath = path.join(claimedDir, `${cmdId}.json`);
    fs.writeFileSync(
      claimedFilePath,
      JSON.stringify({
        schemaVersion: "1",
        kind: "user_message",
        commandId: cmdId,
        dedupKey: "dedup-terminal",
        petId,
        text: "Leftover claim",
        deliverAs: "followUp",
        claimToken: "token-leftover",
        claimedAtMs: t0,
        createdAtMs: t0,
        expiresAtMs: t0 + 120000,
      })
    );

    // Terminal user receipt already exists on disk with status 'dispatched'
    const rcptPath = path.join(receiptsDir, `rcpt-user-${cmdId}.json`);
    fs.writeFileSync(
      rcptPath,
      JSON.stringify({
        schemaVersion: "1",
        kind: "user_message",
        commandId: cmdId,
        dedupKey: "dedup-terminal",
        petId,
        status: "dispatched",
        reason: null,
        text: "Leftover claim",
        deliverAs: "followUp",
        createdAtMs: t0,
        updatedAtMs: t0 + 1000,
      })
    );

    // Advance time > 60s and run stale cleanup via claimNextUserMessage
    const tStale = t0 + CLAIM_TIMEOUT_MS + 5000;
    const claimRes = claimNextUserMessage({ petId, dataDir, now: () => tStale });
    assert.strictEqual(claimRes, null);

    // Leftover claim file must be removed
    assert.ok(!fs.existsSync(claimedFilePath), "Leftover claim file should be removed");

    // Existing terminal receipt MUST NOT be downgraded or overwritten to 'failed'
    const preservedRcpt = JSON.parse(fs.readFileSync(rcptPath, "utf8"));
    assert.strictEqual(preservedRcpt.status, "dispatched", "Terminal receipt must remain dispatched");
  });

  it("(6) normal settle leaves claim if receipt write fails", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-settle-io-fail" });
    createActiveSession(statusDir, petId);

    const enq = enqueueUserMessage({
      petId,
      text: "Settle write fail test",
      commandId: "cmd-settle-io-fail",
      dataDir,
    });
    assert.strictEqual(enq.status, "queued");

    const claim = claimNextUserMessage({ petId, dataDir });
    assert.ok(claim);

    const claimedDir = path.join(dataDir, "inbox", petId, "claimed");
    const claimedFilePath = path.join(claimedDir, "cmd-settle-io-fail.json");
    assert.ok(fs.existsSync(claimedFilePath));

    // Custom fsApi that throws when writing the settled receipt
    const customFsApi = {
      ...fs,
      writeFileSync(filePath, data, encoding) {
        if (typeof filePath === "string" && filePath.includes("rcpt-user-")) {
          throw new Error("Write receipt failed during settle");
        }
        return fs.writeFileSync(filePath, data, encoding);
      },
    };

    const settleRes = settleUserMessage({
      petId,
      commandId: claim.commandId,
      claimToken: claim.claimToken,
      status: "dispatched",
      dataDir,
      fsApi: customFsApi,
    });

    assert.strictEqual(settleRes.status, "failed");
    assert.match(settleRes.reason, /Write receipt failed during settle/);

    // Claim file MUST STILL EXIST (not unlinked) because receipt write failed
    assert.ok(fs.existsSync(claimedFilePath), "Claim file must remain if receipt write fails");
  });

  it("(7) expired claim path avoids deleting evidence if receipt persistence fails", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-expired-io-fail" });
    createActiveSession(statusDir, petId);

    const t0 = Date.now();
    // Enqueue message with 5s TTL
    enqueueUserMessage({
      petId,
      text: "Expired claim io fail test",
      commandId: "cmd-exp-io-fail",
      createdAtMs: t0,
      ttlMs: 5000,
      now: () => t0,
      dataDir,
    });

    // Custom fsApi that throws when writing the expired receipt
    const customFsApi = {
      ...fs,
      writeFileSync(filePath, data, encoding) {
        if (typeof filePath === "string" && filePath.includes("rcpt-user-")) {
          throw new Error("Write expired receipt failed");
        }
        return fs.writeFileSync(filePath, data, encoding);
      },
    };

    // Advance time > 5s
    const tExpired = t0 + 10000;
    const claimRes = claimNextUserMessage({
      petId,
      dataDir,
      now: () => tExpired,
      fsApi: customFsApi,
    });

    assert.strictEqual(claimRes, null);

    // The claimed file was created via rename, and since receipt write failed, it is left as evidence
    const claimedFilePath = path.join(dataDir, "inbox", petId, "claimed", "cmd-exp-io-fail.json");
    assert.ok(fs.existsSync(claimedFilePath), "Claimed file must remain if expired receipt write fails");
  });

  it("(8) hardens on-disk candidate commandId/petId validation before constructing paths", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-harden-candidates" });
    createActiveSession(statusDir, petId);

    const pendingDir = path.join(dataDir, "inbox", petId, "pending");
    fs.mkdirSync(pendingDir, { recursive: true });

    // 1. Candidate with path-traversal commandId
    fs.writeFileSync(
      path.join(pendingDir, "0000000000000001-traversal.json"),
      JSON.stringify({
        schemaVersion: "1",
        kind: "user_message",
        commandId: "../../../etc/passwd",
        petId,
        text: "Dangerous traversal commandId",
      })
    );

    // 2. Candidate with mismatched or traversal petId
    fs.writeFileSync(
      path.join(pendingDir, "0000000000000002-badpet.json"),
      JSON.stringify({
        schemaVersion: "1",
        kind: "user_message",
        commandId: "cmd-bad-pet",
        petId: "../../other-pet",
        text: "Dangerous traversal petId",
      })
    );

    // 3. Candidate with non-object/malformed JSON
    fs.writeFileSync(
      path.join(pendingDir, "0000000000000003-corrupt.json"),
      "INVALID_NOT_JSON{{{"
    );

    // 4. Candidate with non-string text
    fs.writeFileSync(
      path.join(pendingDir, "0000000000000004-badtext.json"),
      JSON.stringify({
        schemaVersion: "1",
        kind: "user_message",
        commandId: "cmd-bad-text",
        petId,
        text: 12345,
      })
    );

    // 5. Valid candidate that should be claimed safely after skipping all malformed files
    fs.writeFileSync(
      path.join(pendingDir, "0000000000000005-valid.json"),
      JSON.stringify({
        schemaVersion: "1",
        kind: "user_message",
        commandId: "cmd-valid-safe",
        petId,
        text: "Valid safe message",
        deliverAs: "followUp",
      })
    );

    // Claim next: should skip all 4 malformed/unsafe candidates and claim only the valid safe message
    const claim = claimNextUserMessage({ petId, dataDir });
    assert.ok(claim, "Should successfully claim valid candidate");
    assert.strictEqual(claim.commandId, "cmd-valid-safe");
    assert.strictEqual(claim.text, "Valid safe message");

    // Next claim should return null
    const nextClaim = claimNextUserMessage({ petId, dataDir });
    assert.strictEqual(nextClaim, null);

    // Verify all 4 malformed files were quarantined and no .json files remain in pending
    const remainingFiles = fs.readdirSync(pendingDir);
    assert.strictEqual(
      remainingFiles.filter((f) => f.endsWith(".json")).length,
      0,
      "No .json files should remain in pending directory"
    );
    assert.strictEqual(
      remainingFiles.filter((f) => f.endsWith(".quarantine")).length,
      4,
      "All 4 malformed files must be quarantined"
    );
  });
});

describe("User Message Inbox: Malformed / Unsafe Pending Quarantine and Capacity Recovery", () => {
  it("quarantines malformed/unsafe files, frees 32-capacity slot, and claims valid messages", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-quarantine-cap" });
    createActiveSession(statusDir, petId);

    const pendingDir = path.join(dataDir, "inbox", petId, "pending");
    fs.mkdirSync(pendingDir, { recursive: true });

    // Populate 32 malformed / unsafe pending files covering all required categories
    const malformedPayloads = [
      // 1. JSON parse failure
      "NOT_VALID_JSON{:::broken",
      "{ invalid json syntax ",
      // 2. Non-object
      "null",
      "12345",
      '"just a string"',
      "true",
      "[1, 2, 3]",
      JSON.stringify(["array", "payload"]),
      // 3. Invalid / unauthorized / path-traversal commandId
      JSON.stringify({ schemaVersion: "1", commandId: "../../../etc/passwd", petId, text: "bad-cmd-1" }),
      JSON.stringify({ schemaVersion: "1", commandId: "bad id with spaces", petId, text: "bad-cmd-2" }),
      JSON.stringify({ schemaVersion: "1", commandId: "", petId, text: "bad-cmd-3" }),
      JSON.stringify({ schemaVersion: "1", commandId: 12345, petId, text: "bad-cmd-4" }),
      // 4. Invalid / unauthorized / mismatched petId
      JSON.stringify({ schemaVersion: "1", commandId: "cmd-bad-pet-1", petId: "../../traversal-pet", text: "bad-pet-1" }),
      JSON.stringify({ schemaVersion: "1", commandId: "cmd-bad-pet-2", petId: "unauthorized-different-pet", text: "bad-pet-2" }),
      JSON.stringify({ schemaVersion: "1", commandId: "cmd-bad-pet-3", petId: 12345, text: "bad-pet-3" }),
      JSON.stringify({ schemaVersion: "1", commandId: "cmd-bad-pet-4", petId: null, text: "bad-pet-4" }),
      // 5. Non-string text
      JSON.stringify({ schemaVersion: "1", commandId: "cmd-bad-txt-1", petId, text: 12345 }),
      JSON.stringify({ schemaVersion: "1", commandId: "cmd-bad-txt-2", petId, text: null }),
      JSON.stringify({ schemaVersion: "1", commandId: "cmd-bad-txt-3", petId, text: true }),
      JSON.stringify({ schemaVersion: "1", commandId: "cmd-bad-txt-4", petId, text: { nested: "object" } }),
      JSON.stringify({ schemaVersion: "1", commandId: "cmd-bad-txt-5", petId, text: ["array"] }),
      // 6. Non-followUp deliverAs
      JSON.stringify({ schemaVersion: "1", commandId: "cmd-bad-del-1", petId, text: "valid text", deliverAs: "direct" }),
      JSON.stringify({ schemaVersion: "1", commandId: "cmd-bad-del-2", petId, text: "valid text", deliverAs: "reply" }),
      JSON.stringify({ schemaVersion: "1", commandId: "cmd-bad-del-3", petId, text: "valid text", deliverAs: 123 }),
      JSON.stringify({ schemaVersion: "1", commandId: "cmd-bad-del-4", petId, text: "valid text", deliverAs: null }),
      // 7. Undefined commandId with non-matching filename
      JSON.stringify({ schemaVersion: "1", petId, text: "valid text" }),
    ];

    // Pad up to MAX_INBOX_QUEUE_CAPACITY (32) files
    while (malformedPayloads.length < MAX_INBOX_QUEUE_CAPACITY) {
      malformedPayloads.push(
        JSON.stringify({
          schemaVersion: "1",
          commandId: `cmd-corrupt-${malformedPayloads.length}`,
          petId,
          text: malformedPayloads.length, // non-string text
        })
      );
    }

    assert.strictEqual(malformedPayloads.length, MAX_INBOX_QUEUE_CAPACITY);

    // Write all 32 malformed files to pendingDir
    for (let i = 0; i < malformedPayloads.length; i++) {
      const fileName = i === 25 ? "unmatched-name.json" : `${String(1000 + i).padStart(16, "0")}-bad-${i}.json`;
      fs.writeFileSync(path.join(pendingDir, fileName), malformedPayloads[i], "utf8");
    }

    // Verify pending directory has 32 .json files
    const pendingJsonBefore = fs.readdirSync(pendingDir).filter((f) => f.endsWith(".json"));
    assert.strictEqual(pendingJsonBefore.length, MAX_INBOX_QUEUE_CAPACITY);

    // Attempting to enqueue a valid message should be REJECTED because queue is at capacity (32 malformed files)
    const rejectAttempt = enqueueUserMessage({
      petId,
      text: "Should be rejected initially",
      commandId: "cmd-rejected-cap",
      dataDir,
    });
    assert.strictEqual(rejectAttempt.status, "rejected");
    assert.match(rejectAttempt.reason, /QueueCapacityExceeded/);

    // Run claimNextUserMessage: it should scan, quarantine all 32 malformed files, and return null
    const claimRes = claimNextUserMessage({ petId, dataDir });
    assert.strictEqual(claimRes, null, "Should not dispatch any malformed message");

    // Verify all 32 bad files are quarantined (end in .quarantine, none end in .json)
    const pendingEntriesAfter = fs.readdirSync(pendingDir);
    const pendingJsonAfter = pendingEntriesAfter.filter((f) => f.endsWith(".json"));
    const pendingQuarantined = pendingEntriesAfter.filter((f) => f.endsWith(".quarantine"));

    assert.strictEqual(pendingJsonAfter.length, 0, "No .json files should remain in pending directory");
    assert.strictEqual(pendingQuarantined.length, MAX_INBOX_QUEUE_CAPACITY, "All 32 files must be quarantined");

    // Verify no files escaped to parent or dangerous paths
    assert.ok(!fs.existsSync(path.join(dataDir, "../etc/passwd")));

    // Capacity is now FREED: Enqueueing a valid message should succeed!
    const validEnq = enqueueUserMessage({
      petId,
      text: "Valid message after quarantine",
      commandId: "cmd-valid-after-quarantine",
      dataDir,
    });
    assert.strictEqual(validEnq.status, "queued");

    // Claim the valid message
    const validClaim = claimNextUserMessage({ petId, dataDir });
    assert.ok(validClaim);
    assert.strictEqual(validClaim.commandId, "cmd-valid-after-quarantine");
    assert.strictEqual(validClaim.text, "Valid message after quarantine");
    assert.strictEqual(validClaim.deliverAs, "followUp");
  });

  it("safely skips candidate if quarantine atomic rename fails", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-rename-fail" });
    createActiveSession(statusDir, petId);

    const pendingDir = path.join(dataDir, "inbox", petId, "pending");
    fs.mkdirSync(pendingDir, { recursive: true });

    // File 1: malformed candidate
    const badFileName = "0000000000000001-corrupt.json";
    fs.writeFileSync(path.join(pendingDir, badFileName), "INVALID_JSON{{", "utf8");

    // File 2: valid candidate
    const goodFileName = "0000000000000002-valid.json";
    fs.writeFileSync(
      path.join(pendingDir, goodFileName),
      JSON.stringify({
        schemaVersion: "1",
        kind: "user_message",
        commandId: "cmd-good-after-rename-fail",
        petId,
        text: "Good message despite rename failure",
        deliverAs: "followUp",
      }),
      "utf8"
    );

    // Custom fsApi that throws on rename of .quarantine file
    const customFsApi = {
      ...fs,
      renameSync(oldPath, newPath) {
        if (typeof newPath === "string" && newPath.endsWith(".quarantine")) {
          throw new Error("EPERM: Quarantine rename failed");
        }
        return fs.renameSync(oldPath, newPath);
      },
    };

    // Claim should not throw; it should safely skip rename failure and claim the valid message
    const claim = claimNextUserMessage({ petId, dataDir, fsApi: customFsApi });
    assert.ok(claim, "Should successfully claim valid candidate despite quarantine rename error");
    assert.strictEqual(claim.commandId, "cmd-good-after-rename-fail");
    assert.strictEqual(claim.text, "Good message despite rename failure");
  });
});

describe("User Message Inbox: Settle with injected env", () => {
  it("allows settling message even when huge env is injected", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s-huge-env-settle" });
    createActiveSession(statusDir, petId);

    const hugeEnv = {
      HUGE_VAR: "A".repeat(64 * 1024),
    };

    const enq = enqueueUserMessage({
      petId,
      text: "hello",
      dataDir,
      env: hugeEnv,
    });
    assert.strictEqual(enq.status, "queued");

    const claim = claimNextUserMessage({
      petId,
      dataDir,
      env: hugeEnv,
    });
    assert.ok(claim);

    const settled = settleUserMessage({
      petId,
      commandId: claim.commandId,
      claimToken: claim.claimToken,
      status: "dispatched",
      dataDir,
      env: hugeEnv,
    });
    assert.strictEqual(settled.status, "dispatched");
  });
});

describe("internal.atomicWriteJson temporary file cleanup", () => {
  const { atomicWriteJson } = require("../internal");

  it("cleans up temporary file when rename fails but direct write succeeds (Windows fallback)", () => {
    const { dataDir } = createTestEnvironment();
    const targetFile = path.join(dataDir, "test-fallback.json");
    const unlinkedFiles = [];
    const mockFs = {
      ...fs,
      renameSync() {
        throw new Error("EPERM: rename failed on Windows");
      },
      unlinkSync(p) {
        unlinkedFiles.push(p);
        return fs.unlinkSync(p);
      },
    };

    atomicWriteJson(targetFile, { hello: "world" }, mockFs);

    assert.strictEqual(fs.existsSync(targetFile), true);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(targetFile, "utf8")), { hello: "world" });
    assert.strictEqual(unlinkedFiles.length, 1);
    assert.strictEqual(fs.existsSync(unlinkedFiles[0]), false);
  });

  it("cleans up temporary file even when fallback write throws (try/finally)", () => {
    const { dataDir } = createTestEnvironment();
    const targetFile = path.join(dataDir, "test-fallback-throw.json");
    let writtenTmpFile = null;
    const unlinkedFiles = [];

    const mockFs = {
      ...fs,
      writeFileSync(p, content, enc) {
        if (p === targetFile) {
          throw new Error("EACCES: permission denied on direct write");
        }
        writtenTmpFile = p;
        return fs.writeFileSync(p, content, enc);
      },
      renameSync() {
        throw new Error("EPERM: rename failed");
      },
      unlinkSync(p) {
        unlinkedFiles.push(p);
        return fs.unlinkSync(p);
      },
    };

    assert.throws(
      () => atomicWriteJson(targetFile, { foo: "bar" }, mockFs),
      /EACCES: permission denied/
    );

    assert.ok(writtenTmpFile);
    assert.strictEqual(unlinkedFiles.length, 1);
    assert.strictEqual(unlinkedFiles[0], writtenTmpFile);
    assert.strictEqual(fs.existsSync(writtenTmpFile), false);
  });
});
