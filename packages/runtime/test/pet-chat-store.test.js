"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DISALLOWED_CONTROL_RE,
  MAX_ASSISTANT_TEXT_BYTES,
  MAX_CHAT_FILE_BYTES,
  MAX_CHAT_TURNS,
  MAX_USER_TEXT_CODE_POINTS,
  createPetChatStore,
  derivePetId,
  sanitizeAssistantText,
  truncateUtf8Bytes,
} = require("..");

const temporaryDirs = [];

afterEach(() => {
  while (temporaryDirs.length) {
    fs.rmSync(temporaryDirs.pop(), { recursive: true, force: true });
  }
});

function createTestEnvironment() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-test-chat-"));
  temporaryDirs.push(dataDir);
  return { dataDir };
}

function makePetId(name) {
  return derivePetId({ profileId: "local", agentId: "pi", rawSessionId: name });
}

describe("Pet Chat Store: Factory and Constants", () => {
  it("exports expected constants and helper functions", () => {
    assert.strictEqual(MAX_CHAT_TURNS, 20);
    assert.strictEqual(MAX_CHAT_FILE_BYTES, 49152);
    assert.strictEqual(MAX_USER_TEXT_CODE_POINTS, 2000);
    assert.strictEqual(MAX_ASSISTANT_TEXT_BYTES, 8192);
    assert.ok(DISALLOWED_CONTROL_RE instanceof RegExp);
    assert.strictEqual(typeof createPetChatStore, "function");
    assert.strictEqual(typeof sanitizeAssistantText, "function");
    assert.strictEqual(typeof truncateUtf8Bytes, "function");
  });

  it("instantiates store with dataDir and custom clock", () => {
    const { dataDir } = createTestEnvironment();
    let clock = 1000;
    const store = createPetChatStore({ dataDir, now: () => clock });
    assert.ok(store);
    assert.strictEqual(typeof store.readChat, "function");
    assert.strictEqual(typeof store.recordUserMessage, "function");
    assert.strictEqual(typeof store.completeTurn, "function");
    assert.strictEqual(typeof store.clearChat, "function");
  });
});

describe("Pet Chat Store: readChat", () => {
  it("returns synthetic revision 0 empty chat when file does not exist", () => {
    const { dataDir } = createTestEnvironment();
    const store = createPetChatStore({ dataDir });
    const petId = makePetId("test-session-1");

    const res = store.readChat({ petId });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.chat, {
      schemaVersion: "1",
      petId,
      revision: 0,
      turns: [],
      updatedAtMs: null,
    });
  });

  it("rejects invalid options, extra keys, and unsafe petId", () => {
    const { dataDir } = createTestEnvironment();
    const store = createPetChatStore({ dataDir });
    const petId = makePetId("test-session-1");

    assert.strictEqual(store.readChat().ok, false);
    assert.strictEqual(store.readChat(null).ok, false);
    assert.strictEqual(store.readChat({ petId, extra: 123 }).ok, false);
    assert.strictEqual(store.readChat({ petId: "../evil" }).ok, false);
    assert.strictEqual(store.readChat({ petId: "" }).ok, false);
  });
});

describe("Pet Chat Store: recordUserMessage & completeTurn Success Flows", () => {
  it("records user message creating revision 1 and completes turn incrementing to revision 2", () => {
    const { dataDir } = createTestEnvironment();
    let clock = 10000;
    const store = createPetChatStore({ dataDir, now: () => clock });
    const petId = makePetId("test-session-2");

    // 1. Record user message
    const recordRes = store.recordUserMessage({
      petId,
      commandId: "cmd-001",
      text: "What is the weather today?",
      createdAtMs: 10000,
    });
    assert.strictEqual(recordRes.ok, true);
    assert.strictEqual(recordRes.chat.revision, 1);
    assert.strictEqual(recordRes.chat.turns.length, 1);
    assert.deepStrictEqual(recordRes.chat.turns[0], {
      commandId: "cmd-001",
      userText: "What is the weather today?",
      assistantText: null,
      createdAtMs: 10000,
      completedAtMs: null,
    });
    assert.strictEqual(recordRes.chat.updatedAtMs, 10000);

    // Verify on-disk file was created
    const chatFilePath = path.join(dataDir, "chat", `chat-${petId}.json`);
    assert.ok(fs.existsSync(chatFilePath));

    // 2. Complete turn
    clock = 12000;
    const completeRes = store.completeTurn({
      petId,
      commandId: "cmd-001",
      assistantText: "It is sunny and 72 degrees.",
      completedAtMs: 12000,
    });
    assert.strictEqual(completeRes.ok, true);
    assert.strictEqual(completeRes.chat.revision, 2);
    assert.strictEqual(completeRes.chat.turns.length, 1);
    assert.deepStrictEqual(completeRes.chat.turns[0], {
      commandId: "cmd-001",
      userText: "What is the weather today?",
      assistantText: "It is sunny and 72 degrees.",
      createdAtMs: 10000,
      completedAtMs: 12000,
    });
    assert.strictEqual(completeRes.chat.updatedAtMs, 12000);

    // 3. Read back from store
    const readRes = store.readChat({ petId });
    assert.strictEqual(readRes.ok, true);
    assert.strictEqual(readRes.chat.revision, 2);
    assert.strictEqual(readRes.chat.turns[0].assistantText, "It is sunny and 72 degrees.");
  });

  it("handles idempotent re-recording of user message with identical commandId and text", () => {
    const { dataDir } = createTestEnvironment();
    const store = createPetChatStore({ dataDir, now: () => 10000 });
    const petId = makePetId("test-session-3");

    const res1 = store.recordUserMessage({
      petId,
      commandId: "cmd-idem-1",
      text: "Hello pet",
      createdAtMs: 10000,
    });
    assert.strictEqual(res1.ok, true);
    assert.strictEqual(res1.chat.revision, 1);

    const res2 = store.recordUserMessage({
      petId,
      commandId: "cmd-idem-1",
      text: "Hello pet",
      createdAtMs: 10000,
    });
    assert.strictEqual(res2.ok, true);
    assert.strictEqual(res2.idempotent, true);
    assert.strictEqual(res2.chat.revision, 1);
  });

  it("rejects recording turn with same commandId but different text (conflict)", () => {
    const { dataDir } = createTestEnvironment();
    const store = createPetChatStore({ dataDir, now: () => 10000 });
    const petId = makePetId("test-session-4");

    store.recordUserMessage({
      petId,
      commandId: "cmd-conflict-1",
      text: "Initial text",
      createdAtMs: 10000,
    });

    const resConflict = store.recordUserMessage({
      petId,
      commandId: "cmd-conflict-1",
      text: "Different text",
      createdAtMs: 10000,
    });
    assert.strictEqual(resConflict.ok, false);
    assert.strictEqual(resConflict.error, "conflict");
  });

  it("handles idempotent completion with identical assistant text", () => {
    const { dataDir } = createTestEnvironment();
    const store = createPetChatStore({ dataDir, now: () => 10000 });
    const petId = makePetId("test-session-5");

    store.recordUserMessage({ petId, commandId: "cmd-idem-comp", text: "Hello" });
    const comp1 = store.completeTurn({
      petId,
      commandId: "cmd-idem-comp",
      assistantText: "Hi there!",
      completedAtMs: 11000,
    });
    assert.strictEqual(comp1.ok, true);
    assert.strictEqual(comp1.chat.revision, 2);

    const comp2 = store.completeTurn({
      petId,
      commandId: "cmd-idem-comp",
      assistantText: "Hi there!",
      completedAtMs: 11000,
    });
    assert.strictEqual(comp2.ok, true);
    assert.strictEqual(comp2.idempotent, true);
    assert.strictEqual(comp2.chat.revision, 2);
  });

  it("rejects completion with different assistant text for already completed turn (conflict)", () => {
    const { dataDir } = createTestEnvironment();
    const store = createPetChatStore({ dataDir, now: () => 10000 });
    const petId = makePetId("test-session-6");

    store.recordUserMessage({ petId, commandId: "cmd-comp-conflict", text: "Hello" });
    store.completeTurn({
      petId,
      commandId: "cmd-comp-conflict",
      assistantText: "First response",
    });

    const conflict = store.completeTurn({
      petId,
      commandId: "cmd-comp-conflict",
      assistantText: "Second different response",
    });
    assert.strictEqual(conflict.ok, false);
    assert.strictEqual(conflict.error, "conflict");
  });

  it("returns turn_not_found when completing nonexistent turn or absent file", () => {
    const { dataDir } = createTestEnvironment();
    const store = createPetChatStore({ dataDir });
    const petId = makePetId("test-session-7");

    const res = store.completeTurn({
      petId,
      commandId: "cmd-nonexistent",
      assistantText: "No turn here",
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "turn_not_found");
  });

  it("rejects completion timestamp earlier than turn createdAtMs", () => {
    const { dataDir } = createTestEnvironment();
    const store = createPetChatStore({ dataDir, now: () => 10000 });
    const petId = makePetId("test-session-8");

    store.recordUserMessage({
      petId,
      commandId: "cmd-ts-1",
      text: "Test timestamp",
      createdAtMs: 10000,
    });

    const res = store.completeTurn({
      petId,
      commandId: "cmd-ts-1",
      assistantText: "Early completion",
      completedAtMs: 9000,
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "invalid_timestamp");
  });
});

describe("Pet Chat Store: Text Sanitization and Truncation", () => {
  it("sanitizes disallowed control characters in assistant text", () => {
    const { dataDir } = createTestEnvironment();
    const store = createPetChatStore({ dataDir });
    const petId = makePetId("test-session-sanitize");

    store.recordUserMessage({ petId, commandId: "cmd-san", text: "Hello" });
    const res = store.completeTurn({
      petId,
      commandId: "cmd-san",
      assistantText: "Hello\u0000World\u0007!\tTab and \nNewline are fine.",
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.chat.turns[0].assistantText, "HelloWorld!\tTab and \nNewline are fine.");
  });

  it("truncates assistant text exceeding 8192 UTF-8 bytes safely at character boundaries", () => {
    const longText = "A".repeat(10000);
    const truncated = truncateUtf8Bytes(longText, 8192);
    assert.strictEqual(Buffer.byteLength(truncated, "utf8"), 8192);

    // Multi-byte truncation safety (3-byte CJK character)
    const cjk = "中".repeat(3000); // 9000 bytes
    const truncatedCjk = truncateUtf8Bytes(cjk, 8192);
    assert.ok(Buffer.byteLength(truncatedCjk, "utf8") <= 8192);
    assert.strictEqual(Buffer.byteLength(truncatedCjk, "utf8") % 3, 0); // exact character boundary
  });
});

describe("Pet Chat Store: clearChat", () => {
  it("clears chat file when present and returns cleared: true with synthetic empty chat", () => {
    const { dataDir } = createTestEnvironment();
    const store = createPetChatStore({ dataDir });
    const petId = makePetId("test-session-clear-1");

    store.recordUserMessage({ petId, commandId: "cmd-c1", text: "First message" });
    const filePath = path.join(dataDir, "chat", `chat-${petId}.json`);
    assert.ok(fs.existsSync(filePath));

    const clearRes = store.clearChat({ petId });
    assert.strictEqual(clearRes.ok, true);
    assert.strictEqual(clearRes.cleared, true);
    assert.deepStrictEqual(clearRes.chat, {
      schemaVersion: "1",
      petId,
      revision: 0,
      turns: [],
      updatedAtMs: null,
    });
    assert.strictEqual(fs.existsSync(filePath), false);
  });

  it("returns cleared: false when file does not exist", () => {
    const { dataDir } = createTestEnvironment();
    const store = createPetChatStore({ dataDir });
    const petId = makePetId("test-session-clear-2");

    const clearRes = store.clearChat({ petId });
    assert.strictEqual(clearRes.ok, true);
    assert.strictEqual(clearRes.cleared, false);
    assert.strictEqual(clearRes.chat.revision, 0);
  });

  it("reports I/O failure when unlinkSync throws", () => {
    const { dataDir } = createTestEnvironment();
    const mockFs = {
      ...fs,
      existsSync: () => true,
      unlinkSync: () => {
        throw new Error("EACCES: permission denied");
      },
    };
    const store = createPetChatStore({ dataDir, fsApi: mockFs });
    const petId = makePetId("test-session-clear-err");

    const clearRes = store.clearChat({ petId });
    assert.strictEqual(clearRes.ok, false);
    assert.strictEqual(clearRes.error, "io_error");
  });
});

describe("Pet Chat Store: Bounds & Eviction (20 turns / 48 KiB)", () => {
  it("caps chat turns at 20 by evicting oldest turns", () => {
    const { dataDir } = createTestEnvironment();
    let clock = 1000;
    const store = createPetChatStore({ dataDir, now: () => (clock += 100) });
    const petId = makePetId("test-session-bounds-1");

    for (let i = 1; i <= 25; i++) {
      const res = store.recordUserMessage({
        petId,
        commandId: `cmd-b-${i}`,
        text: `Turn ${i}`,
      });
      assert.strictEqual(res.ok, true);
    }

    const readRes = store.readChat({ petId });
    assert.strictEqual(readRes.ok, true);
    assert.strictEqual(readRes.chat.turns.length, 20);
    assert.strictEqual(readRes.chat.turns[0].commandId, "cmd-b-6");
    assert.strictEqual(readRes.chat.turns[19].commandId, "cmd-b-25");
  });

  it("evicts oldest turns when file size exceeds 48 KiB limit", () => {
    const { dataDir } = createTestEnvironment();
    let clock = 1000;
    const store = createPetChatStore({ dataDir, now: () => (clock += 100) });
    const petId = makePetId("test-session-bounds-2");

    // Add large turns (~3.5 KiB assistant text each)
    const bigText = "X".repeat(3500);
    for (let i = 1; i <= 18; i++) {
      store.recordUserMessage({
        petId,
        commandId: `cmd-large-${i}`,
        text: `User query ${i}`,
      });
      store.completeTurn({
        petId,
        commandId: `cmd-large-${i}`,
        assistantText: bigText,
      });
    }

    const chatFilePath = path.join(dataDir, "chat", `chat-${petId}.json`);
    const stat = fs.statSync(chatFilePath);
    assert.ok(stat.size <= MAX_CHAT_FILE_BYTES, `File size ${stat.size} should be <= ${MAX_CHAT_FILE_BYTES}`);

    const readRes = store.readChat({ petId });
    assert.strictEqual(readRes.ok, true);
    assert.ok(readRes.chat.turns.length < 18, "Oldest turns should have been evicted to fit 48 KiB");
  });
});

describe("Pet Chat Store: Strict Corruption Handling", () => {
  it("rejects file exceeding 48 KiB limit as corrupt_chat", () => {
    const { dataDir } = createTestEnvironment();
    const petId = makePetId("test-session-corrupt-size");
    const chatDir = path.join(dataDir, "chat");
    fs.mkdirSync(chatDir, { recursive: true });
    const chatFilePath = path.join(chatDir, `chat-${petId}.json`);

    // Write file > 48 KiB
    fs.writeFileSync(chatFilePath, "X".repeat(50000), "utf8");

    const store = createPetChatStore({ dataDir });
    const res = store.readChat({ petId });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "corrupt_chat");
  });

  it("rejects invalid JSON syntax as corrupt_chat", () => {
    const { dataDir } = createTestEnvironment();
    const petId = makePetId("test-session-corrupt-json");
    const chatDir = path.join(dataDir, "chat");
    fs.mkdirSync(chatDir, { recursive: true });
    const chatFilePath = path.join(chatDir, `chat-${petId}.json`);

    fs.writeFileSync(chatFilePath, "{ invalid json ...", "utf8");

    const store = createPetChatStore({ dataDir });
    const res = store.readChat({ petId });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "corrupt_chat");
  });

  it("rejects record with unexpected extra keys as corrupt_chat", () => {
    const { dataDir } = createTestEnvironment();
    const petId = makePetId("test-session-corrupt-keys");
    const chatDir = path.join(dataDir, "chat");
    fs.mkdirSync(chatDir, { recursive: true });
    const chatFilePath = path.join(chatDir, `chat-${petId}.json`);

    const badChat = {
      schemaVersion: "1",
      petId,
      revision: 1,
      turns: [],
      updatedAtMs: 1000,
      extraUnauthorizedField: "bad",
    };
    fs.writeFileSync(chatFilePath, JSON.stringify(badChat), "utf8");

    const store = createPetChatStore({ dataDir });
    const res = store.readChat({ petId });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "corrupt_chat");
  });

  it("rejects record with duplicate commandIds across turns as corrupt_chat", () => {
    const { dataDir } = createTestEnvironment();
    const petId = makePetId("test-session-corrupt-dup");
    const chatDir = path.join(dataDir, "chat");
    fs.mkdirSync(chatDir, { recursive: true });
    const chatFilePath = path.join(chatDir, `chat-${petId}.json`);

    const badChat = {
      schemaVersion: "1",
      petId,
      revision: 2,
      turns: [
        { commandId: "dup-1", userText: "hi", assistantText: null, createdAtMs: 1000, completedAtMs: null },
        { commandId: "dup-1", userText: "hi again", assistantText: null, createdAtMs: 1100, completedAtMs: null },
      ],
      updatedAtMs: 1100,
    };
    fs.writeFileSync(chatFilePath, JSON.stringify(badChat), "utf8");

    const store = createPetChatStore({ dataDir });
    const res = store.readChat({ petId });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "corrupt_chat");
  });
});
