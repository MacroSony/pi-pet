"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const shim = require(path.join(root, "clawd-on-desk/src/pet-presentation-bridge.js"));
const { buildSessionSnapshot } = require(path.join(root, "clawd-on-desk/src/state-session-snapshot.js"));
const runtime = require("..");

const temporaryDirs = [];
afterEach(() => {
  while (temporaryDirs.length) fs.rmSync(temporaryDirs.pop(), { recursive: true, force: true });
});

function fixtureSession(overrides = {}) {
  return {
    profileId: "local",
    rawSessionId: "fixture",
    agentId: "pi",
    state: "working",
    lastToolName: "Edit",
    cwd: "/tmp/pi-pet",
    recentEvents: [{ event: "PreToolUse", state: "working", at: 1 }],
    updatedAt: 1,
    headless: false,
    ...overrides,
  };
}

function snapshotFor(session) {
  return buildSessionSnapshot(new Map([["pi:fixture", fixtureSession(session)]]), {
    resolveAgentDisplayName: (agentId) => agentId === "pi" ? "Pi" : "",
  });
}

describe("root Clawd shim to runtime integration", () => {
  it("uses the real shim, real root runtime, and real Clawd snapshot builder", () => {
    const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-root-integration-"));
    temporaryDirs.push(statusDir);
    const bridge = shim({
      enabled: true,
      env: { CLAWD_PET_RUNTIME_MODULE: path.join(root, "packages/runtime") },
      statusDir,
    });
    const snapshot = snapshotFor();
    assert.strictEqual(snapshot.sessions[0].toolName, "Edit");
    assert.deepStrictEqual(bridge.onSnapshot(snapshot), { written: 1, launched: 0 });
    const expectedId = "pet_11bb8ac406c8a2f3f8a23c54";
    const payload = JSON.parse(fs.readFileSync(path.join(statusDir, `status-${expectedId}.json`), "utf8"));
    assert.strictEqual(payload.session_id, expectedId);
    assert.strictEqual(payload.state, "editing");
    assert.strictEqual(payload.tool, "Edit");
    assert.strictEqual(payload.session_name, "Pi / pi-pet");
  });

  it("maps the complete Clawd tool/state projection matrix", () => {
    const cases = [
      ["Edit", "working", "editing"],
      ["Read", "working", "reading"],
      ["Grep", "working", "searching"],
      ["Agent", "working", "delegating"],
      ["Bash", "working", "running"],
      [null, "thinking", "thinking"],
      [null, "notification", "waiting"],
      [null, "attention", "idle"],
      [null, "sleeping", "offline"],
      [null, "error", "error"],
      [null, "sleeping", "closed", { recentEvents: [{ event: "SessionEnd", state: "sleeping", at: 2 }] }],
    ];
    for (const [tool, state, expected, extra = {}] of cases) {
      const entry = runtime.toPetStatus(snapshotFor({
        rawSessionId: `${state}-${tool || "none"}`,
        lastToolName: tool,
        state,
        ...extra,
      }).sessions[0]);
      assert.strictEqual(entry.state, expected, `${state}/${tool || "none"}`);
    }
  });

  it("does not write headless sessions or use the disabled shim", () => {
    const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-root-integration-"));
    temporaryDirs.push(statusDir);
    const enabled = shim({
      enabled: true,
      env: { CLAWD_PET_RUNTIME_MODULE: path.join(root, "packages/runtime") },
      statusDir,
    });
    assert.deepStrictEqual(enabled.onSnapshot(snapshotFor({ headless: true })), { written: 0, launched: 0 });
    assert.deepStrictEqual(fs.readdirSync(statusDir), []);

    const disabled = shim({ enabled: false, env: {}, statusDir });
    assert.deepStrictEqual(disabled.onSnapshot(snapshotFor()), { written: 0, launched: 0 });
    assert.deepStrictEqual(fs.readdirSync(statusDir), []);
  });
});
