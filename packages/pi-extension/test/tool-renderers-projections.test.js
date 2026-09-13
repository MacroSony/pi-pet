"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const typeboxStub = {
  Type: {
    Object: (properties) => ({ type: "object", properties }),
    Optional: (schema) => schema,
    String: (opts) => ({ type: "string", ...opts }),
    Array: (items, opts) => ({ type: "array", items, ...opts }),
    Union: (schemas) => ({ anyOf: schemas }),
    Literal: (value) => ({ const: value }),
    Integer: (opts) => ({ type: "integer", ...opts }),
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
const {
  FallbackText,
  createText,
  extractResultDetails,
  projectExpressForModel,
  projectCatalogForModel,
  projectSendForModel,
  projectTeamStatusForModel,
  projectTeamCreateForModel,
  projectTeamDissolveForModel,
  projectBoardReadForModel,
  projectBoardWriteForModel,
  renderExpressCall,
  renderExpressResult,
  renderListSessionsCall,
  renderListSessionsResult,
  renderSendCall,
  renderSendResult,
  renderTeamCreateCall,
  renderTeamCreateResult,
  renderTeamStatusCall,
  renderTeamStatusResult,
  renderTeamDissolveCall,
  renderTeamDissolveResult,
  renderBoardReadCall,
  renderBoardReadResult,
  renderBoardWriteCall,
  renderBoardWriteResult,
} = extension;

class CustomTuiText {
  constructor(text) {
    this.text = text;
    this._isCustomTui = true;
  }
  toString() {
    return this.text;
  }
  render() {
    return this.text;
  }
}

function registerAllTools(customDependencies = {}) {
  const tools = new Map();
  const mockPi = {
    registerTool(def) {
      if (def && def.name) {
        tools.set(def.name, def);
      }
    },
    registerCommand() {},
    on() {},
  };
  extension(mockPi, { Type: typeboxStub.Type, ...customDependencies });
  return tools;
}

// ── 1. Tool Registration & Custom Renderer Attachment ────────────────────────

test("all eight tools register custom renderCall and renderResult functions", () => {
  const tools = registerAllTools({ Text: CustomTuiText });
  const toolNames = [
    "pet_express",
    "pet_list_sessions",
    "pet_send",
    "pet_team_create",
    "pet_team_status",
    "pet_team_dissolve",
    "pet_board_read",
    "pet_board_write",
  ];

  assert.equal(tools.size, 8);
  for (const name of toolNames) {
    const tool = tools.get(name);
    assert.ok(tool, `tool ${name} must be registered`);
    assert.equal(typeof tool.renderCall, "function", `${name} must have renderCall`);
    assert.equal(typeof tool.renderResult, "function", `${name} must have renderResult`);

    // Verify renderCall and renderResult return CustomTuiText instances
    const callRender = tool.renderCall({});
    assert.ok(callRender instanceof CustomTuiText, `${name}.renderCall must use injected Text`);

    const resultRender = tool.renderResult({ isError: false, details: {} }, { expanded: false });
    assert.ok(resultRender instanceof CustomTuiText, `${name}.renderResult must use injected Text`);
  }
});

test("FallbackText works safely when Text is not provided or throws", () => {
  const fallback = new FallbackText("hello");
  assert.equal(fallback.text, "hello");
  assert.equal(fallback.toString(), "hello");
  assert.deepEqual(fallback.render(), ["hello"]);

  const created1 = createText("test1");
  assert.ok(created1 instanceof FallbackText);
  assert.equal(created1.toString(), "test1");

  const ThrowingCtor = function () {
    throw new Error("Cannot construct");
  };
  const created2 = createText("test2", ThrowingCtor);
  assert.ok(created2 instanceof FallbackText);
  assert.equal(created2.toString(), "test2");
});

// ── 2. Model Content Projections (Low-Noise Projections) ─────────────────────

test("projectExpressForModel preserves status/reason and strips schemaVersion/petId/timestamps/commandId", () => {
  const deliveredReceipt = {
    schemaVersion: "1",
    commandId: "cmd_secret_123",
    dedupKey: "tc_express_1",
    petId: "pet_secret_456",
    status: "delivered",
    createdAtMs: 1700000000000,
    updatedAtMs: 1700000001000,
  };
  const projected = projectExpressForModel(deliveredReceipt);
  assert.deepEqual(projected, { status: "delivered" });

  const rejectedReceipt = {
    schemaVersion: "1",
    status: "rejected",
    reason: "SchemaValidationError: text exceeds maximum length",
    createdAtMs: 1700000000000,
  };
  const projectedRej = projectExpressForModel(rejectedReceipt);
  assert.deepEqual(projectedRej, {
    status: "rejected",
    reason: "SchemaValidationError: text exceeds maximum length",
  });
});

test("projectCatalogForModel preserves handles/name/host/state and strips capabilities/canMessage/expiresAtMs/schemaVersion", () => {
  const catalogDetails = {
    schemaVersion: "1",
    kind: "peer_catalog",
    sessions: [
      {
        handle: "psh_target_alpha_123",
        displayName: "Alpha Pet",
        host: "local",
        state: "idle",
        capabilities: ["receive_peer_message"],
        canMessage: true,
        expiresAtMs: 1700000300000,
      },
      {
        handle: "psh_target_beta_456",
        displayName: "Beta Pet",
        host: "homelab",
        state: "running",
        capabilities: ["receive_peer_message"],
        canMessage: true,
        expiresAtMs: 1700000300000,
      },
    ],
  };

  const projected = projectCatalogForModel(catalogDetails);
  assert.deepEqual(projected, {
    sessions: [
      {
        handle: "psh_target_alpha_123",
        displayName: "Alpha Pet",
        host: "local",
        state: "idle",
      },
      {
        handle: "psh_target_beta_456",
        displayName: "Beta Pet",
        host: "homelab",
        state: "running",
      },
    ],
  });
});

test("projectSendForModel preserves status/reason and strips messageId/threadId/hopCount/maxHops/timestamps/schemaVersion", () => {
  const sendDetails = {
    schemaVersion: "1",
    status: "queued",
    messageId: "msg_internal_123",
    threadId: "th_internal_456",
    hopCount: 0,
    maxHops: 1,
    createdAtMs: 1700000000000,
    expiresAtMs: 1700000060000,
  };
  const projected = projectSendForModel(sendDetails);
  assert.deepEqual(projected, { status: "queued" });

  const failedDetails = {
    schemaVersion: "1",
    status: "failed",
    reason: "Target session offline",
  };
  assert.deepEqual(projectSendForModel(failedDetails), {
    status: "failed",
    reason: "Target session offline",
  });
});

test("projectTeamStatusForModel preserves fresh member handles, name, revision, callerRole, and strips canMessage/schemaVersion/kind", () => {
  const teamStatusDetails = {
    schemaVersion: "1",
    kind: "team_status",
    status: "active",
    team: {
      name: "Core Ops",
      revision: 3,
      callerRole: "leader",
      members: [
        {
          displayName: "Pi Leader",
          host: "local",
          state: "idle",
          role: "leader",
          canMessage: false,
        },
        {
          displayName: "Worker Homelab",
          host: "homelab",
          state: "running",
          role: "member",
          handle: "psh_fresh_worker_handle_789",
          canMessage: true,
        },
      ],
    },
  };

  const projected = projectTeamStatusForModel(teamStatusDetails);
  assert.deepEqual(projected, {
    status: "active",
    team: {
      name: "Core Ops",
      revision: 3,
      callerRole: "leader",
      members: [
        {
          displayName: "Pi Leader",
          host: "local",
          state: "idle",
          role: "leader",
        },
        {
          displayName: "Worker Homelab",
          host: "homelab",
          state: "running",
          role: "member",
          handle: "psh_fresh_worker_handle_789",
        },
      ],
    },
  });

  const noneStatus = { schemaVersion: "1", kind: "team_status", status: "none" };
  assert.deepEqual(projectTeamStatusForModel(noneStatus), { status: "none" });
});

test("projectTeamCreateForModel and projectTeamDissolveForModel low-noise projections", () => {
  const createDetails = {
    schemaVersion: "1",
    kind: "team_create",
    status: "active",
    team: {
      name: "Alpha",
      revision: 1,
      callerRole: "leader",
      members: [
        { displayName: "Alice", host: "local", state: "idle", role: "leader", canMessage: false },
      ],
    },
  };
  const projectedCreate = projectTeamCreateForModel(createDetails);
  assert.deepEqual(projectedCreate, {
    status: "active",
    team: {
      name: "Alpha",
      revision: 1,
      callerRole: "leader",
      members: [
        { displayName: "Alice", host: "local", state: "idle", role: "leader" },
      ],
    },
  });

  const dissolveDetails = { schemaVersion: "1", kind: "team_dissolve", status: "dissolved" };
  assert.deepEqual(projectTeamDissolveForModel(dissolveDetails), { status: "dissolved" });
});

test("projectBoardReadForModel preserves markdown, revision, attribution and strips updatedAtMs/schemaVersion", () => {
  const boardReadDetails = {
    schemaVersion: "1",
    kind: "team_board_read",
    status: "active",
    board: {
      revision: 2,
      markdown: "# Task List\n- [x] Item 1\n- [ ] Item 2",
      updatedAtMs: 1700000000000,
      updatedBy: {
        displayName: "Pi Reviewer",
        role: "member",
      },
    },
  };

  const projected = projectBoardReadForModel(boardReadDetails);
  assert.deepEqual(projected, {
    status: "active",
    board: {
      revision: 2,
      markdown: "# Task List\n- [x] Item 1\n- [ ] Item 2",
      updatedBy: {
        displayName: "Pi Reviewer",
        role: "member",
      },
    },
  });
});

test("projectBoardWriteForModel summarizes revision/conflict and strips redundant markdown echo and updatedAtMs", () => {
  const boardWriteSuccess = {
    schemaVersion: "1",
    kind: "team_board_write",
    status: "updated",
    board: {
      revision: 3,
      markdown: "# Full 8KB Markdown text that should NOT be echoed back to model...",
      updatedAtMs: 1700000000000,
      updatedBy: {
        displayName: "Pi Author",
        role: "leader",
      },
    },
  };

  const projectedSuccess = projectBoardWriteForModel(boardWriteSuccess);
  assert.deepEqual(projectedSuccess, {
    status: "updated",
    board: {
      revision: 3,
      updatedBy: {
        displayName: "Pi Author",
        role: "leader",
      },
    },
  });
  assert.equal(projectedSuccess.board.markdown, undefined, "Markdown echo must be stripped from write response");
  assert.equal(projectedSuccess.board.updatedAtMs, undefined, "Timestamps must be stripped");

  const boardWriteConflict = {
    schemaVersion: "1",
    kind: "team_board_write",
    status: "conflict",
    currentRevision: 4,
    reason: "Revision mismatch (expected 2, found 4)",
  };

  const projectedConflict = projectBoardWriteForModel(boardWriteConflict);
  assert.deepEqual(projectedConflict, {
    status: "conflict",
    currentRevision: 4,
    reason: "Revision mismatch (expected 2, found 4)",
  });
});

// ── 3. Human Rendering: Collapsed, Expanded & Leak Prevention ────────────────

const SECRET_PATTERNS = [
  "psh_secret_handle_12345",
  "cmd_internal_command_id",
  "pet_internal_pet_identity",
  "team_internal_uuid_999",
  "msg_internal_message_id",
  "th_internal_thread_id",
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "/home/bruhw/secret/project/path",
  "1700000000000",
  "\"schemaVersion\":",
];

function assertNoSecretLeaks(renderedText, contextName) {
  const str = String(renderedText);
  for (const secret of SECRET_PATTERNS) {
    assert.equal(
      str.includes(secret),
      false,
      `[${contextName}] Leaked forbidden secret "${secret}" in rendered output: ${str}`
    );
  }
}

test("pet_express renderCall and renderResult (collapsed and expanded)", () => {
  const call1 = renderExpressCall({ emotion: "happy", text: "Task done!" }).toString();
  assert.equal(call1, 'pet_express: [happy] "Task done!"');

  const call2 = renderExpressCall({ emotion: "shy" }).toString();
  assert.equal(call2, "pet_express: [shy]");

  const resDeliveredCollapsed = renderExpressResult({ isError: false, details: { status: "delivered" } }, { expanded: false }).toString();
  assert.equal(resDeliveredCollapsed, "Expressed on desktop pet");

  const resDeliveredExpanded = renderExpressResult({ isError: false, details: { status: "delivered" } }, { expanded: true }).toString();
  assert.equal(resDeliveredExpanded, "Expressed on desktop pet successfully.");

  const resError = renderExpressResult({ isError: true, details: { status: "failed", reason: "Session closed" } }, { expanded: false }).toString();
  assert.equal(resError, "Express failed: Session closed");
});

test("pet_list_sessions renderCall and renderResult (collapsed, expanded, no handle leak)", () => {
  const call = renderListSessionsCall({ state: "idle", host: "local" }).toString();
  assert.equal(call, "pet_list_sessions (state=idle, host=local)");

  const details = {
    schemaVersion: "1",
    kind: "peer_catalog",
    sessions: [
      {
        handle: "psh_secret_handle_12345",
        displayName: "Alice",
        host: "local",
        state: "idle",
      },
      {
        handle: "psh_secret_handle_67890",
        displayName: "Bob",
        host: "homelab",
        state: "running",
      },
    ],
  };

  const resCollapsed = renderListSessionsResult({ isError: false, details }, { expanded: false }).toString();
  assert.equal(resCollapsed, "2 pet sessions: Alice @ local (idle), Bob @ homelab (running)");
  assertNoSecretLeaks(resCollapsed, "list_sessions collapsed");

  const resExpanded = renderListSessionsResult({ isError: false, details }, { expanded: true }).toString();
  assert.ok(resExpanded.includes("Active Pet Sessions (2):"));
  assert.ok(resExpanded.includes("• Alice @ local — idle"));
  assert.ok(resExpanded.includes("• Bob @ homelab — running"));
  assertNoSecretLeaks(resExpanded, "list_sessions expanded");

  // 0 sessions case
  const emptyRes = renderListSessionsResult({ isError: false, details: { sessions: [] } }, { expanded: false }).toString();
  assert.equal(emptyRes, "No active pet sessions found");
});

test("pet_send renderCall and renderResult (no target handle leak, collapsed and expanded)", () => {
  const call = renderSendCall({ target: "psh_secret_handle_12345", text: "Hello from testing!" }).toString();
  assert.equal(call, 'pet_send: "Hello from testing!"');
  assertNoSecretLeaks(call, "send call");

  const details = {
    schemaVersion: "1",
    status: "queued",
    messageId: "msg_internal_message_id",
    threadId: "th_internal_thread_id",
  };

  const resCollapsed = renderSendResult({ isError: false, details }, { expanded: false }).toString();
  assert.equal(resCollapsed, "Peer note queued");
  assertNoSecretLeaks(resCollapsed, "send result collapsed");

  const resExpanded = renderSendResult({ isError: false, details }, { expanded: true }).toString();
  assert.ok(resExpanded.includes("Peer note status: queued"));
  assert.ok(resExpanded.includes("Note delivered to coordinator queue."));
  assertNoSecretLeaks(resExpanded, "send result expanded");
});

test("pet_team_create renderCall and renderResult (no handles leak, collapsed and expanded)", () => {
  const call = renderTeamCreateCall({ name: "Dev Squad", targets: ["psh_secret_handle_12345", "psh_secret_handle_67890"] }).toString();
  assert.equal(call, 'pet_team_create: "Dev Squad" (2 members)');
  assertNoSecretLeaks(call, "team_create call");

  const details = {
    schemaVersion: "1",
    kind: "team_create",
    status: "active",
    team: {
      name: "Dev Squad",
      revision: 1,
      callerRole: "leader",
      members: [
        { displayName: "Alice", host: "local", state: "idle", role: "leader" },
        { displayName: "Bob", host: "homelab", state: "running", role: "member" },
      ],
    },
  };

  const resCollapsed = renderTeamCreateResult({ isError: false, details }, { expanded: false }).toString();
  assert.equal(resCollapsed, 'Team "Dev Squad" created (rev 1, 2 members)');
  assertNoSecretLeaks(resCollapsed, "team_create collapsed");

  const resExpanded = renderTeamCreateResult({ isError: false, details }, { expanded: true }).toString();
  assert.ok(resExpanded.includes('Team: "Dev Squad" (Active, Revision 1)'));
  assert.ok(resExpanded.includes("Members (2):"));
  assert.ok(resExpanded.includes("• Alice @ local — leader (idle)"));
  assert.ok(resExpanded.includes("• Bob @ homelab — member (running)"));
  assertNoSecretLeaks(resExpanded, "team_create expanded");
});

test("pet_team_status renderCall and renderResult (none and active team)", () => {
  const call = renderTeamStatusCall({}).toString();
  assert.equal(call, "pet_team_status");

  const resNone = renderTeamStatusResult({ isError: false, details: { status: "none" } }, { expanded: false }).toString();
  assert.equal(resNone, "No active team");

  const activeDetails = {
    schemaVersion: "1",
    status: "active",
    team: {
      name: "Alpha Team",
      revision: 2,
      callerRole: "member",
      members: [
        { displayName: "Leader Pi", host: "local", state: "idle", role: "leader" },
        { displayName: "Worker Pi", host: "homelab", state: "running", role: "member", handle: "psh_secret_handle_12345" },
      ],
    },
  };

  const resCollapsed = renderTeamStatusResult({ isError: false, details: activeDetails }, { expanded: false }).toString();
  assert.equal(resCollapsed, "Team: Alpha Team (member) — 2 members (rev 2)");
  assertNoSecretLeaks(resCollapsed, "team_status collapsed");

  const resExpanded = renderTeamStatusResult({ isError: false, details: activeDetails }, { expanded: true }).toString();
  assert.ok(resExpanded.includes('Team: "Alpha Team" (Revision 2)'));
  assert.ok(resExpanded.includes("Your Role: member"));
  assert.ok(resExpanded.includes("• Worker Pi @ homelab — member (running)"));
  assertNoSecretLeaks(resExpanded, "team_status expanded");
});

test("pet_team_dissolve renderCall and renderResult", () => {
  const call = renderTeamDissolveCall({}).toString();
  assert.equal(call, "pet_team_dissolve");

  const resCollapsed = renderTeamDissolveResult({ isError: false, details: { status: "dissolved" } }, { expanded: false }).toString();
  assert.equal(resCollapsed, "Team dissolved");

  const resExpanded = renderTeamDissolveResult({ isError: false, details: { status: "dissolved" } }, { expanded: true }).toString();
  assert.equal(resExpanded, "Active team has been dissolved successfully.");
});

test("pet_board_read renderCall and renderResult (bounded Markdown preview)", () => {
  const call = renderBoardReadCall({}).toString();
  assert.equal(call, "pet_board_read");

  const resNone = renderBoardReadResult({ isError: false, details: { status: "none" } }, { expanded: false }).toString();
  assert.equal(resNone, "No active team board");

  const mdContent = "# Shared Notes\n\n1. First task\n2. Second task";
  const details = {
    schemaVersion: "1",
    status: "active",
    board: {
      revision: 2,
      markdown: mdContent,
      updatedAtMs: 1700000000000,
      updatedBy: { displayName: "Pi Author", role: "leader" },
    },
  };

  const resCollapsed = renderBoardReadResult({ isError: false, details }, { expanded: false }).toString();
  assert.ok(resCollapsed.includes("Team board (rev 2, by Pi Author (leader)): 4 lines"));
  assertNoSecretLeaks(resCollapsed, "board_read collapsed");

  const resExpanded = renderBoardReadResult({ isError: false, details }, { expanded: true }).toString();
  assert.ok(resExpanded.includes("Team Board (Revision 2, updated by Pi Author (leader)):"));
  assert.ok(resExpanded.includes(mdContent));
  assertNoSecretLeaks(resExpanded, "board_read expanded");
});

test("pet_board_write renderCall and renderResult (summarizes revision/conflict without echoing Markdown)", () => {
  const md = "# Secret project plan\nVery large document content";
  const call = renderBoardWriteCall({ baseRevision: 1, markdown: md }).toString();
  assert.equal(call, `pet_board_write (baseRevision: 1, ${Buffer.byteLength(md, "utf8")} bytes)`);
  assert.equal(call.includes("# Secret project plan"), false, "Call summary must not echo Markdown text");

  // Success case
  const writeSuccess = {
    status: "updated",
    board: {
      revision: 2,
      markdown: md,
      updatedBy: { displayName: "Pi Author", role: "leader" },
    },
  };
  const resSuccessCollapsed = renderBoardWriteResult({ isError: false, details: writeSuccess }, { expanded: false }).toString();
  assert.equal(resSuccessCollapsed, "Team board updated to revision 2");
  assert.equal(resSuccessCollapsed.includes(md), false);

  const resSuccessExpanded = renderBoardWriteResult({ isError: false, details: writeSuccess }, { expanded: true }).toString();
  assert.ok(resSuccessExpanded.includes("Team board updated successfully to revision 2."));
  assert.ok(resSuccessExpanded.includes("Updated by: Pi Author (leader)"));
  assert.equal(resSuccessExpanded.includes(md), false, "Write result must not echo Markdown");

  // Conflict case
  const writeConflict = {
    status: "conflict",
    currentRevision: 3,
    reason: "Revision mismatch",
  };
  const resConflictCollapsed = renderBoardWriteResult({ isError: true, details: writeConflict }, { expanded: false }).toString();
  assert.equal(resConflictCollapsed, "Board update conflict (current rev 3): Revision mismatch");

  const resConflictExpanded = renderBoardWriteResult({ isError: true, details: writeConflict }, { expanded: true }).toString();
  assert.ok(resConflictExpanded.includes("Board Write Conflict:"));
  assert.ok(resConflictExpanded.includes("Current server revision: 3"));
  assert.ok(resConflictExpanded.includes("Reason: Revision mismatch"));
});

// ── 4. Robustness: Fault Tolerance with Partial/Null/Undefined Inputs ─────────

test("renderCall and renderResult tolerate undefined, null, empty, or partial inputs safely", () => {
  const renderCalls = [
    renderExpressCall,
    renderListSessionsCall,
    renderSendCall,
    renderTeamCreateCall,
    renderTeamStatusCall,
    renderTeamDissolveCall,
    renderBoardReadCall,
    renderBoardWriteCall,
  ];

  for (const fn of renderCalls) {
    assert.doesNotThrow(() => fn(undefined));
    assert.doesNotThrow(() => fn(null));
    assert.doesNotThrow(() => fn({}));
    assert.doesNotThrow(() => fn("invalid string"));
    assert.doesNotThrow(() => fn(123));
  }

  const renderResults = [
    renderExpressResult,
    renderListSessionsResult,
    renderSendResult,
    renderTeamCreateResult,
    renderTeamStatusResult,
    renderTeamDissolveResult,
    renderBoardReadResult,
    renderBoardWriteResult,
  ];

  for (const fn of renderResults) {
    assert.doesNotThrow(() => fn(undefined, { expanded: false }));
    assert.doesNotThrow(() => fn(null, { expanded: true }));
    assert.doesNotThrow(() => fn({}, { expanded: false }));
    assert.doesNotThrow(() => fn({ isError: true }, { expanded: true }));
    assert.doesNotThrow(() => fn({ details: null, content: [] }, { expanded: false }));
    assert.doesNotThrow(() => fn({ content: [{ type: "text", text: "invalid json" }] }, { expanded: true }));
  }
});
