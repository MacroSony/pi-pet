"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DEFAULT_TTL_MS,
  MAX_TTL_MS,
  MIN_TTL_MS,
  VALID_EMOTIONS,
  derivePetId,
  expressExpression,
  isSafePetId,
  validateExpression,
  stablePetSessionId,
} = require("..");

const temporaryDirs = [];

afterEach(() => {
  while (temporaryDirs.length) {
    fs.rmSync(temporaryDirs.pop(), { recursive: true, force: true });
  }
});

function createTestEnvironment() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-test-interaction-"));
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
    detail: "Waiting for input",
    tool: "",
    event: "StatusUpdate",
    session_id: petId,
    session_name: "Pi / test-session",
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(statusPath, JSON.stringify(status, null, 2), "utf8");
  return statusPath;
}

describe("derivePetId identity derivation", () => {
  it("deterministically computes petId with sha256 hex prefix", () => {
    const identity = { profileId: "local", agentId: "pi", rawSessionId: "session-42" };
    const petId = derivePetId(identity);
    const expectedDigest = crypto
      .createHash("sha256")
      .update("local\0pi\0session-42", "utf8")
      .digest("hex")
      .slice(0, 24);
    assert.strictEqual(petId, `pet_${expectedDigest}`);
    assert.strictEqual(petId.length, 28);
    assert.ok(isSafePetId(petId));
  });

  it("matches Clawd adapter stablePetSessionId output for identical inputs", () => {
    const session = {
      profileId: "remote-box",
      agentId: "pi",
      rawSessionId: "sess-abc-123",
    };
    assert.strictEqual(derivePetId(session), stablePetSessionId(session));
  });

  it("applies defaults for omitted fields", () => {
    const petId = derivePetId({});
    const expectedDigest = crypto
      .createHash("sha256")
      .update("local\0unknown\0unknown", "utf8")
      .digest("hex")
      .slice(0, 24);
    assert.strictEqual(petId, `pet_${expectedDigest}`);
  });
});

describe("validateExpression payload validation", () => {
  it("accepts text only", () => {
    const result = validateExpression({ text: "Task completed successfully." });
    assert.deepStrictEqual(result, { ok: true });
  });

  it("accepts emotion only for all valid enum values", () => {
    for (const emotion of VALID_EMOTIONS) {
      const result = validateExpression({ emotion });
      assert.deepStrictEqual(result, { ok: true }, `Failed for valid emotion: ${emotion}`);
    }
  });

  it("accepts both text and emotion together", () => {
    const result = validateExpression({ text: "Great job!", emotion: "celebrate" });
    assert.deepStrictEqual(result, { ok: true });
  });

  it("rejects empty payloads with neither text nor emotion", () => {
    const result = validateExpression({});
    assert.strictEqual(result.ok, false);
    assert.match(result.reason, /At least one of text or emotion is required/);
  });

  it("rejects non-object payloads", () => {
    assert.strictEqual(validateExpression(null).ok, false);
    assert.strictEqual(validateExpression("hello").ok, false);
    assert.strictEqual(validateExpression([]).ok, false);
  });

  it("rejects empty text strings", () => {
    const result = validateExpression({ text: "" });
    assert.strictEqual(result.ok, false);
    assert.match(result.reason, /text length/);
  });

  it("rejects text strings exceeding 2000 characters", () => {
    const result = validateExpression({ text: "a".repeat(2001) });
    assert.strictEqual(result.ok, false);
    assert.match(result.reason, /text length/);
  });

  it("rejects non-string text", () => {
    const result = validateExpression({ text: 12345 });
    assert.strictEqual(result.ok, false);
    assert.match(result.reason, /text must be a string/);
  });

  it("rejects invalid emotions not in closed enum", () => {
    for (const invalid of ["super_excited", "drag", "working", "idle", "dancing", ""]) {
      const result = validateExpression({ emotion: invalid });
      assert.strictEqual(result.ok, false, `Expected rejection for emotion: ${invalid}`);
      assert.match(result.reason, /Invalid emotion/);
    }
  });
});

describe("Phase A interaction contract §8 scenarios", () => {
  // Scenario 1: Malformed JSON, missing fields, bad enum emotion, negative TTL, >16KiB payload
  it("Scenario 1: rejects malformed requests, missing fields, negative TTL, bad emotion, >16KiB payload (SchemaValidationError)", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "s1" });
    createActiveSession(statusDir, petId);

    // Missing both text and emotion
    const missingFields = expressExpression({
      profileId: "local",
      agentId: "pi",
      rawSessionId: "s1",
      dataDir,
    });
    assert.strictEqual(missingFields.status, "rejected");
    assert.match(missingFields.reason, /SchemaValidationError/);

    // Bad enum emotion
    const badEmotion = expressExpression({
      profileId: "local",
      agentId: "pi",
      rawSessionId: "s1",
      emotion: "super_excited",
      dataDir,
    });
    assert.strictEqual(badEmotion.status, "rejected");
    assert.match(badEmotion.reason, /SchemaValidationError/);

    // Negative TTL
    const negTtl = expressExpression({
      profileId: "local",
      agentId: "pi",
      rawSessionId: "s1",
      text: "hello",
      ttlMs: -500,
      dataDir,
    });
    assert.strictEqual(negTtl.status, "rejected");
    assert.match(negTtl.reason, /SchemaValidationError/);

    // TTL exceeding maximum (300000ms)
    const highTtl = expressExpression({
      profileId: "local",
      agentId: "pi",
      rawSessionId: "s1",
      text: "hello",
      ttlMs: 400000,
      dataDir,
    });
    assert.strictEqual(highTtl.status, "rejected");
    assert.match(highTtl.reason, /SchemaValidationError/);

    // Envelope size > 16 KiB
    const largeText = "x".repeat(17000);
    const oversized = expressExpression({
      profileId: "local",
      agentId: "pi",
      rawSessionId: "s1",
      text: largeText,
      dataDir,
    });
    assert.strictEqual(oversized.status, "rejected");
    assert.match(oversized.reason, /SchemaValidationError/);
  });

  // Scenario 2: Path-traversal/malformed/unknown/closed petId
  it("Scenario 2: rejects path traversal, malformed, unknown, and closed petId without unsafe FS access", () => {
    const { dataDir, statusDir } = createTestEnvironment();

    // Path traversal petId
    const pathTraversal = expressExpression({
      petId: "../../../etc/passwd",
      text: "escape",
      dataDir,
    });
    assert.strictEqual(pathTraversal.status, "rejected");
    assert.match(pathTraversal.reason, /InvalidPetIdentity/);

    // Malformed petId
    const malformed = expressExpression({
      petId: "invalid/pet:id",
      text: "malformed",
      dataDir,
    });
    assert.strictEqual(malformed.status, "rejected");
    assert.match(malformed.reason, /InvalidPetIdentity/);

    // Missing session identity
    const missingIdentity = expressExpression({
      text: "whoami",
      dataDir,
    });
    assert.strictEqual(missingIdentity.status, "rejected");
    assert.match(missingIdentity.reason, /InvalidPetIdentity/);

    // Unknown petId (session status file does not exist)
    const unknown = expressExpression({
      profileId: "local",
      agentId: "pi",
      rawSessionId: "nonexistent-session",
      text: "hello",
      dataDir,
    });
    assert.strictEqual(unknown.status, "rejected");
    assert.match(unknown.reason, /UnknownPetIdentity/);

    // Closed petId (session state is "closed")
    const closedPetId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "closed-sess" });
    createActiveSession(statusDir, closedPetId, "closed");
    const closed = expressExpression({
      profileId: "local",
      agentId: "pi",
      rawSessionId: "closed-sess",
      text: "hello",
      dataDir,
    });
    assert.strictEqual(closed.status, "rejected");
    assert.match(closed.reason, /SessionClosed/);
  });

  // Scenario 3: Same (petId, dedupKey) twice
  it("Scenario 3: handles deduplication for same (petId, dedupKey) without re-emitting event", () => {
    const { dataDir, statusDir, eventsDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "sess-dedup" });
    createActiveSession(statusDir, petId);

    const firstReceipt = expressExpression({
      profileId: "local",
      agentId: "pi",
      rawSessionId: "sess-dedup",
      text: "First expression",
      emotion: "happy",
      dedupKey: "turn-42",
      dataDir,
    });

    assert.strictEqual(firstReceipt.status, "delivered");
    assert.strictEqual(firstReceipt.dedupKey, "turn-42");
    assert.strictEqual(firstReceipt.petId, petId);

    const eventPath = path.join(eventsDir, `event-${petId}.json`);
    assert.ok(fs.existsSync(eventPath));
    const firstEvent = JSON.parse(fs.readFileSync(eventPath, "utf8"));
    assert.strictEqual(firstEvent.payload.text, "First expression");
    assert.strictEqual(firstEvent.eventId, firstReceipt.commandId);

    // Second call with same (petId, dedupKey) but different text to verify it is NOT re-emitted
    const secondReceipt = expressExpression({
      profileId: "local",
      agentId: "pi",
      rawSessionId: "sess-dedup",
      text: "Second expression attempt (should be ignored)",
      emotion: "sad",
      dedupKey: "turn-42",
      dataDir,
    });

    // Returns the exact persisted receipt from first execution
    assert.strictEqual(secondReceipt.status, "delivered");
    assert.strictEqual(secondReceipt.commandId, firstReceipt.commandId);
    assert.deepStrictEqual(secondReceipt.payloadEcho, firstReceipt.payloadEcho);

    // Event file still contains the first event, unmodified
    const persistedEvent = JSON.parse(fs.readFileSync(eventPath, "utf8"));
    assert.strictEqual(persistedEvent.payload.text, "First expression");
    assert.strictEqual(persistedEvent.eventId, firstReceipt.commandId);
  });

  // Scenario 4: createdAtMs + ttlMs < now at ingestion
  it("Scenario 4: marks stale command expired at ingestion without emitting event file", () => {
    const { dataDir, statusDir, eventsDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "sess-stale" });
    createActiveSession(statusDir, petId);

    const now = 1757419200000;
    const staleCreatedAt = now - 40000; // 40 seconds ago
    const ttlMs = 30000; // 30 second TTL -> expired 10s ago

    const receipt = expressExpression({
      profileId: "local",
      agentId: "pi",
      rawSessionId: "sess-stale",
      text: "Old message",
      createdAtMs: staleCreatedAt,
      ttlMs,
      now: () => now,
      dataDir,
    });

    assert.strictEqual(receipt.status, "expired");
    assert.match(receipt.reason, /expired/i);

    // Verify no event file was written
    const eventPath = path.join(eventsDir, `event-${petId}.json`);
    assert.strictEqual(fs.existsSync(eventPath), false);
  });

  // Scenario 5: Persist receipts, restart runtime, resubmit same commandId
  it("Scenario 5: loads persisted receipt from disk on restart when resubmitting same commandId", () => {
    const { dataDir, statusDir, receiptsDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "sess-restart" });
    createActiveSession(statusDir, petId);

    const fixedCommandId = "cmd_restart_test_001";
    const receipt1 = expressExpression({
      profileId: "local",
      agentId: "pi",
      rawSessionId: "sess-restart",
      commandId: fixedCommandId,
      text: "Restart test message",
      emotion: "shy",
      dataDir,
    });

    assert.strictEqual(receipt1.status, "delivered");
    assert.strictEqual(receipt1.commandId, fixedCommandId);

    const rcptFilePath = path.join(receiptsDir, `rcpt-${fixedCommandId}.json`);
    assert.ok(fs.existsSync(rcptFilePath));

    // Simulate runtime restart by issuing a fresh call with the same commandId
    const receipt2 = expressExpression({
      profileId: "local",
      agentId: "pi",
      rawSessionId: "sess-restart",
      commandId: fixedCommandId,
      text: "Restart test message again",
      dataDir,
    });

    assert.strictEqual(receipt2.status, "delivered");
    assert.strictEqual(receipt2.commandId, fixedCommandId);
    assert.strictEqual(receipt2.payloadEcho.text, "Restart test message");
    assert.strictEqual(receipt2.payloadEcho.emotion, "shy");
  });

  // Scenario 6: Concurrent writes
  it("Scenario 6: safely handles concurrent writes with atomic files and no partial reads or corrupt files", async () => {
    const { dataDir, statusDir, eventsDir, receiptsDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "sess-concurrent" });
    createActiveSession(statusDir, petId);

    const concurrency = 20;
    const promises = [];

    for (let i = 0; i < concurrency; i++) {
      promises.push(
        new Promise((resolve) => {
          const result = expressExpression({
            profileId: "local",
            agentId: "pi",
            rawSessionId: "sess-concurrent",
            commandId: `cmd_concurrent_${i}_${crypto.randomUUID()}`,
            text: `Concurrent message ${i}`,
            emotion: VALID_EMOTIONS[i % VALID_EMOTIONS.length],
            dataDir,
          });
          resolve(result);
        })
      );
    }

    const results = await Promise.all(promises);
    for (const res of results) {
      assert.strictEqual(res.status, "delivered");
    }

    // Verify event file is valid JSON
    const eventPath = path.join(eventsDir, `event-${petId}.json`);
    assert.ok(fs.existsSync(eventPath));
    const eventContent = fs.readFileSync(eventPath, "utf8");
    const parsedEvent = JSON.parse(eventContent);
    assert.strictEqual(parsedEvent.schemaVersion, "1");
    assert.strictEqual(parsedEvent.petId, petId);
    assert.strictEqual(parsedEvent.kind, "expression");

    // Verify all receipt files exist and are valid JSON
    const receiptFiles = fs.readdirSync(receiptsDir).filter((f) => f.startsWith("rcpt-") && f.endsWith(".json"));
    assert.strictEqual(receiptFiles.length, concurrency);
    for (const f of receiptFiles) {
      const parsedReceipt = JSON.parse(fs.readFileSync(path.join(receiptsDir, f), "utf8"));
      assert.strictEqual(parsedReceipt.status, "delivered");
      assert.strictEqual(parsedReceipt.schemaVersion, "1");
      assert.strictEqual(parsedReceipt.petId, petId);
    }

    // Verify no temporary files remain in events or receipts directories
    const eventTmpFiles = fs.readdirSync(eventsDir).filter((f) => f.endsWith(".tmp"));
    const receiptTmpFiles = fs.readdirSync(receiptsDir).filter((f) => f.endsWith(".tmp"));
    assert.strictEqual(eventTmpFiles.length, 0);
    assert.strictEqual(receiptTmpFiles.length, 0);
  });

  // Scenario 7: Emotion enum violation
  it("Scenario 7: rejects emotion enum violation ('super_excited') with SchemaValidationError", () => {
    const { dataDir, statusDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "sess-emotion" });
    createActiveSession(statusDir, petId);

    const result = expressExpression({
      profileId: "local",
      agentId: "pi",
      rawSessionId: "sess-emotion",
      text: "I am super excited!",
      emotion: "super_excited",
      dataDir,
    });

    assert.strictEqual(result.status, "rejected");
    assert.match(result.reason, /SchemaValidationError/);
    assert.match(result.reason, /super_excited/);
  });

  // Scenario 8: Missing reaction asset for valid emotion
  it("Scenario 8: preserves text and writes event even if renderer might lack asset for valid emotion", () => {
    const { dataDir, statusDir, eventsDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "sess-asset-fallback" });
    createActiveSession(statusDir, petId);

    const result = expressExpression({
      profileId: "local",
      agentId: "pi",
      rawSessionId: "sess-asset-fallback",
      text: "Important notification: asset might be missing but text must show",
      emotion: "shocked",
      dataDir,
    });

    assert.strictEqual(result.status, "delivered");
    const eventPath = path.join(eventsDir, `event-${petId}.json`);
    assert.ok(fs.existsSync(eventPath));
    const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
    assert.strictEqual(event.payload.text, "Important notification: asset might be missing but text must show");
    assert.strictEqual(event.payload.emotion, "shocked");
    assert.strictEqual(event.payload.speak, false);
    assert.strictEqual(event.payload.priority, 3);
  });

  it("performs opportunistic GC on receipts older than 24 hours", () => {
    const { dataDir, statusDir, receiptsDir } = createTestEnvironment();
    const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "sess-gc" });
    createActiveSession(statusDir, petId);

    const now = Date.now();
    const oldTimestamp = now - (25 * 60 * 60 * 1000); // 25 hours ago

    // Write an old receipt file directly
    const oldReceiptPath = path.join(receiptsDir, "rcpt-old-cmd-001.json");
    fs.writeFileSync(
      oldReceiptPath,
      JSON.stringify({
        schemaVersion: "1",
        commandId: "old-cmd-001",
        dedupKey: "old-cmd-001",
        petId,
        status: "delivered",
        reason: null,
        payloadEcho: { text: "Old" },
        createdAtMs: oldTimestamp,
        updatedAtMs: oldTimestamp,
      }),
      "utf8"
    );

    assert.ok(fs.existsSync(oldReceiptPath));

    // Execute a new expression to trigger opportunistic GC
    const result = expressExpression({
      profileId: "local",
      agentId: "pi",
      rawSessionId: "sess-gc",
      text: "New expression triggering GC",
      dataDir,
    });

    assert.strictEqual(result.status, "delivered");

    // Assert old receipt was pruned
    assert.strictEqual(fs.existsSync(oldReceiptPath), false);
  });
});
