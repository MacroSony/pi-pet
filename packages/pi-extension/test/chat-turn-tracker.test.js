"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createChatTurnTracker,
  extractAssistantText,
  extractInputText,
  attachInboxConsumer,
  createInboxConsumer,
} = require("../index.js");

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
  };
}

test("extractAssistantText strictly extracts text blocks and ignores thinking and tool blocks", () => {
  // Plain string
  assert.strictEqual(extractAssistantText({ content: "Hello world" }), "Hello world");
  assert.strictEqual(extractAssistantText({ text: "Hello text" }), "Hello text");

  // Array of blocks with thinking and tool_use
  const msgWithMixed = {
    content: [
      { type: "thinking", thinking: "Let me think about this query carefully..." },
      { type: "text", text: "The capital of France is Paris." },
      { type: "tool_use", name: "calculator", input: { expr: "2+2" } },
    ],
  };
  assert.strictEqual(extractAssistantText(msgWithMixed), "The capital of France is Paris.");

  // Tool results only
  const msgToolOnly = {
    content: [
      { type: "tool_result", tool_use_id: "123", content: "4" },
    ],
  };
  assert.strictEqual(extractAssistantText(msgToolOnly), null);

  // Thinking only
  const msgThinkingOnly = {
    content: [
      { type: "thinking", thinking: "Thinking..." },
    ],
  };
  assert.strictEqual(extractAssistantText(msgThinkingOnly), null);

  // Multiple text blocks
  const msgMultiText = {
    content: [
      { type: "text", text: "First paragraph." },
      { type: "thinking", thinking: "Intermediate thought" },
      { type: "text", text: "Second paragraph." },
    ],
  };
  assert.strictEqual(extractAssistantText(msgMultiText), "First paragraph.\nSecond paragraph.");

  const sanitized = extractAssistantText({
    content: [{ type: "text", text: `safe\u0000text ${"🐱".repeat(3000)}` }],
  });
  assert.ok(sanitized.startsWith("safetext "));
  assert.ok(Buffer.byteLength(sanitized, "utf8") <= 8192);
  assert.doesNotMatch(sanitized, /\u0000/);
});

test("tracker MUST NOT activate or finalize on input receipt; noteInboxDispatched records pending", () => {
  let clock = 1000;
  const completedTurns = [];
  const tracker = createChatTurnTracker({
    now: () => clock,
    onComplete: (data) => completedTurns.push(data),
  });

  // 1. Note pending dispatch
  tracker.noteInboxDispatched({
    petId: "pet-alpha",
    commandId: "cmd-101",
    text: "Review pull request #42",
    rawSessionId: "session-1",
    dispatchedAtMs: 1000,
  });

  const pending = tracker.getPendingDispatches();
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].commandId, "cmd-101");
  assert.strictEqual(pending[0].observed, false);
  assert.strictEqual(tracker.getActiveCandidate(), null);

  // 2. Pi emits input event
  tracker.handleInput({ text: "Review pull request #42", source: "extension" });

  // MUST NOT activate candidate on input!
  assert.strictEqual(tracker.getActiveCandidate(), null);
  assert.strictEqual(completedTurns.length, 0);

  // Pending item should be marked observed
  const pendingAfterInput = tracker.getPendingDispatches();
  assert.strictEqual(pendingAfterInput.length, 1);
  assert.strictEqual(pendingAfterInput[0].observed, true);
});

test("handleInput only observes/classifies source==='extension' and never interactive or rpc", () => {
  let clock = 2000;
  const tracker = createChatTurnTracker({ now: () => clock });

  tracker.noteInboxDispatched({
    petId: "pet-alpha",
    commandId: "cmd-102",
    text: "Show status",
    rawSessionId: "session-1",
    dispatchedAtMs: 2000,
  });

  // Interactive input with identical text
  tracker.handleInput({ text: "Show status", source: "interactive" });
  assert.strictEqual(tracker.getPendingDispatches()[0].observed, false);

  // RPC input with identical text
  tracker.handleInput({ text: "Show status", source: "rpc" });
  assert.strictEqual(tracker.getPendingDispatches()[0].observed, false);

  // Missing source
  tracker.handleInput({ text: "Show status" });
  assert.strictEqual(tracker.getPendingDispatches()[0].observed, false);

  // Extension source: successfully observed
  tracker.handleInput({ text: "Show status", source: "extension" });
  assert.strictEqual(tracker.getPendingDispatches()[0].observed, true);
});

test("handleMessageEnd on role user finalizes prior active, matches observed pet origin by exact text + timestamp >= dispatch time, and nonpet user clears active", () => {
  let clock = 5000;
  const completedTurns = [];
  const tracker = createChatTurnTracker({
    now: () => clock,
    onComplete: (data) => completedTurns.push(data),
  });

  // Step 1: Dispatch pet turn 1
  tracker.noteInboxDispatched({
    petId: "pet-1",
    commandId: "cmd-turn-1",
    text: "Pet query 1",
    rawSessionId: "sess-1",
    dispatchedAtMs: 5000,
  });

  // Step 2: Observed via extension input
  tracker.handleInput({ text: "Pet query 1", source: "extension" });

  // Step 3: User message arrives for pet turn 1
  tracker.handleMessageEnd({
    message: { role: "user", text: "Pet query 1", timestamp: 5005 },
  });

  const active1 = tracker.getActiveCandidate();
  assert.ok(active1);
  assert.strictEqual(active1.commandId, "cmd-turn-1");
  assert.strictEqual(active1.status, "active");

  // Step 4: Assistant emits response for turn 1
  tracker.handleMessageEnd({
    message: { role: "assistant", content: [{ type: "text", text: "Answer 1" }] },
  });
  assert.strictEqual(tracker.getActiveCandidate().latestAssistantText, "Answer 1");

  // Step 5: Dispatched pet turn 2
  clock = 6000;
  tracker.noteInboxDispatched({
    petId: "pet-1",
    commandId: "cmd-turn-2",
    text: "Pet query 2",
    rawSessionId: "sess-1",
    dispatchedAtMs: 6000,
  });
  tracker.handleInput({ text: "Pet query 2", source: "extension" });

  // Step 6: User message arrives for pet turn 2 while turn 1 was active -> finalizes turn 1 and activates turn 2
  tracker.handleMessageEnd({
    message: { role: "user", text: "Pet query 2", timestamp: 6010 },
  });

  assert.strictEqual(completedTurns.length, 1);
  assert.strictEqual(completedTurns[0].commandId, "cmd-turn-1");
  assert.strictEqual(completedTurns[0].assistantText, "Answer 1");

  const active2 = tracker.getActiveCandidate();
  assert.ok(active2);
  assert.strictEqual(active2.commandId, "cmd-turn-2");

  // Step 7: A nonpet interactive user message arrives -> finalizes prior active (if has text) or clears active
  tracker.handleMessageEnd({
    message: { role: "assistant", content: [{ type: "text", text: "Answer 2 in-flight" }] },
  });

  tracker.handleMessageEnd({
    message: { role: "user", text: "Random interactive query", timestamp: 7000 },
  });

  // Turn 2 was finalized
  assert.strictEqual(completedTurns.length, 2);
  assert.strictEqual(completedTurns[1].commandId, "cmd-turn-2");
  assert.strictEqual(completedTurns[1].assistantText, "Answer 2 in-flight");

  // Nonpet user clears active
  assert.strictEqual(tracker.getActiveCandidate(), null);
});

test("busy queued pet input arriving while current assistant emits must not misattribute", () => {
  let clock = 10000;
  const completedTurns = [];
  const tracker = createChatTurnTracker({
    now: () => clock,
    onComplete: (data) => completedTurns.push(data),
  });

  // Turn 1 dispatched and started
  tracker.noteInboxDispatched({
    petId: "pet-busy",
    commandId: "cmd-busy-1",
    text: "Long task 1",
    rawSessionId: "session-busy",
    dispatchedAtMs: 10000,
  });
  tracker.handleInput({ text: "Long task 1", source: "extension" });
  tracker.handleMessageEnd({
    message: { role: "user", text: "Long task 1", timestamp: 10005 },
  });

  assert.strictEqual(tracker.getActiveCandidate().commandId, "cmd-busy-1");

  // Assistant emits partial / intermediate message
  tracker.handleMessageEnd({
    message: { role: "assistant", content: [{ type: "text", text: "Step 1 complete..." }] },
  });

  // WHILE assistant is emitting, a new queued pet input arrives at t=10500!
  clock = 10500;
  tracker.noteInboxDispatched({
    petId: "pet-busy",
    commandId: "cmd-busy-2",
    text: "Long task 2",
    rawSessionId: "session-busy",
    dispatchedAtMs: 10500,
  });
  tracker.handleInput({ text: "Long task 2", source: "extension" });

  // CRITICAL: Active candidate MUST STILL BE turn 1!
  const currentActive = tracker.getActiveCandidate();
  assert.ok(currentActive);
  assert.strictEqual(currentActive.commandId, "cmd-busy-1");
  assert.strictEqual(currentActive.latestAssistantText, "Step 1 complete...");
  assert.strictEqual(completedTurns.length, 0);

  // Turn 1 assistant emits final message
  tracker.handleMessageEnd({
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Wrapping up task 1..." },
        { type: "text", text: "Final result for task 1!" },
      ],
    },
  });
  assert.strictEqual(tracker.getActiveCandidate().latestAssistantText, "Final result for task 1!");

  // Turn 1 agent_end
  clock = 10600;
  tracker.handleAgentEnd({});

  // Turn 1 must be finalized with its own assistant text!
  assert.strictEqual(completedTurns.length, 1);
  assert.strictEqual(completedTurns[0].commandId, "cmd-busy-1");
  assert.strictEqual(completedTurns[0].assistantText, "Final result for task 1!");
  assert.strictEqual(tracker.getActiveCandidate(), null);

  // Now Turn 2 begins
  tracker.handleMessageEnd({
    message: { role: "user", text: "Long task 2", timestamp: 10605 },
  });
  assert.strictEqual(tracker.getActiveCandidate().commandId, "cmd-busy-2");

  // Turn 2 assistant emits
  tracker.handleMessageEnd({
    message: { role: "assistant", content: [{ type: "text", text: "Final result for task 2!" }] },
  });

  // Turn 2 agent_end
  clock = 10700;
  tracker.handleAgentEnd({});

  assert.strictEqual(completedTurns.length, 2);
  assert.strictEqual(completedTurns[1].commandId, "cmd-busy-2");
  assert.strictEqual(completedTurns[1].assistantText, "Final result for task 2!");
});

test("interactive identical text before pet dispatch is not misattributed to pet", () => {
  let clock = 20000;
  const completedTurns = [];
  const tracker = createChatTurnTracker({
    now: () => clock,
    onComplete: (data) => completedTurns.push(data),
  });

  // 1. Interactive user inputs "Run tests" at t=19000
  tracker.handleInput({ text: "Run tests", source: "interactive" });

  // 2. Pet dispatch is queued at t=20000
  tracker.noteInboxDispatched({
    petId: "pet-alpha",
    commandId: "cmd-pet-tests",
    text: "Run tests",
    rawSessionId: "session-interactive",
    dispatchedAtMs: 20000,
  });

  // 3. User message for the earlier interactive input arrives with timestamp 19050 (< 20000)
  tracker.handleMessageEnd({
    message: { role: "user", text: "Run tests", timestamp: 19050 },
  });

  // MUST NOT activate pet turn because timestamp < dispatch time and source was not extension!
  assert.strictEqual(tracker.getActiveCandidate(), null);

  // 4. Interactive assistant responds
  tracker.handleMessageEnd({
    message: { role: "assistant", content: [{ type: "text", text: "Interactive test run output" }] },
  });
  tracker.handleAgentEnd({});

  assert.strictEqual(completedTurns.length, 0);

  // 5. Now pet input arrives from extension
  tracker.handleInput({ text: "Run tests", source: "extension" });

  // 6. User message for pet arrives with timestamp 20050 (>= 20000)
  tracker.handleMessageEnd({
    message: { role: "user", text: "Run tests", timestamp: 20050 },
  });

  assert.ok(tracker.getActiveCandidate());
  assert.strictEqual(tracker.getActiveCandidate().commandId, "cmd-pet-tests");

  // 7. Pet assistant responds
  tracker.handleMessageEnd({
    message: { role: "assistant", content: [{ type: "text", text: "Pet test run output" }] },
  });
  tracker.handleAgentEnd({});

  assert.strictEqual(completedTurns.length, 1);
  assert.strictEqual(completedTurns[0].commandId, "cmd-pet-tests");
  assert.strictEqual(completedTurns[0].assistantText, "Pet test run output");
});

test("real Pi structured user content activates, while camelCase assistant errors are discarded", () => {
  let clock = 25000;
  const completedTurns = [];
  const tracker = createChatTurnTracker({
    now: () => clock,
    onComplete: (data) => completedTurns.push(data),
  });

  tracker.noteInboxDispatched({
    petId: "pet-real-shape",
    commandId: "cmd-real-shape",
    text: "Structured Pi input",
    rawSessionId: "pi:sess-real-shape",
    dispatchedAtMs: 25000,
  });
  tracker.handleInput(
    { text: "Structured Pi input", source: "extension" },
    { sessionManager: { getSessionId: () => "sess-real-shape" } }
  );
  tracker.handleMessageEnd(
    {
      message: {
        role: "user",
        content: [{ type: "text", text: "Structured Pi input" }],
        timestamp: 25005,
      },
    },
    { sessionManager: { getSessionId: () => "sess-real-shape" } }
  );

  assert.strictEqual(tracker.getActiveCandidate().commandId, "cmd-real-shape");

  tracker.handleMessageEnd({
    message: {
      role: "assistant",
      content: [{ type: "text", text: "partial output must not persist" }],
      stopReason: "error",
      errorMessage: "provider failed",
    },
  });
  tracker.handleAgentEnd({});

  assert.strictEqual(completedTurns.length, 0);
  assert.strictEqual(tracker.getActiveCandidate(), null);
});

test("agent_end error or aborted drops candidate safely without persisting preamble", () => {
  let clock = 30000;
  const completedTurns = [];
  const tracker = createChatTurnTracker({
    now: () => clock,
    onComplete: (data) => completedTurns.push(data),
  });

  tracker.noteInboxDispatched({
    petId: "pet-err",
    commandId: "cmd-err-1",
    text: "Do something risky",
    rawSessionId: "sess-err",
    dispatchedAtMs: 30000,
  });
  tracker.handleInput({ text: "Do something risky", source: "extension" });
  tracker.handleMessageEnd({
    message: { role: "user", text: "Do something risky", timestamp: 30005 },
  });

  // Assistant emits partial preamble before error
  tracker.handleMessageEnd({
    message: { role: "assistant", content: [{ type: "text", text: "Starting task..." }] },
  });

  // agent_end with error: true
  tracker.handleAgentEnd({ error: true });

  // No completion must be emitted!
  assert.strictEqual(completedTurns.length, 0);
  assert.strictEqual(tracker.getActiveCandidate(), null);
});

test("exact completion POST wire body format {schemaVersion:'1',kind:'pet_chat_complete',rawSessionId,capabilityToken,commandId,assistantText}", async () => {
  let receivedBody = null;
  let receivedPath = null;

  const server = http.createServer((req, res) => {
    receivedPath = req.url;
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      receivedBody = JSON.parse(data);
      res.writeHead(200, { "content-type": "application/json", "x-clawd-server": "clawd-on-desk" });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const crypto = require("node:crypto");
  const testToken = crypto.randomBytes(32).toString("hex");
  const PEER_CAPABILITY_SLOT_SYMBOL = Symbol.for("pi-pet.peer-capability.v1");
  globalThis[PEER_CAPABILITY_SLOT_SYMBOL] = Object.freeze({
    version: 1,
    token: testToken,
  });

  const remoteConfigFile = path.join(os.tmpdir(), `pi-pet-remote-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(
    remoteConfigFile,
    JSON.stringify({
      remotePort: port,
      routingNonce: "1234567890abcdef1234567890abcdef",
      profileId: "remote-test",
    }),
    "utf8"
  );

  const env = {
    PI_PET_CLAWD_REMOTE_CONFIG: remoteConfigFile,
  };

  try {
    const tracker = createChatTurnTracker({
      env,
      now: () => 40000,
    });

    tracker.noteInboxDispatched({
      petId: "pet-wire-1",
      commandId: "cmd-wire-999",
      text: "Wire query",
      rawSessionId: "session-wire-42",
      dispatchedAtMs: 40000,
    });
    tracker.handleInput({ text: "Wire query", source: "extension" });
    tracker.handleMessageEnd({
      message: { role: "user", text: "Wire query", timestamp: 40005 },
    });
    tracker.handleMessageEnd({
      message: { role: "assistant", content: [{ type: "text", text: "Wire response answer" }] },
    });
    tracker.handleAgentEnd({});

    // Wait for async POST to reach server
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.strictEqual(receivedPath, "/pet-chat/complete");
    assert.ok(receivedBody);
    assert.strictEqual(receivedBody.schemaVersion, "1");
    assert.strictEqual(receivedBody.kind, "pet_chat_complete");
    assert.strictEqual(receivedBody.rawSessionId, "session-wire-42");
    assert.strictEqual(receivedBody.capabilityToken, testToken);
    assert.strictEqual(receivedBody.commandId, "cmd-wire-999");
    assert.strictEqual(receivedBody.assistantText, "Wire response answer");

    // Strictly verify forbidden keys are absent
    assert.strictEqual(receivedBody.petId, undefined);
    assert.strictEqual(receivedBody.completedAt, undefined);
    assert.strictEqual(receivedBody.completedAtMs, undefined);

    const exactKeys = Object.keys(receivedBody).sort();
    assert.deepStrictEqual(exactKeys, [
      "assistantText",
      "capabilityToken",
      "commandId",
      "kind",
      "rawSessionId",
      "schemaVersion",
    ]);
  } finally {
    try { fs.unlinkSync(remoteConfigFile); } catch {}
    delete globalThis[PEER_CAPABILITY_SLOT_SYMBOL];
    server.close();
  }
});

test("completion POST failure does not throw or crash tracker", async () => {
  const env = {
    PI_PET_CLAWD_REMOTE_CONFIG: "/nonexistent/path/clawd-remote.json",
  };

  const completed = [];
  const tracker = createChatTurnTracker({
    env,
    now: () => 50000,
    onComplete: (d) => completed.push(d),
  });

  tracker.noteInboxDispatched({
    petId: "pet-fail-1",
    commandId: "cmd-fail-1",
    text: "Fail query",
    rawSessionId: "session-fail",
    dispatchedAtMs: 50000,
  });
  tracker.handleInput({ text: "Fail query", source: "extension" });
  tracker.handleMessageEnd({
    message: { role: "user", text: "Fail query", timestamp: 50005 },
  });
  tracker.handleMessageEnd({
    message: { role: "assistant", content: [{ type: "text", text: "Safe response" }] },
  });

  // Must not throw despite invalid transport config
  assert.doesNotThrow(() => {
    tracker.handleAgentEnd({});
  });

  assert.strictEqual(completed.length, 1);
  assert.strictEqual(completed[0].commandId, "cmd-fail-1");
  assert.strictEqual(completed[0].assistantText, "Safe response");
});

test("tracker isolates pending dispatches by session ID", () => {
  const tracker = createChatTurnTracker({ now: () => 60000 });

  tracker.noteInboxDispatched({
    petId: "pet-s1",
    commandId: "cmd-s1",
    text: "Session specific task",
    rawSessionId: "session-AAA",
    dispatchedAtMs: 60000,
  });

  // Observed with session-AAA context
  tracker.handleInput({ text: "Session specific task", source: "extension" }, { getSessionId: () => "session-AAA" });

  // User message arrives with context for session-BBB
  tracker.handleMessageEnd(
    { message: { role: "user", text: "Session specific task", timestamp: 60005 } },
    { getSessionId: () => "session-BBB" }
  );

  // Must NOT activate candidate due to session mismatch!
  assert.strictEqual(tracker.getActiveCandidate(), null);

  // User message arrives with matching session-AAA
  tracker.handleMessageEnd(
    { message: { role: "user", text: "Session specific task", timestamp: 60005 } },
    { getSessionId: () => "session-AAA" }
  );

  assert.ok(tracker.getActiveCandidate());
  assert.strictEqual(tracker.getActiveCandidate().commandId, "cmd-s1");
});

test("attachInboxConsumer registers lifecycle listeners and resets tracker on session start/shutdown", () => {
  const pi = createMockPi();
  const handle = attachInboxConsumer(pi, {
    env: {},
    now: () => 70000,
  });

  assert.ok(handle);
  const tracker = handle.getTracker();
  assert.ok(tracker);

  // Check event registrations
  assert.ok(pi.listeners.has("session_start"));
  assert.ok(pi.listeners.has("session_shutdown"));
  assert.ok(pi.listeners.has("input"));
  assert.ok(pi.listeners.has("message_end"));
  assert.ok(pi.listeners.has("agent_end"));

  // Add pending dispatch
  tracker.noteInboxDispatched({
    petId: "pet-reset",
    commandId: "cmd-r1",
    text: "Reset test",
    dispatchedAtMs: 70000,
  });
  assert.strictEqual(tracker.getPendingDispatches().length, 1);

  // session_start clears tracker
  pi.emit("session_start", { sessionId: "new-session" });
  assert.strictEqual(tracker.getPendingDispatches().length, 0);

  // Add another pending dispatch
  tracker.noteInboxDispatched({
    petId: "pet-reset",
    commandId: "cmd-r2",
    text: "Reset test 2",
    dispatchedAtMs: 71000,
  });
  assert.strictEqual(tracker.getPendingDispatches().length, 1);

  // session_shutdown clears tracker
  pi.emit("session_shutdown");
  assert.strictEqual(tracker.getPendingDispatches().length, 0);

  handle.stop();
});

test("inbox consumer records noteInboxDispatched and settles without direct interaction chat writes", async () => {
  const pi = createMockPi();
  const noted = [];
  const settled = [];
  const interactionWrites = [];

  const mockTracker = {
    noteInboxDispatched: (item) => noted.push(item),
    clear: () => {},
  };

  const mockInteraction = {
    derivePetId: () => "pet-test-consumer",
    claimNextUserMessage: async () => ({
      commandId: "cmd-cons-1",
      text: "Consumer test text",
      claimToken: "token-abc-123",
      createdAtMs: 80000,
    }),
    settleUserMessage: async (opts) => settled.push(opts),
    // Direct chat writes should NOT be called!
    recordUserMessage: () => interactionWrites.push("recordUserMessage"),
    completeTurn: () => interactionWrites.push("completeTurn"),
    createPetChatStore: () => {
      interactionWrites.push("createPetChatStore");
      return {
        recordUserMessage: () => interactionWrites.push("store.recordUserMessage"),
        completeTurn: () => interactionWrites.push("store.completeTurn"),
      };
    },
  };

  pi.sendUserMessage = (text, options) => {
    assert.strictEqual(noted.length, 1, "dispatch must be registered before Pi can synchronously emit input");
    pi.sentUserMessages.push({ text, options });
  };

  const consumer = createInboxConsumer(pi, {
    interaction: mockInteraction,
    tracker: mockTracker,
    sessionId: "sess-consumer",
    now: () => 80000,
  });

  const result = await consumer.pollOnce();
  assert.strictEqual(result.status, "dispatched");

  // Verified pi received user message
  assert.strictEqual(pi.sentUserMessages.length, 1);
  assert.strictEqual(pi.sentUserMessages[0].text, "Consumer test text");

  // Verified tracker received noteInboxDispatched
  assert.strictEqual(noted.length, 1);
  assert.strictEqual(noted[0].commandId, "cmd-cons-1");
  assert.strictEqual(noted[0].text, "Consumer test text");

  // Verified settle was called with status 'dispatched'
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].commandId, "cmd-cons-1");
  assert.strictEqual(settled[0].status, "dispatched");

  // Verified zero direct interaction chat writes were performed
  assert.deepStrictEqual(interactionWrites, []);
});

test("delivered pet_express text overrides final assistant text for an active pet turn", () => {
  const completedTurns = [];
  const tracker = createChatTurnTracker({
    now: () => 10000,
    onComplete: (data) => completedTurns.push(data),
  });

  tracker.noteInboxDispatched({
    petId: "pet-mika",
    commandId: "cmd-express",
    text: "摸摸头喵",
    rawSessionId: "session-mika",
    dispatchedAtMs: 9000,
  });
  tracker.handleInput({ text: "摸摸头喵", source: "extension" });
  tracker.handleMessageEnd({
    message: { role: "user", text: "摸摸头喵", timestamp: 9001 },
  });

  assert.strictEqual(tracker.noteDeliveredExpression({
    status: "delivered",
    text: "蹭蹭～被摸头好开心喵！",
    rawSessionId: "session-mika",
  }), true);
  tracker.handleMessageEnd({
    message: { role: "assistant", content: [{ type: "text", text: "蹭蹭～好开心喵！" }] },
  });
  tracker.handleAgentEnd({});

  assert.strictEqual(completedTurns.length, 1);
  assert.strictEqual(completedTurns[0].assistantText, "蹭蹭～被摸头好开心喵！");
});

test("pet_express projection accepts only delivered text for the active matching session and last delivery wins", () => {
  const completedTurns = [];
  const tracker = createChatTurnTracker({
    now: () => 20000,
    onComplete: (data) => completedTurns.push(data),
  });

  tracker.noteInboxDispatched({
    petId: "pet-alpha",
    commandId: "cmd-guarded-express",
    text: "Respond",
    rawSessionId: "session-alpha",
    dispatchedAtMs: 19000,
  });
  tracker.handleInput({ text: "Respond", source: "extension" });
  tracker.handleMessageEnd({
    message: { role: "user", text: "Respond", timestamp: 19001 },
  });

  assert.strictEqual(tracker.noteDeliveredExpression({ status: "failed", text: "failed text", rawSessionId: "session-alpha" }), false);
  assert.strictEqual(tracker.noteDeliveredExpression({ status: "delivered", emotion: "happy", rawSessionId: "session-alpha" }), false);
  assert.strictEqual(tracker.noteDeliveredExpression({ status: "delivered", text: "wrong session", rawSessionId: "session-beta" }), false);
  assert.strictEqual(tracker.noteDeliveredExpression({ status: "delivered", text: "first visible line", rawSessionId: "session-alpha" }), true);
  assert.strictEqual(tracker.noteDeliveredExpression({ status: "delivered", text: "last\u0000 visible line", rawSessionId: "session-alpha" }), true);

  tracker.handleAgentEnd({});
  assert.strictEqual(completedTurns.length, 1);
  assert.strictEqual(completedTurns[0].assistantText, "last visible line");
});

test("agent abort discards delivered pet_express text rather than persisting an aborted turn", () => {
  const completedTurns = [];
  const tracker = createChatTurnTracker({
    now: () => 30000,
    onComplete: (data) => completedTurns.push(data),
  });

  tracker.noteInboxDispatched({
    petId: "pet-alpha",
    commandId: "cmd-aborted-express",
    text: "Abort later",
    rawSessionId: "session-alpha",
    dispatchedAtMs: 29000,
  });
  tracker.handleInput({ text: "Abort later", source: "extension" });
  tracker.handleMessageEnd({
    message: { role: "user", text: "Abort later", timestamp: 29001 },
  });
  assert.strictEqual(tracker.noteDeliveredExpression({
    status: "delivered",
    text: "partial visible response",
    rawSessionId: "session-alpha",
  }), true);

  tracker.handleAgentEnd({ aborted: true });
  assert.strictEqual(completedTurns.length, 0);
  assert.strictEqual(tracker.getActiveCandidate(), null);
});
