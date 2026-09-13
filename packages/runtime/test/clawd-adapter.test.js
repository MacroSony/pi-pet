"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const runtime = require("..");
const {
  buildTeamPresentation,
  createClawdPresentationBridge,
  presentationState,
  stablePetSessionId,
  toPetStatus,
  toStatusPayload,
} = runtime;

const temporaryDirs = [];

afterEach(() => {
  while (temporaryDirs.length) fs.rmSync(temporaryDirs.pop(), { recursive: true, force: true });
});

function makeSession(overrides = {}) {
  return {
    id: "pi:session-a",
    rawSessionId: "session-a",
    profileId: "local",
    agentId: "pi",
    agentName: "Pi",
    state: "working",
    toolName: "edit",
    displayFolder: "pi-pet",
    sourceDisplayLabel: "",
    updatedAt: Date.UTC(2026, 8, 1),
    headless: false,
    lastEvent: { rawEvent: "PreToolUse", at: Date.UTC(2026, 8, 1) },
    ...overrides,
  };
}

function makeStatus(overrides = {}) {
  return {
    state: "editing",
    detail: "Editing project",
    tool: "edit",
    event: "PreToolUse",
    sessionId: "pet_fixture",
    sessionName: "Pi / project",
    timestamp: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("Clawd compatibility adapter", () => {
  it("maps Clawd working sessions to neutral PetStatus", () => {
    const status = toPetStatus(makeSession());
    assert.strictEqual(status.state, "editing");
    assert.strictEqual(status.detail, "Editing pi-pet");
    assert.strictEqual(status.tool, "edit");
    assert.strictEqual(status.sessionName, "Pi / pi-pet");
    assert.match(status.sessionId, /^pet_[a-f0-9]{24}$/);
    assert.strictEqual(status.team, null);
    assert.deepStrictEqual(Object.keys(status), [
      "state", "detail", "tool", "event", "sessionId", "sessionName", "timestamp", "team",
    ]);
  });

  it("preserves the file payload shape and pins the fixture identity", () => {
    const payload = toStatusPayload(makeSession());
    assert.deepStrictEqual(Object.keys(payload), [
      "state", "detail", "tool", "event", "session_id", "session_name", "timestamp", "team",
    ]);
    assert.strictEqual(payload.team, null);
    assert.strictEqual(payload.session_id, "pet_cec55f09cef648db9a003c6c");
    assert.strictEqual(payload.session_id, stablePetSessionId(makeSession()));
  });

  it("prefers Clawd's presentation-safe displayTitle", () => {
    const status = toPetStatus(makeSession({
      displayTitle: "Assistant #A1B2 · Pi",
      displayFolder: "secret-working-directory",
    }));
    assert.strictEqual(status.sessionName, "Assistant #A1B2 · Pi");
    assert.ok(!status.sessionName.includes("secret-working-directory"));
  });

  it("builds an ID-free Team and Board presentation", () => {
    const leader = makeSession({ displayTitle: "Builder · Pi" });
    const member = makeSession({
      id: "pi:session-b",
      rawSessionId: "session-b",
      profileId: "homelab",
      displayTitle: "Reviewer · Pi",
      sourceDisplayLabel: "homelab",
      state: "idle",
      toolName: null,
    });
    const leaderPetId = stablePetSessionId(leader);
    const memberPetId = stablePetSessionId(member);
    const team = {
      teamId: "team_internal_secret",
      name: "Release Crew",
      status: "active",
      members: [
        { petId: leaderPetId, role: "leader" },
        { petId: memberPetId, role: "member" },
      ],
    };
    const projection = buildTeamPresentation(leader, [leader, member], {
      teamStore: { listTeamsForPet: () => [team] },
      teamBoardStore: {
        readBoard: ({ teamId, actor }) => {
          assert.strictEqual(teamId, team.teamId);
          assert.deepStrictEqual(actor, { kind: "member", petId: leaderPetId });
          return { ok: true, board: { revision: 3, markdown: "# Plan\nShip it", updatedByPetId: memberPetId } };
        },
      },
    });
    assert.deepStrictEqual(projection, {
      name: "Release Crew",
      role: "leader",
      members: [
        { displayName: "Builder · Pi", role: "leader", state: "editing", host: "local" },
        { displayName: "Reviewer · Pi", role: "member", state: "idle", host: "homelab" },
      ],
      board: { status: "ready", revision: 3, markdown: "# Plan\nShip it", updatedBy: "Reviewer · Pi" },
    });
    const rendered = JSON.stringify(projection);
    for (const secret of [team.teamId, leaderPetId, memberPetId, "session-a", "session-b"]) {
      assert.ok(!rendered.includes(secret));
    }
  });

  it("fails closed for multiple active Teams and unavailable Boards", () => {
    const session = makeSession();
    const petId = stablePetSessionId(session);
    const team = { teamId: "team_one", name: "One", status: "active", members: [{ petId, role: "leader" }] };
    assert.strictEqual(buildTeamPresentation(session, [session], {
      teamStore: { listTeamsForPet: () => [team, { ...team, teamId: "team_two" }] },
    }), null);
    assert.deepStrictEqual(buildTeamPresentation(session, [session], {
      teamStore: { listTeamsForPet: () => [team] },
      teamBoardStore: { readBoard: () => ({ ok: false, error: "corrupt_board" }) },
    }).board, { status: "unavailable", revision: null, markdown: "", updatedBy: "" });
  });

  it("uses profile identity so remote and local session IDs never collide", () => {
    const local = stablePetSessionId(makeSession({ profileId: "local" }));
    const remote = stablePetSessionId(makeSession({ profileId: "homelab" }));
    assert.notStrictEqual(local, remote);
  });

  it("treats an authoritative SessionEnd as closed", () => {
    const session = makeSession({
      state: "sleeping",
      lastEvent: { rawEvent: "SessionEnd", at: Date.UTC(2026, 8, 1) },
    });
    assert.strictEqual(presentationState(session), "closed");
    assert.strictEqual(toStatusPayload(session).detail, "Session ended");
  });

  it("writes one file and launches exactly one renderer for a live Pi session", () => {
    const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-runtime-"));
    temporaryDirs.push(statusDir);
    const calls = [];
    const bridge = createClawdPresentationBridge({
      enabled: true,
      statusDir,
      rendererBinary: "/opt/claude-status-pet",
      assetsDir: "/opt/pet-assets",
      spawn: (binary, args, options) => {
        calls.push({ binary, args, options });
        return { unref() {}, once() {} };
      },
    });
    const session = makeSession();

    assert.deepStrictEqual(bridge.onSnapshot({ sessions: [session] }), { written: 1, launched: 1 });
    assert.deepStrictEqual(bridge.onSnapshot({ sessions: [session] }), { written: 0, launched: 0 });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].binary, "/opt/claude-status-pet");
    assert.deepStrictEqual(calls[0].args.slice(0, 1), ["run"]);
    assert.ok(calls[0].args.includes("--status-file"));
    assert.ok(calls[0].args.includes("--session-id"));
    assert.ok(calls[0].args.includes("--assets-dir"));

    const petId = stablePetSessionId(session);
    const payload = JSON.parse(fs.readFileSync(path.join(statusDir, `status-${petId}.json`), "utf8"));
    assert.strictEqual(payload.state, "editing");
    assert.strictEqual(payload.session_id, petId);
  });

  it("rewrites on a real event but not on a timestamp-only ripple", () => {
    const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-runtime-"));
    temporaryDirs.push(statusDir);
    const bridge = createClawdPresentationBridge({ enabled: true, statusDir });
    const pre = makeSession({ lastEvent: { rawEvent: "PreToolUse", at: Date.UTC(2026, 8, 1, 0, 0, 1) } });
    const post = makeSession({ lastEvent: { rawEvent: "PostToolUse", at: Date.UTC(2026, 8, 1, 0, 0, 2) } });
    assert.deepStrictEqual(bridge.onSnapshot({ sessions: [pre] }), { written: 1, launched: 0 });
    assert.deepStrictEqual(bridge.onSnapshot({ sessions: [post] }), { written: 1, launched: 0 });
    const rippled = makeSession({
      updatedAt: Date.UTC(2026, 8, 1, 0, 1, 0),
      lastEvent: { rawEvent: "PostToolUse", at: Date.UTC(2026, 8, 1, 0, 0, 2) },
    });
    assert.deepStrictEqual(bridge.onSnapshot({ sessions: [rippled] }), { written: 0, launched: 0 });
  });

  it("does not relaunch a voluntarily exited renderer on idle rebroadcasts", () => {
    const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-runtime-"));
    temporaryDirs.push(statusDir);
    const children = [];
    const bridge = createClawdPresentationBridge({
      enabled: true,
      statusDir,
      rendererBinary: "/opt/claude-status-pet",
      spawn: () => {
        const child = new EventEmitter();
        child.unref = () => {};
        children.push(child);
        return child;
      },
    });
    const session = makeSession();
    assert.deepStrictEqual(bridge.onSnapshot({ sessions: [session] }), { written: 1, launched: 1 });
    children[0].emit("exit", 0, null);
    assert.deepStrictEqual(bridge.onSnapshot({ sessions: [session] }), { written: 0, launched: 0 });
    assert.deepStrictEqual(bridge.onSnapshot({ sessions: [session] }), { written: 0, launched: 0 });
    const working = makeSession({
      toolName: "bash",
      lastEvent: { rawEvent: "PostToolUse", at: Date.UTC(2026, 8, 1, 0, 5, 0) },
    });
    assert.deepStrictEqual(bridge.onSnapshot({ sessions: [working] }), { written: 1, launched: 1 });
    assert.strictEqual(children.length, 2);
  });

  it("does not launch offline sessions but relaunches on return", () => {
    const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-runtime-"));
    temporaryDirs.push(statusDir);
    const children = [];
    const bridge = createClawdPresentationBridge({
      enabled: true,
      statusDir,
      rendererBinary: "/opt/claude-status-pet",
      spawn: () => {
        const child = new EventEmitter();
        child.unref = () => {};
        children.push(child);
        return child;
      },
    });
    assert.strictEqual(bridge.onSnapshot({ sessions: [makeSession({ state: "sleeping" })] }).launched, 0);
    assert.strictEqual(children.length, 0);
    assert.deepStrictEqual(bridge.onSnapshot({ sessions: [makeSession({ state: "idle" })] }), { written: 1, launched: 1 });
    assert.strictEqual(children.length, 1);
  });

  it("marks a missing snapshot session offline instead of fabricating SessionEnd", () => {
    const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-runtime-"));
    temporaryDirs.push(statusDir);
    const bridge = createClawdPresentationBridge({ enabled: true, statusDir });
    const session = makeSession();
    const petId = stablePetSessionId(session);
    bridge.onSnapshot({ sessions: [session] });
    bridge.onSnapshot({ sessions: [] });
    const payload = JSON.parse(fs.readFileSync(path.join(statusDir, `status-${petId}.json`), "utf8"));
    assert.strictEqual(payload.state, "offline");
    assert.strictEqual(payload.event, "SessionMissing");
  });

  it("closes only an authoritative lifecycle end and keeps stable identity", () => {
    const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-runtime-"));
    temporaryDirs.push(statusDir);
    const bridge = createClawdPresentationBridge({ enabled: true, statusDir });
    const session = makeSession();
    const petId = stablePetSessionId(session);
    bridge.onSnapshot({ sessions: [session] });
    assert.strictEqual(bridge.onSessionEnd(session), true);
    bridge.onSnapshot({ sessions: [] });
    const payload = JSON.parse(fs.readFileSync(path.join(statusDir, `status-${petId}.json`), "utf8"));
    assert.strictEqual(payload.state, "closed");
    assert.strictEqual(payload.event, "SessionEnd");
  });

  it("rejects unsafe session IDs before any snapshot write or renderer spawn", () => {
    const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-runtime-"));
    temporaryDirs.push(statusDir);
    const writes = [];
    const bridge = runtime.createPetRuntime({
      enabled: true,
      statusDir,
      rendererBinary: "/opt/renderer",
      spawn: () => { writes.push("spawn"); return { unref() {}, once() {} }; },
      fsApi: {
        mkdirSync() { writes.push("mkdir"); },
        writeFileSync() { writes.push("write"); },
        renameSync() { writes.push("rename"); },
        unlinkSync() {},
      },
    });
    assert.throws(() => bridge.onSnapshot({ statuses: [
      makeStatus({ sessionId: "safe_id" }),
      makeStatus({ sessionId: "../escape" }),
    ] }), /Invalid sessionId/);
    assert.deepStrictEqual(writes, []);
    assert.throws(() => bridge.onSessionEnd(makeStatus({ sessionId: "bad\\\\id" })), /Invalid sessionId/);
  });

  it("copies caller-owned status values before deduplication", () => {
    const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-runtime-"));
    temporaryDirs.push(statusDir);
    const status = makeStatus();
    const bridge = runtime.createPetRuntime({ enabled: true, statusDir });
    assert.deepStrictEqual(bridge.onSnapshot({ statuses: [status] }), { written: 1, launched: 0 });
    status.detail = "changed after handoff";
    assert.deepStrictEqual(bridge.onSnapshot({ statuses: [status] }), { written: 1, launched: 0 });
  });

  it("uses an explicit allowlist and never enables all agents by default", () => {
    const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-runtime-"));
    temporaryDirs.push(statusDir);
    const other = makeSession({ agentId: "codex" });
    const defaultBridge = createClawdPresentationBridge({ enabled: true, statusDir });
    assert.deepStrictEqual(defaultBridge.onSnapshot({ sessions: [other] }), { written: 0, launched: 0 });
    const configured = createClawdPresentationBridge({ enabled: true, statusDir, agentIds: ["codex"] });
    assert.deepStrictEqual(configured.onSnapshot({ sessions: [other] }), { written: 1, launched: 0 });
  });
});

describe("PetStatus fixture contract", () => {
  it("exposes versioned, actual status and non-implemented reaction schemas", () => {
    assert.strictEqual(runtime.API_CONTRACT_VERSION, "1");
    assert.strictEqual(runtime.API_CONTRACT.status.version, "1");
    assert.deepStrictEqual(runtime.API_CONTRACT.status.required, [
      "state", "detail", "tool", "event", "sessionId", "sessionName", "timestamp",
    ]);
    assert.strictEqual(runtime.REACTION_SCHEMA.runtimeImplemented, false);
    assert.strictEqual(runtime.REACTION_SCHEMA.rendererImplemented, true);
    assert.strictEqual(runtime.REACTION_SCHEMA.runtimeImplemented, false);
    assert.strictEqual(runtime.REACTION_SCHEMA.emittedByRuntime, false);
    assert.ok(runtime.REACTION_SCHEMA.fields.message);
    assert.ok(runtime.REACTION_SCHEMA.fields.speak);
    assert.deepStrictEqual(runtime.toStatusFilePayload(makeStatus()), {
      state: "editing",
      detail: "Editing project",
      tool: "edit",
      event: "PreToolUse",
      session_id: "pet_fixture",
      session_name: "Pi / project",
      timestamp: "2026-09-01T00:00:00.000Z",
      team: null,
    });
    assert.strictEqual(runtime.toStatusFilePayload({ session_id: "legacy" }).session_id, undefined);
  });
});
