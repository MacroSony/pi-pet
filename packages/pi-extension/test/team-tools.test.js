"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
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

const PEER_SLOT = Symbol.for("pi-pet.peer-capability.v1");
const VALID_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ROUTING_NONCE = "0123456789abcdef0123456789abcdef";

function setPeerCapabilitySlot(token = VALID_TOKEN, version = 1) {
  globalThis[PEER_SLOT] = Object.freeze({
    version,
    token,
  });
}

function clearPeerCapabilitySlot() {
  delete globalThis[PEER_SLOT];
}

function makeCtx(sessionId, notifications = []) {
  return {
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      notify: (text, level = "info") => {
        notifications.push({ text, level });
      },
    },
  };
}

function startRemoteTestServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        port,
        server,
        close: () =>
          new Promise((res) => {
            if (typeof server.closeAllConnections === "function") {
              server.closeAllConnections();
            }
            server.close(res);
          }),
      });
    });
    server.on("error", reject);
  });
}

function startLocalTestServer(handler) {
  return new Promise((resolve, reject) => {
    let port = 23334;
    function tryListen() {
      if (port > 23337) {
        return reject(new Error("No free local test port in 23333..23337"));
      }
      const currentPort = port;
      const server = http.createServer(handler);
      server.listen(currentPort, "127.0.0.1", () => {
        resolve({
          port: currentPort,
          server,
          close: () =>
            new Promise((res) => {
              if (typeof server.closeAllConnections === "function") {
                server.closeAllConnections();
              }
              server.close(res);
            }),
        });
      });
      server.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
          port++;
          tryListen();
        } else {
          reject(err);
        }
      });
    }
    tryListen();
  });
}

function registerComponents(pi = {}) {
  const tools = new Map();
  const commands = new Map();
  const mockPi = {
    ...pi,
    registerTool(def) {
      if (def && def.name) {
        tools.set(def.name, def);
      }
    },
    registerCommand(name, def) {
      if (name) {
        commands.set(name, def);
      }
    },
  };
  extension(mockPi, { Type: typeboxStub.Type });
  return { tools, commands };
}

test.afterEach(() => {
  clearPeerCapabilitySlot();
  delete process.env.PI_PET_CLAWD_RUNTIME_CONFIG;
  delete process.env.PI_PET_CLAWD_REMOTE_CONFIG;
});

// ── 1. /pet-team-autonomy command tests ────────────────────────────────────────

test("/pet-team-autonomy default off, enable, disable, and status reporting", async () => {
  const { commands } = registerComponents();
  const autonomyCmd = commands.get("pet-team-autonomy");
  assert.ok(autonomyCmd);

  const notifications = [];
  const ctx = makeCtx("ses-alpha", notifications);

  // 1. Default status -> off
  await autonomyCmd.handler("", ctx);
  assert.equal(notifications.length, 1);
  assert.ok(notifications[0].text.includes("off"));

  await autonomyCmd.handler("status", ctx);
  assert.equal(notifications.length, 2);
  assert.ok(notifications[1].text.includes("off"));

  // 2. Enable without capability token in slot -> fails closed
  clearPeerCapabilitySlot();
  await autonomyCmd.handler("on", ctx);
  assert.equal(notifications.length, 3);
  assert.equal(notifications[2].level, "error");
  assert.ok(notifications[2].text.includes("unavailable"));

  // 3. Enable with valid capability token and session
  setPeerCapabilitySlot(VALID_TOKEN);
  await autonomyCmd.handler("on", ctx);
  assert.equal(notifications.length, 4);
  assert.equal(notifications[3].level, "warning");
  assert.ok(notifications[3].text.includes("ON"));

  // 4. Query status -> on
  await autonomyCmd.handler("status", ctx);
  assert.equal(notifications.length, 5);
  assert.ok(notifications[4].text.includes("on"));

  // 5. Disable
  await autonomyCmd.handler("off", ctx);
  assert.equal(notifications.length, 6);
  assert.ok(notifications[5].text.includes("OFF"));

  // 6. Query status -> off
  await autonomyCmd.handler("status", ctx);
  assert.equal(notifications.length, 7);
  assert.ok(notifications[6].text.includes("off"));

  // 7. Invalid sub-command -> error
  await autonomyCmd.handler("unknown_action", ctx);
  assert.equal(notifications.length, 8);
  assert.equal(notifications[7].level, "error");
  assert.ok(notifications[7].text.includes("Usage:"));
});

test("autonomy state resets on session start and disables on session shutdown", async () => {
  let sessionStartHandler = null;
  let sessionShutdownHandler = null;

  const mockPi = {
    on(event, handler) {
      if (event === "session_start") sessionStartHandler = handler;
      if (event === "session_shutdown") sessionShutdownHandler = handler;
    },
  };

  const { commands } = registerComponents(mockPi);
  const autonomyCmd = commands.get("pet-team-autonomy");

  setPeerCapabilitySlot(VALID_TOKEN);

  const notificationsA = [];
  const ctxA = makeCtx("ses-A", notificationsA);

  // Enable on session A
  await autonomyCmd.handler("on", ctxA);
  assert.ok(notificationsA[0].text.includes("ON"));

  // Session start for session B resets autonomy
  const notificationsB = [];
  const ctxB = makeCtx("ses-B", notificationsB);

  // Trigger session start lifecycle event
  assert.ok(typeof sessionStartHandler === "function");
  await sessionStartHandler("ses-B");

  // Query status in session B -> off
  await autonomyCmd.handler("status", ctxB);
  assert.ok(notificationsB[0].text.includes("off"));

  // Enable on session B
  await autonomyCmd.handler("on", ctxB);
  assert.ok(notificationsB[1].text.includes("ON"));

  // Trigger session shutdown lifecycle event
  assert.ok(typeof sessionShutdownHandler === "function");
  await sessionShutdownHandler();

  // Query status after shutdown -> off
  const notificationsAfter = [];
  const ctxAfter = makeCtx("ses-B", notificationsAfter);
  await autonomyCmd.handler("status", ctxAfter);
  assert.ok(notificationsAfter[0].text.includes("off"));
});

// ── 2. Gating for pet_team (create, add, remove, dissolve actions) ───────────

test("pet_team create, add, remove, and dissolve actions are rejected when autonomy is off; status action is not gated", async () => {
  const { tools } = registerComponents();
  const teamTool = tools.get("pet_team");
  assert.ok(teamTool);

  setPeerCapabilitySlot(VALID_TOKEN);
  const ctx = makeCtx("ses-gate");

  // Autonomy is OFF by default
  const createRes = await teamTool.execute(
    "call-1",
    { action: "create", name: "My Team", targets: ["psh_member1"] },
    undefined,
    undefined,
    ctx
  );
  assert.equal(createRes.isError, true);
  const createBody = JSON.parse(createRes.content[0].text);
  assert.equal(createBody.status, "rejected");
  assert.ok(createBody.reason.includes("/pet-team-autonomy on"));

  const addRes = await teamTool.execute(
    "call-add-gate",
    { action: "add", target: "psh_member1" },
    undefined,
    undefined,
    ctx
  );
  assert.equal(addRes.isError, true);
  const addBody = JSON.parse(addRes.content[0].text);
  assert.equal(addBody.status, "rejected");
  assert.ok(addBody.reason.includes("/pet-team-autonomy on"));

  const removeRes = await teamTool.execute(
    "call-rem-gate",
    { action: "remove", member: "pmh_member1" },
    undefined,
    undefined,
    ctx
  );
  assert.equal(removeRes.isError, true);
  const removeBody = JSON.parse(removeRes.content[0].text);
  assert.equal(removeBody.status, "rejected");
  assert.ok(removeBody.reason.includes("/pet-team-autonomy on"));

  const dissolveRes = await teamTool.execute(
    "call-2",
    { action: "dissolve" },
    undefined,
    undefined,
    ctx
  );
  assert.equal(dissolveRes.isError, true);
  const dissolveBody = JSON.parse(dissolveRes.content[0].text);
  assert.equal(dissolveBody.status, "rejected");
  assert.ok(dissolveBody.reason.includes("/pet-team-autonomy on"));

  // pet_team action: "status" is read-only and NOT gated by autonomy (it fails on transport if not configured, not autonomy)
  const statusRes = await teamTool.execute(
    "call-3",
    { action: "status" },
    undefined,
    undefined,
    ctx
  );
  // Transport is unconfigured so fails on config, NOT autonomy
  const statusBody = JSON.parse(statusRes.content[0].text);
  assert.ok(!statusBody.reason.includes("/pet-team-autonomy on"));
});

// ── 3. Strict Parameter & Conditional Validation for pet_team ──────────────────

test("pet_team parameter and strict conditional validation", async () => {
  const { tools, commands } = registerComponents();
  const teamTool = tools.get("pet_team");
  assert.ok(teamTool);
  const autonomyCmd = commands.get("pet-team-autonomy");

  setPeerCapabilitySlot(VALID_TOKEN);
  const ctx = makeCtx("ses-team-val");

  // 1. Non-object / array parameters
  for (const badParam of [null, undefined, "string", 123, true, []]) {
    const res = await teamTool.execute("tc-tv-obj", badParam, undefined, undefined, ctx);
    assert.equal(res.isError, true);
    assert.equal(JSON.parse(res.content[0].text).reason, "Parameters must be an object");
  }

  // 2. Unexpected top-level parameter keys
  const unexpectedRes = await teamTool.execute(
    "tc-tv-unexp",
    { action: "status", unexpectedKey: true },
    undefined,
    undefined,
    ctx
  );
  assert.equal(unexpectedRes.isError, true);
  assert.ok(JSON.parse(unexpectedRes.content[0].text).reason.includes('Unexpected parameter: "unexpectedKey"'));

  // 3. Missing / unknown / invalid action
  for (const badAction of [undefined, null, 123, true, "", "unknown", "invalid", "READ", "STATUS"]) {
    const res = await teamTool.execute("tc-tv-act", { action: badAction }, undefined, undefined, ctx);
    assert.equal(res.isError, true);
    assert.ok(JSON.parse(res.content[0].text).reason.includes("action must be one of: status, create, add, remove, dissolve"));
  }

  // Missing action key in object
  const missingActionRes = await teamTool.execute("tc-tv-noact", {}, undefined, undefined, ctx);
  assert.equal(missingActionRes.isError, true);
  assert.ok(JSON.parse(missingActionRes.content[0].text).reason.includes("action must be one of: status, create, add, remove, dissolve"));

  // 4. action: "status" rejects name, targets, target, member
  const statusNameRes = await teamTool.execute(
    "tc-tv-stat-name",
    { action: "status", name: "Team Alpha" },
    undefined,
    undefined,
    ctx
  );
  assert.equal(statusNameRes.isError, true);
  assert.equal(JSON.parse(statusNameRes.content[0].text).reason, 'Unexpected parameter for action "status": name');

  const statusTargetsRes = await teamTool.execute(
    "tc-tv-stat-tgt",
    { action: "status", targets: ["psh_member1"] },
    undefined,
    undefined,
    ctx
  );
  assert.equal(statusTargetsRes.isError, true);
  assert.equal(JSON.parse(statusTargetsRes.content[0].text).reason, 'Unexpected parameter for action "status": targets');

  const statusTargetRes = await teamTool.execute(
    "tc-tv-stat-single-tgt",
    { action: "status", target: "psh_member1" },
    undefined,
    undefined,
    ctx
  );
  assert.equal(statusTargetRes.isError, true);
  assert.equal(JSON.parse(statusTargetRes.content[0].text).reason, 'Unexpected parameter for action "status": target');

  const statusMemberRes = await teamTool.execute(
    "tc-tv-stat-mem",
    { action: "status", member: "pmh_member1" },
    undefined,
    undefined,
    ctx
  );
  assert.equal(statusMemberRes.isError, true);
  assert.equal(JSON.parse(statusMemberRes.content[0].text).reason, 'Unexpected parameter for action "status": member');

  // 5. action: "dissolve" rejects name, targets, target, member
  const dissolveNameRes = await teamTool.execute(
    "tc-tv-dis-name",
    { action: "dissolve", name: "Team Alpha" },
    undefined,
    undefined,
    ctx
  );
  assert.equal(dissolveNameRes.isError, true);
  assert.equal(JSON.parse(dissolveNameRes.content[0].text).reason, 'Unexpected parameter for action "dissolve": name');

  const dissolveTargetsRes = await teamTool.execute(
    "tc-tv-dis-tgt",
    { action: "dissolve", targets: ["psh_member1"] },
    undefined,
    undefined,
    ctx
  );
  assert.equal(dissolveTargetsRes.isError, true);
  assert.equal(JSON.parse(dissolveTargetsRes.content[0].text).reason, 'Unexpected parameter for action "dissolve": targets');

  const dissolveTargetRes = await teamTool.execute(
    "tc-tv-dis-single-tgt",
    { action: "dissolve", target: "psh_member1" },
    undefined,
    undefined,
    ctx
  );
  assert.equal(dissolveTargetRes.isError, true);
  assert.equal(JSON.parse(dissolveTargetRes.content[0].text).reason, 'Unexpected parameter for action "dissolve": target');

  const dissolveMemberRes = await teamTool.execute(
    "tc-tv-dis-mem",
    { action: "dissolve", member: "pmh_member1" },
    undefined,
    undefined,
    ctx
  );
  assert.equal(dissolveMemberRes.isError, true);
  assert.equal(JSON.parse(dissolveMemberRes.content[0].text).reason, 'Unexpected parameter for action "dissolve": member');

  // 6. action: "create" requires exactly name + targets (when autonomy is on)
  await autonomyCmd.handler("on", ctx);

  // Rejects target or member on create
  const createTargetRes = await teamTool.execute(
    "tc-tv-cr-single-tgt",
    { action: "create", name: "Team Alpha", targets: ["psh_m1"], target: "psh_m2" },
    undefined,
    undefined,
    ctx
  );
  assert.equal(createTargetRes.isError, true);
  assert.equal(JSON.parse(createTargetRes.content[0].text).reason, 'Unexpected parameter for action "create": target');

  const createMemberRes = await teamTool.execute(
    "tc-tv-cr-mem",
    { action: "create", name: "Team Alpha", targets: ["psh_m1"], member: "pmh_m1" },
    undefined,
    undefined,
    ctx
  );
  assert.equal(createMemberRes.isError, true);
  assert.equal(JSON.parse(createMemberRes.content[0].text).reason, 'Unexpected parameter for action "create": member');

  // Missing / invalid name
  for (const badName of [undefined, null, 123, true, {}, []]) {
    const res = await teamTool.execute(
      "tc-tv-cr-noname",
      { action: "create", name: badName, targets: ["psh_member1"] },
      undefined,
      undefined,
      ctx
    );
    assert.equal(res.isError, true);
    assert.equal(JSON.parse(res.content[0].text).reason, "name must be a string");
  }

  // Missing name parameter entirely
  const noNameRes = await teamTool.execute(
    "tc-tv-cr-noname2",
    { action: "create", targets: ["psh_member1"] },
    undefined,
    undefined,
    ctx
  );
  assert.equal(noNameRes.isError, true);
  assert.equal(JSON.parse(noNameRes.content[0].text).reason, "name must be a string");

  // Name length boundaries and control characters
  for (const badName of ["", "   ", "a".repeat(81), "Team\x00Name", "Team\x1fName", "Team\x7fName", "Team\x9fName"]) {
    const res = await teamTool.execute(
      "tc-tv-cr-badname",
      { action: "create", name: badName, targets: ["psh_member1"] },
      undefined,
      undefined,
      ctx
    );
    assert.equal(res.isError, true);
    assert.equal(
      JSON.parse(res.content[0].text).reason,
      "name length must be between 1 and 80 characters without control characters"
    );
  }

  // Missing / invalid targets
  for (const badTargets of [undefined, null, 123, "psh_member1", {}, []]) {
    const res = await teamTool.execute(
      "tc-tv-cr-badtgt",
      { action: "create", name: "Team Alpha", targets: badTargets },
      undefined,
      undefined,
      ctx
    );
    assert.equal(res.isError, true);
    assert.equal(JSON.parse(res.content[0].text).reason, "targets must be an array of 1 to 7 session handles");
  }

  // Missing targets parameter entirely
  const noTargetsRes = await teamTool.execute(
    "tc-tv-cr-notgt",
    { action: "create", name: "Team Alpha" },
    undefined,
    undefined,
    ctx
  );
  assert.equal(noTargetsRes.isError, true);
  assert.equal(JSON.parse(noTargetsRes.content[0].text).reason, "targets must be an array of 1 to 7 session handles");

  // Targets array length > 7
  const eightTargets = Array.from({ length: 8 }, (_, i) => `psh_target_${i}`);
  const overTargetsRes = await teamTool.execute(
    "tc-tv-cr-overtgt",
    { action: "create", name: "Team Alpha", targets: eightTargets },
    undefined,
    undefined,
    ctx
  );
  assert.equal(overTargetsRes.isError, true);
  assert.equal(JSON.parse(overTargetsRes.content[0].text).reason, "targets must be an array of 1 to 7 session handles");

  // Invalid target handle formats (non-psh_ or invalid chars or non-string)
  for (const badTarget of ["not_psh", "psh_", "psh_invalid space", "psh_" + "a".repeat(125), 123, null, {}]) {
    const res = await teamTool.execute(
      "tc-tv-cr-invalhandle",
      { action: "create", name: "Team Alpha", targets: [badTarget] },
      undefined,
      undefined,
      ctx
    );
    assert.equal(res.isError, true);
    assert.equal(JSON.parse(res.content[0].text).reason, "Invalid target: expected a psh_ opaque handle");
  }

  // Duplicate target handles in targets array
  const dupTargetsRes = await teamTool.execute(
    "tc-tv-cr-duptgt",
    { action: "create", name: "Team Alpha", targets: ["psh_member1", "psh_member1"] },
    undefined,
    undefined,
    ctx
  );
  assert.equal(dupTargetsRes.isError, true);
  assert.equal(JSON.parse(dupTargetsRes.content[0].text).reason, "Duplicate target handles in targets array");

  // 7. action: "add" requires exactly target:<psh_> (when autonomy is on)
  // Rejects name, targets, member on add
  const addNameRes = await teamTool.execute(
    "tc-tv-add-name",
    { action: "add", target: "psh_target_1", name: "Team Beta" },
    undefined,
    undefined,
    ctx
  );
  assert.equal(addNameRes.isError, true);
  assert.equal(JSON.parse(addNameRes.content[0].text).reason, 'Unexpected parameter for action "add": name');

  const addTargetsRes = await teamTool.execute(
    "tc-tv-add-tgts",
    { action: "add", target: "psh_target_1", targets: ["psh_target_2"] },
    undefined,
    undefined,
    ctx
  );
  assert.equal(addTargetsRes.isError, true);
  assert.equal(JSON.parse(addTargetsRes.content[0].text).reason, 'Unexpected parameter for action "add": targets');

  const addMemberRes = await teamTool.execute(
    "tc-tv-add-mem",
    { action: "add", target: "psh_target_1", member: "pmh_member_1" },
    undefined,
    undefined,
    ctx
  );
  assert.equal(addMemberRes.isError, true);
  assert.equal(JSON.parse(addMemberRes.content[0].text).reason, 'Unexpected parameter for action "add": member');

  // Missing / invalid target on add
  for (const badTarget of [undefined, null, 123, true, {}, [], "", "not_psh", "psh_", "psh_invalid space", "psh_" + "a".repeat(125)]) {
    const res = await teamTool.execute(
      "tc-tv-add-badtgt",
      { action: "add", target: badTarget },
      undefined,
      undefined,
      ctx
    );
    assert.equal(res.isError, true);
    assert.equal(JSON.parse(res.content[0].text).reason, "Invalid target: expected a psh_ opaque handle");
  }

  // Missing target parameter entirely
  const noAddTargetRes = await teamTool.execute(
    "tc-tv-add-notgt",
    { action: "add" },
    undefined,
    undefined,
    ctx
  );
  assert.equal(noAddTargetRes.isError, true);
  assert.equal(JSON.parse(noAddTargetRes.content[0].text).reason, "Invalid target: expected a psh_ opaque handle");

  // 8. action: "remove" requires exactly member:<pmh_> (when autonomy is on)
  // Rejects name, targets, target on remove
  const remNameRes = await teamTool.execute(
    "tc-tv-rem-name",
    { action: "remove", member: "pmh_member_1", name: "Team Beta" },
    undefined,
    undefined,
    ctx
  );
  assert.equal(remNameRes.isError, true);
  assert.equal(JSON.parse(remNameRes.content[0].text).reason, 'Unexpected parameter for action "remove": name');

  const remTargetsRes = await teamTool.execute(
    "tc-tv-rem-tgts",
    { action: "remove", member: "pmh_member_1", targets: ["psh_target_1"] },
    undefined,
    undefined,
    ctx
  );
  assert.equal(remTargetsRes.isError, true);
  assert.equal(JSON.parse(remTargetsRes.content[0].text).reason, 'Unexpected parameter for action "remove": targets');

  const remTargetRes = await teamTool.execute(
    "tc-tv-rem-tgt",
    { action: "remove", member: "pmh_member_1", target: "psh_target_1" },
    undefined,
    undefined,
    ctx
  );
  assert.equal(remTargetRes.isError, true);
  assert.equal(JSON.parse(remTargetRes.content[0].text).reason, 'Unexpected parameter for action "remove": target');

  // Missing / invalid member on remove
  for (const badMember of [undefined, null, 123, true, {}, [], "", "not_pmh", "pmh_", "psh_member_1", "pmh_invalid space", "pmh_" + "a".repeat(125)]) {
    const res = await teamTool.execute(
      "tc-tv-rem-badmem",
      { action: "remove", member: badMember },
      undefined,
      undefined,
      ctx
    );
    assert.equal(res.isError, true);
    assert.equal(JSON.parse(res.content[0].text).reason, "Invalid member: expected a pmh_ opaque handle");
  }

  // Missing member parameter entirely
  const noRemMemberRes = await teamTool.execute(
    "tc-tv-rem-nomem",
    { action: "remove" },
    undefined,
    undefined,
    ctx
  );
  assert.equal(noRemMemberRes.isError, true);
  assert.equal(JSON.parse(noRemMemberRes.content[0].text).reason, "Invalid member: expected a pmh_ opaque handle");
});

// ── 4. Exact Wire Bodies, Pass-Through & Sanitized Responses ──────────────────

test("exact status, create, add, remove, dissolve wire requests, psh/pmh pass-through, and sanitized responses", async () => {
  const requests = [];
  const server = await startRemoteTestServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({
        path: req.url,
        method: req.method,
        headers: req.headers,
        body,
      });

      res.writeHead(200, {
        "Content-Type": "application/json",
        "x-clawd-server": "clawd-on-desk",
      });

      if (req.url === "/pet-team/status") {
        res.end(
          JSON.stringify({
            schemaVersion: "1",
            kind: "team_status",
            status: "active",
            // Include extra server-internal fields that must be stripped
            teamId: "team_internal_secret_id",
            team: {
              name: "Alpha Squad",
              revision: 1,
              callerRole: "leader",
              members: [
                {
                  displayName: "Leader Pi",
                  host: "local",
                  state: "running",
                  role: "leader",
                  canMessage: false,
                  petId: "pet_internal_caller_petid",
                  rawSessionId: "pi:secret_raw_caller",
                },
                {
                  displayName: "Worker Pi",
                  host: "homelab",
                  state: "idle",
                  role: "member",
                  canMessage: true,
                  handle: "psh_fresh_worker_handle_123",
                  memberRef: "pmh_fresh_worker_member_ref_123",
                  petId: "pet_internal_target_petid",
                  rawSessionId: "pi:secret_raw_worker",
                },
              ],
            },
          })
        );
      } else if (req.url === "/pet-team/create") {
        res.end(
          JSON.stringify({
            schemaVersion: "1",
            kind: "team_create",
            status: "active",
            teamId: "team_internal_created_id",
            team: {
              name: body.name,
              revision: 1,
              callerRole: "leader",
              members: [
                {
                  displayName: "Leader Pi",
                  host: "local",
                  state: "running",
                  role: "leader",
                  canMessage: false,
                },
                {
                  displayName: "Target Pi",
                  host: "local",
                  state: "idle",
                  role: "member",
                  canMessage: true,
                  handle: "psh_new_target_handle_456",
                  memberRef: "pmh_new_target_member_ref_456",
                },
              ],
            },
          })
        );
      } else if (req.url === "/pet-team/add") {
        res.end(
          JSON.stringify({
            schemaVersion: "1",
            kind: "team_add",
            status: "active",
            teamId: "team_internal_added_id",
            team: {
              name: "Alpha Squad",
              revision: 2,
              callerRole: "leader",
              members: [
                {
                  displayName: "Leader Pi",
                  host: "local",
                  state: "running",
                  role: "leader",
                  canMessage: false,
                },
                {
                  displayName: "Worker Pi",
                  host: "homelab",
                  state: "idle",
                  role: "member",
                  canMessage: true,
                  handle: "psh_fresh_worker_handle_123",
                  memberRef: "pmh_fresh_worker_member_ref_123",
                },
                {
                  displayName: "New Member Pi",
                  host: "local",
                  state: "running",
                  role: "member",
                  canMessage: true,
                  handle: "psh_new_member_handle_789",
                  memberRef: "pmh_new_member_ref_789",
                  petId: "pet_internal_new_petid",
                },
              ],
            },
          })
        );
      } else if (req.url === "/pet-team/remove") {
        res.end(
          JSON.stringify({
            schemaVersion: "1",
            kind: "team_remove",
            status: "active",
            teamId: "team_internal_removed_id",
            team: {
              name: "Alpha Squad",
              revision: 3,
              callerRole: "leader",
              members: [
                {
                  displayName: "Leader Pi",
                  host: "local",
                  state: "running",
                  role: "leader",
                  canMessage: false,
                },
              ],
            },
          })
        );
      } else if (req.url === "/pet-team/dissolve") {
        res.end(
          JSON.stringify({
            schemaVersion: "1",
            kind: "team_dissolve",
            status: "dissolved",
            teamId: "team_internal_dissolved_id",
          })
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-team-wire-"));
  const remoteConfigPath = path.join(tmpDir, "clawd-remote.json");
  fs.writeFileSync(
    remoteConfigPath,
    JSON.stringify({
      schemaVersion: 1,
      remotePort: server.port,
      routingNonce: ROUTING_NONCE,
      profileId: "remote-homelab",
    })
  );

  setPeerCapabilitySlot(VALID_TOKEN);
  process.env.PI_PET_CLAWD_RUNTIME_CONFIG = path.join(tmpDir, "nonexistent-runtime.json");
  process.env.PI_PET_CLAWD_REMOTE_CONFIG = remoteConfigPath;

  try {
    const { tools, commands } = registerComponents();
    const autonomyCmd = commands.get("pet-team-autonomy");
    const teamTool = tools.get("pet_team");
    assert.ok(teamTool);

    const rawSessionId = "pi:test-session-leader";
    const ctx = makeCtx(rawSessionId);

    // Enable autonomy
    await autonomyCmd.handler("on", ctx);

    // ── 1. pet_team (action: "status") ──
    const statusResult = await teamTool.execute("tc-stat-1", { action: "status" }, undefined, undefined, ctx);
    assert.equal(statusResult.isError, false);
    assert.equal(requests.length, 1);
    const reqStatus = requests[0];
    assert.equal(reqStatus.path, "/pet-team/status");
    assert.equal(reqStatus.method, "POST");
    assert.equal(reqStatus.headers["x-clawd-routing-nonce"], ROUTING_NONCE);
    assert.deepEqual(reqStatus.body, {
      schemaVersion: "1",
      kind: "team_status",
      rawSessionId,
      capabilityToken: VALID_TOKEN,
    });

    // Verify sanitized status response: no leaked internal IDs/tokens
    const statusJson = statusResult.content[0].text;
    assert.equal(statusJson.includes("team_internal_secret_id"), false);
    assert.equal(statusJson.includes("pet_internal_caller_petid"), false);
    assert.equal(statusJson.includes("pet_internal_target_petid"), false);
    assert.equal(statusJson.includes("pi:secret_raw_caller"), false);
    assert.equal(statusJson.includes("pi:secret_raw_worker"), false);
    assert.equal(statusJson.includes(VALID_TOKEN), false);

    assert.equal(statusResult.details.schemaVersion, "1");
    assert.equal(statusResult.details.kind, "team_status");
    assert.equal(statusResult.details.status, "active");
    assert.equal(statusResult.details.team.name, "Alpha Squad");
    assert.equal(statusResult.details.team.members.length, 2);
    assert.equal(statusResult.details.team.members[1].handle, "psh_fresh_worker_handle_123");

    const statusParsed = JSON.parse(statusJson);
    assert.equal(statusParsed.schemaVersion, undefined);
    assert.equal(statusParsed.kind, undefined);
    assert.equal(statusParsed.status, "active");
    assert.equal(statusParsed.team.name, "Alpha Squad");
    assert.equal(statusParsed.team.members.length, 2);
    assert.equal(statusParsed.team.members[1].handle, "psh_fresh_worker_handle_123");

    // ── 2. pet_team (action: "create" with psh machine-pass-through) ──
    const targetHandles = ["psh_target_alpha_111", "psh_target_beta_222"];
    const createResult = await teamTool.execute(
      "tc-create-1",
      { action: "create", name: "Bravo Squad", targets: targetHandles },
      undefined,
      undefined,
      ctx
    );
    assert.equal(createResult.isError, false);
    assert.equal(requests.length, 2);
    const reqCreate = requests[1];
    assert.equal(reqCreate.path, "/pet-team/create");
    assert.equal(reqCreate.method, "POST");
    assert.equal(reqCreate.headers["x-clawd-routing-nonce"], ROUTING_NONCE);
    assert.deepEqual(reqCreate.body, {
      schemaVersion: "1",
      kind: "team_create",
      rawSessionId,
      capabilityToken: VALID_TOKEN,
      name: "Bravo Squad",
      targets: targetHandles, // Exact machine-pass-through
    });

    const createJson = createResult.content[0].text;
    assert.equal(createJson.includes("team_internal_created_id"), false);
    assert.equal(createJson.includes(VALID_TOKEN), false);
    const createParsed = JSON.parse(createJson);
    assert.equal(createParsed.status, "active");
    assert.equal(createParsed.team.name, "Bravo Squad");

    // ── 3. pet_team (action: "add" with exact psh target pass-through) ──
    const addResult = await teamTool.execute(
      "tc-add-1",
      { action: "add", target: "psh_new_member_handle_789" },
      undefined,
      undefined,
      ctx
    );
    assert.equal(addResult.isError, false);
    assert.equal(requests.length, 3);
    const reqAdd = requests[2];
    assert.equal(reqAdd.path, "/pet-team/add");
    assert.equal(reqAdd.method, "POST");
    assert.equal(reqAdd.headers["x-clawd-routing-nonce"], ROUTING_NONCE);
    assert.deepEqual(reqAdd.body, {
      schemaVersion: "1",
      kind: "team_add",
      rawSessionId,
      capabilityToken: VALID_TOKEN,
      target: "psh_new_member_handle_789",
    });

    const addJson = addResult.content[0].text;
    assert.equal(addJson.includes("team_internal_added_id"), false);
    assert.equal(addJson.includes("pet_internal_new_petid"), false);
    assert.equal(addJson.includes(VALID_TOKEN), false);
    const addParsed = JSON.parse(addJson);
    assert.equal(addParsed.status, "active");
    assert.equal(addParsed.team.name, "Alpha Squad");
    assert.equal(addParsed.team.revision, 2);
    assert.equal(addParsed.team.members.length, 3);
    assert.equal(addParsed.team.members[2].handle, "psh_new_member_handle_789");
    assert.equal(addParsed.team.members[2].memberRef, "pmh_new_member_ref_789");

    // ── 4. pet_team (action: "remove" with exact pmh member pass-through) ──
    const removeResult = await teamTool.execute(
      "tc-rem-1",
      { action: "remove", member: "pmh_new_member_ref_789" },
      undefined,
      undefined,
      ctx
    );
    assert.equal(removeResult.isError, false);
    assert.equal(requests.length, 4);
    const reqRemove = requests[3];
    assert.equal(reqRemove.path, "/pet-team/remove");
    assert.equal(reqRemove.method, "POST");
    assert.equal(reqRemove.headers["x-clawd-routing-nonce"], ROUTING_NONCE);
    assert.deepEqual(reqRemove.body, {
      schemaVersion: "1",
      kind: "team_remove",
      rawSessionId,
      capabilityToken: VALID_TOKEN,
      member: "pmh_new_member_ref_789",
    });

    const removeJson = removeResult.content[0].text;
    assert.equal(removeJson.includes("team_internal_removed_id"), false);
    assert.equal(removeJson.includes(VALID_TOKEN), false);
    const removeParsed = JSON.parse(removeJson);
    assert.equal(removeParsed.status, "active");
    assert.equal(removeParsed.team.name, "Alpha Squad");
    assert.equal(removeParsed.team.revision, 3);
    assert.equal(removeParsed.team.members.length, 1);

    // ── 5. pet_team (action: "dissolve") ──
    const dissolveResult = await teamTool.execute(
      "tc-dissolve-1",
      { action: "dissolve" },
      undefined,
      undefined,
      ctx
    );
    assert.equal(dissolveResult.isError, false);
    assert.equal(requests.length, 5);
    const reqDissolve = requests[4];
    assert.equal(reqDissolve.path, "/pet-team/dissolve");
    assert.equal(reqDissolve.method, "POST");
    assert.equal(reqDissolve.headers["x-clawd-routing-nonce"], ROUTING_NONCE);
    assert.deepEqual(reqDissolve.body, {
      schemaVersion: "1",
      kind: "team_dissolve",
      rawSessionId,
      capabilityToken: VALID_TOKEN,
    });

    const dissolveJson = dissolveResult.content[0].text;
    assert.equal(dissolveJson.includes("team_internal_dissolved_id"), false);
    assert.equal(dissolveJson.includes(VALID_TOKEN), false);
    const dissolveParsed = JSON.parse(dissolveJson);
    assert.equal(dissolveParsed.status, "dissolved");
  } finally {
    await server.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});

test("pet_team add and remove OCC conflict handling and server error formatting", async () => {
  const server = await startRemoteTestServer((req, res) => {
    if (req.url === "/pet-team/add") {
      res.writeHead(409, {
        "Content-Type": "application/json",
        "x-clawd-server": "clawd-on-desk",
      });
      res.end(
        JSON.stringify({
          schemaVersion: "1",
          kind: "team_add",
          status: "conflict",
          reason: "Revision mismatch",
          currentRevision: 5,
        })
      );
    } else if (req.url === "/pet-team/remove") {
      res.writeHead(409, {
        "Content-Type": "application/json",
        "x-clawd-server": "clawd-on-desk",
      });
      res.end(
        JSON.stringify({
          schemaVersion: "1",
          kind: "team_remove",
          status: "conflict",
          reason: "Revision mismatch",
          currentRevision: 6,
        })
      );
    } else {
      res.writeHead(500, {
        "Content-Type": "application/json",
        "x-clawd-server": "clawd-on-desk",
      });
      res.end(
        JSON.stringify({
          schemaVersion: "1",
          status: "failed",
          reason: "Internal coordinator error",
        })
      );
    }
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-team-conflict-"));
  const remoteConfigPath = path.join(tmpDir, "clawd-remote.json");
  fs.writeFileSync(
    remoteConfigPath,
    JSON.stringify({
      schemaVersion: 1,
      remotePort: server.port,
      routingNonce: ROUTING_NONCE,
      profileId: "remote-homelab",
    })
  );

  setPeerCapabilitySlot(VALID_TOKEN);
  process.env.PI_PET_CLAWD_RUNTIME_CONFIG = path.join(tmpDir, "nonexistent-runtime.json");
  process.env.PI_PET_CLAWD_REMOTE_CONFIG = remoteConfigPath;

  try {
    const { tools, commands } = registerComponents();
    const autonomyCmd = commands.get("pet-team-autonomy");
    const teamTool = tools.get("pet_team");

    const ctx = makeCtx("pi:test-session-leader");
    await autonomyCmd.handler("on", ctx);

    // 1. Add conflict
    const addRes = await teamTool.execute("tc-add-conf", { action: "add", target: "psh_target_123" }, undefined, undefined, ctx);
    assert.equal(addRes.isError, true);
    const addBody = JSON.parse(addRes.content[0].text);
    assert.equal(addBody.status, "conflict");
    assert.equal(addBody.reason, "Revision mismatch");
    assert.equal(addBody.currentRevision, 5);

    // 2. Remove conflict
    const remRes = await teamTool.execute("tc-rem-conf", { action: "remove", member: "pmh_member_456" }, undefined, undefined, ctx);
    assert.equal(remRes.isError, true);
    const remBody = JSON.parse(remRes.content[0].text);
    assert.equal(remBody.status, "conflict");
    assert.equal(remBody.reason, "Revision mismatch");
    assert.equal(remBody.currentRevision, 6);
  } finally {
    await server.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});

// ── 5. Unit sanitization tests ────────────────────────────────────────────────

test("sanitizeTeamDetails, sanitizeTeamObject, and sanitizeTeamMember enforce strict projections", () => {
  const rawMember = {
    displayName: "  Node Pi\x00  ",
    host: "local\t",
    state: "running",
    role: "leader",
    canMessage: true,
    handle: "psh_valid_123",
    memberRef: "pmh_valid_member_123",
    petId: "secret_pet",
    rawSessionId: "secret_session",
  };
  const memberSanitized = extension.sanitizeTeamMember(rawMember);
  assert.deepEqual(memberSanitized, {
    displayName: "Node Pi",
    host: "local",
    state: "running",
    role: "leader",
    canMessage: true,
    handle: "psh_valid_123",
    memberRef: "pmh_valid_member_123",
  });
  assert.equal(memberSanitized.petId, undefined);
  assert.equal(memberSanitized.rawSessionId, undefined);

  // Invalid handle format is omitted
  const badHandleMember = extension.sanitizeTeamMember({ ...rawMember, handle: "invalid_handle" });
  assert.equal(badHandleMember.handle, undefined);

  // Invalid memberRef format is omitted
  const badMemberRef = extension.sanitizeTeamMember({ ...rawMember, memberRef: "psh_not_pmh" });
  assert.equal(badMemberRef.memberRef, undefined);

  const badMemberRef2 = extension.sanitizeTeamMember({ ...rawMember, memberRef: "pmh_" });
  assert.equal(badMemberRef2.memberRef, undefined);

  // Full team details sanitization
  const rawTeamData = {
    schemaVersion: "1",
    kind: "team_status",
    status: "active",
    teamId: "team_leak",
    team: {
      name: "Super Team",
      revision: 2,
      callerRole: "leader",
      secretField: "do_not_leak",
      members: [rawMember],
    },
  };
  const teamSanitized = extension.sanitizeTeamDetails(rawTeamData);
  assert.deepEqual(teamSanitized, {
    schemaVersion: "1",
    kind: "team_status",
    status: "active",
    team: {
      name: "Super Team",
      revision: 2,
      callerRole: "leader",
      members: [
        {
          displayName: "Node Pi",
          host: "local",
          state: "running",
          role: "leader",
          canMessage: true,
          handle: "psh_valid_123",
          memberRef: "pmh_valid_member_123",
        },
      ],
    },
  });
  assert.equal(teamSanitized.teamId, undefined);
  assert.equal(teamSanitized.team.secretField, undefined);
});

// ── 6. /pet-board-write command tests ──────────────────────────────────────────

test("/pet-board-write default off, enable, disable, and status reporting", async () => {
  const { commands } = registerComponents();
  const boardWriteCmd = commands.get("pet-board-write");
  assert.ok(boardWriteCmd);

  const notifications = [];
  const ctx = makeCtx("ses-board", notifications);

  // 1. Default status -> off
  await boardWriteCmd.handler("", ctx);
  assert.equal(notifications.length, 1);
  assert.ok(notifications[0].text.includes("off"));

  await boardWriteCmd.handler("status", ctx);
  assert.equal(notifications.length, 2);
  assert.ok(notifications[1].text.includes("off"));

  // 2. Enable without capability token in slot -> fails closed
  clearPeerCapabilitySlot();
  await boardWriteCmd.handler("on", ctx);
  assert.equal(notifications.length, 3);
  assert.equal(notifications[2].level, "error");
  assert.ok(notifications[2].text.includes("unavailable"));

  // 3. Enable with valid capability token and session
  setPeerCapabilitySlot(VALID_TOKEN);
  await boardWriteCmd.handler("on", ctx);
  assert.equal(notifications.length, 4);
  assert.equal(notifications[3].level, "warning");
  assert.ok(notifications[3].text.includes("ON"));

  // 4. Query status -> on
  await boardWriteCmd.handler("status", ctx);
  assert.equal(notifications.length, 5);
  assert.ok(notifications[4].text.includes("on"));

  // 5. Disable
  await boardWriteCmd.handler("off", ctx);
  assert.equal(notifications.length, 6);
  assert.ok(notifications[5].text.includes("OFF"));

  // 6. Query status -> off
  await boardWriteCmd.handler("status", ctx);
  assert.equal(notifications.length, 7);
  assert.ok(notifications[6].text.includes("off"));

  // 7. Invalid sub-command -> error
  await boardWriteCmd.handler("unknown_action", ctx);
  assert.equal(notifications.length, 8);
  assert.equal(notifications[7].level, "error");
  assert.ok(notifications[7].text.includes("Usage:"));
});

test("board write state resets on session start and disables on session shutdown", async () => {
  let sessionStartHandler = null;
  let sessionShutdownHandler = null;

  const mockPi = {
    on(event, handler) {
      if (event === "session_start") sessionStartHandler = handler;
      if (event === "session_shutdown") sessionShutdownHandler = handler;
    },
  };

  const { commands } = registerComponents(mockPi);
  const boardWriteCmd = commands.get("pet-board-write");

  setPeerCapabilitySlot(VALID_TOKEN);

  const notificationsA = [];
  const ctxA = makeCtx("ses-board-A", notificationsA);

  // Enable on session A
  await boardWriteCmd.handler("on", ctxA);
  assert.ok(notificationsA[0].text.includes("ON"));

  // Session start for session B resets board write state
  const notificationsB = [];
  const ctxB = makeCtx("ses-board-B", notificationsB);

  assert.ok(typeof sessionStartHandler === "function");
  await sessionStartHandler("ses-board-B");

  // Query status in session B -> off
  await boardWriteCmd.handler("status", ctxB);
  assert.ok(notificationsB[0].text.includes("off"));

  // Enable on session B
  await boardWriteCmd.handler("on", ctxB);
  assert.ok(notificationsB[1].text.includes("ON"));

  // Trigger session shutdown lifecycle event
  assert.ok(typeof sessionShutdownHandler === "function");
  await sessionShutdownHandler();

  // Query status after shutdown -> off
  const notificationsAfter = [];
  const ctxAfter = makeCtx("ses-board-B", notificationsAfter);
  await boardWriteCmd.handler("status", ctxAfter);
  assert.ok(notificationsAfter[0].text.includes("off"));
});

// ── 7. Gating for pet_board (write action) ──────────────────────────────────────

test("pet_board write action is rejected when /pet-board-write is off; read action is not gated", async () => {
  const { tools, commands } = registerComponents();
  const boardTool = tools.get("pet_board");
  assert.ok(boardTool);
  const boardWriteCmd = commands.get("pet-board-write");

  setPeerCapabilitySlot(VALID_TOKEN);
  const ctx = makeCtx("ses-board-gate");

  // Board write is OFF by default
  const writeRes = await boardTool.execute(
    "call-1",
    { action: "write", baseRevision: 0, markdown: "# Hello" },
    undefined,
    undefined,
    ctx
  );
  assert.equal(writeRes.isError, true);
  const writeBody = JSON.parse(writeRes.content[0].text);
  assert.equal(writeBody.status, "rejected");
  assert.ok(writeBody.reason.includes("/pet-board-write on"));

  // pet_board action: "read" is read-only and NOT gated by /pet-board-write
  const readRes = await boardTool.execute(
    "call-2",
    { action: "read" },
    undefined,
    undefined,
    ctx
  );
  // Transport is unconfigured so it fails on transport config, NOT board write gating
  const readBody = JSON.parse(readRes.content[0].text);
  assert.ok(!readBody.reason.includes("/pet-board-write on"));

  // Enabling on session-1 does not enable on session-2 (session isolation)
  await boardWriteCmd.handler("on", makeCtx("ses-board-session-1"));
  const writeRes2 = await boardTool.execute(
    "call-3",
    { action: "write", baseRevision: 0, markdown: "# Hello" },
    undefined,
    undefined,
    makeCtx("ses-board-session-2")
  );
  assert.equal(writeRes2.isError, true);
  const writeBody2 = JSON.parse(writeRes2.content[0].text);
  assert.equal(writeBody2.status, "rejected");
  assert.ok(writeBody2.reason.includes("/pet-board-write on"));
});

// ── 8. Strict Parameter & Conditional Validation for pet_board ─────────────────

test("pet_board parameter and strict conditional validation", async () => {
  const { tools, commands } = registerComponents();
  const boardTool = tools.get("pet_board");
  assert.ok(boardTool);
  const boardWriteCmd = commands.get("pet-board-write");

  setPeerCapabilitySlot(VALID_TOKEN);
  const ctx = makeCtx("ses-board-val");

  // 1. Non-object / array parameters
  for (const badParam of [null, undefined, "string", 123, true, []]) {
    const res = await boardTool.execute("tc-bv-obj", badParam, undefined, undefined, ctx);
    assert.equal(res.isError, true);
    assert.equal(JSON.parse(res.content[0].text).reason, "Parameters must be an object");
  }

  // 2. Unexpected top-level parameter keys
  const unexpectedRes = await boardTool.execute(
    "tc-bv-unexp",
    { action: "read", extra: true },
    undefined,
    undefined,
    ctx
  );
  assert.equal(unexpectedRes.isError, true);
  assert.ok(JSON.parse(unexpectedRes.content[0].text).reason.includes('Unexpected parameter: "extra"'));

  // 3. Missing / unknown / invalid action
  for (const badAction of [undefined, null, 123, true, "", "unknown", "invalid", "READ", "WRITE"]) {
    const res = await boardTool.execute("tc-bv-act", { action: badAction }, undefined, undefined, ctx);
    assert.equal(res.isError, true);
    assert.ok(JSON.parse(res.content[0].text).reason.includes("action must be one of: read, write"));
  }

  // Missing action key in object
  const missingActionRes = await boardTool.execute("tc-bv-noact", {}, undefined, undefined, ctx);
  assert.equal(missingActionRes.isError, true);
  assert.ok(JSON.parse(missingActionRes.content[0].text).reason.includes("action must be one of: read, write"));

  // 4. action: "read" rejects baseRevision and markdown
  const readRevRes = await boardTool.execute(
    "tc-bv-rd-rev",
    { action: "read", baseRevision: 0 },
    undefined,
    undefined,
    ctx
  );
  assert.equal(readRevRes.isError, true);
  assert.equal(JSON.parse(readRevRes.content[0].text).reason, 'Unexpected parameter for action "read": baseRevision');

  const readMdRes = await boardTool.execute(
    "tc-bv-rd-md",
    { action: "read", markdown: "# Hello" },
    undefined,
    undefined,
    ctx
  );
  assert.equal(readMdRes.isError, true);
  assert.equal(JSON.parse(readMdRes.content[0].text).reason, 'Unexpected parameter for action "read": markdown');

  const readBothRes = await boardTool.execute(
    "tc-bv-rd-both",
    { action: "read", baseRevision: 0, markdown: "# Hello" },
    undefined,
    undefined,
    ctx
  );
  assert.equal(readBothRes.isError, true);
  assert.equal(JSON.parse(readBothRes.content[0].text).reason, 'Unexpected parameter for action "read": baseRevision');

  // 5. action: "write" requires both baseRevision and markdown (when /pet-board-write is on)
  await boardWriteCmd.handler("on", ctx);

  // Missing baseRevision
  const writeNoRevRes = await boardTool.execute(
    "tc-bv-wr-norev",
    { action: "write", markdown: "# Hello" },
    undefined,
    undefined,
    ctx
  );
  assert.equal(writeNoRevRes.isError, true);
  assert.equal(JSON.parse(writeNoRevRes.content[0].text).reason, "baseRevision must be a non-negative safe integer");

  // Invalid baseRevision: must be non-negative safe integer
  for (const badRev of [-1, 1.5, NaN, Infinity, -Infinity, "0", null, undefined, {}, []]) {
    const res = await boardTool.execute(
      "tc-bv-wr-badrev",
      { action: "write", baseRevision: badRev, markdown: "test" },
      undefined,
      undefined,
      ctx
    );
    assert.equal(res.isError, true);
    assert.ok(JSON.parse(res.content[0].text).reason.includes("baseRevision must be a non-negative safe integer"));
  }

  // Missing markdown
  const writeNoMdRes = await boardTool.execute(
    "tc-bv-wr-nomd",
    { action: "write", baseRevision: 0 },
    undefined,
    undefined,
    ctx
  );
  assert.equal(writeNoMdRes.isError, true);
  assert.equal(JSON.parse(writeNoMdRes.content[0].text).reason, "markdown must be a string");

  // Invalid markdown: must be string
  for (const badMd of [123, null, undefined, {}, [], true]) {
    const res = await boardTool.execute(
      "tc-bv-wr-badmd",
      { action: "write", baseRevision: 0, markdown: badMd },
      undefined,
      undefined,
      ctx
    );
    assert.equal(res.isError, true);
    assert.ok(JSON.parse(res.content[0].text).reason.includes("markdown must be a string"));
  }

  // markdown: byte length <= 8192 bytes
  const oversizedMd = "a".repeat(8193);
  const resOver = await boardTool.execute(
    "tc-bv-wr-over",
    { action: "write", baseRevision: 0, markdown: oversizedMd },
    undefined,
    undefined,
    ctx
  );
  assert.equal(resOver.isError, true);
  assert.ok(JSON.parse(resOver.content[0].text).reason.includes("markdown byte length exceeds maximum 8192 UTF-8 bytes"));

  // markdown: disallowed C0/C1 control characters
  for (const badChar of ["\x00", "\x01", "\x08", "\x0B", "\x0C", "\x0E", "\x1F", "\x7F", "\x80", "\x9F"]) {
    const resCtrl = await boardTool.execute(
      "tc-bv-wr-ctrl",
      { action: "write", baseRevision: 0, markdown: `Hello${badChar}World` },
      undefined,
      undefined,
      ctx
    );
    assert.equal(resCtrl.isError, true);
    assert.ok(JSON.parse(resCtrl.content[0].text).reason.includes("markdown contains disallowed control characters"));
  }
});

// ── 9. Remote Wire Requests, OCC Conflict Handling & Sanitized Responses ──────

test("exact board read and write remote wire requests, OCC conflict handling, and sanitized responses", async () => {
  const requests = [];
  let boardState = null;

  const server = await startRemoteTestServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({
        path: req.url,
        method: req.method,
        headers: req.headers,
        body,
      });

      if (req.url === "/pet-team/board/read") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "x-clawd-server": "clawd-on-desk",
        });
        if (!boardState) {
          res.end(
            JSON.stringify({
              schemaVersion: "1",
              kind: "team_board_read",
              status: "none",
              teamId: "secret_team_1",
              petId: "secret_pet_1",
            })
          );
        } else {
          res.end(
            JSON.stringify({
              schemaVersion: "1",
              kind: "team_board_read",
              status: "active",
              teamId: "secret_team_1",
              petId: "secret_pet_1",
              rawSessionId: "pi:secret_caller",
              token: "secret_token",
              board: {
                revision: boardState.revision,
                markdown: boardState.markdown,
                updatedAtMs: boardState.updatedAtMs,
                updatedByPetId: "secret_updater_pet",
                teamId: "secret_team_1",
                updatedBy: {
                  displayName: "Pi Author",
                  role: "leader",
                  petId: "secret_updater_pet",
                  host: "secret_host",
                },
              },
            })
          );
        }
      } else if (req.url === "/pet-team/board/write") {
        if (boardState && body.baseRevision !== boardState.revision) {
          res.writeHead(409, {
            "Content-Type": "application/json",
            "x-clawd-server": "clawd-on-desk",
          });
          res.end(
            JSON.stringify({
              schemaVersion: "1",
              kind: "team_board_write",
              status: "conflict",
              reason: "Revision mismatch",
              currentRevision: boardState.revision,
              teamId: "secret_team_1",
              rawSessionId: "pi:secret_session",
            })
          );
          return;
        }

        const newRevision = (boardState ? boardState.revision : 0) + 1;
        boardState = {
          revision: newRevision,
          markdown: body.markdown,
          updatedAtMs: 1700000000000,
        };

        res.writeHead(200, {
          "Content-Type": "application/json",
          "x-clawd-server": "clawd-on-desk",
        });
        res.end(
          JSON.stringify({
            schemaVersion: "1",
            kind: "team_board_write",
            status: "updated",
            teamId: "secret_team_1",
            board: {
              revision: boardState.revision,
              markdown: boardState.markdown,
              updatedAtMs: boardState.updatedAtMs,
              updatedBy: {
                displayName: "Pi Writer",
                role: "member",
              },
            },
          })
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-board-wire-"));
  const remoteConfigPath = path.join(tmpDir, "clawd-remote.json");
  fs.writeFileSync(
    remoteConfigPath,
    JSON.stringify({
      schemaVersion: 1,
      remotePort: server.port,
      routingNonce: ROUTING_NONCE,
      profileId: "remote-homelab",
    })
  );

  setPeerCapabilitySlot(VALID_TOKEN);
  process.env.PI_PET_CLAWD_RUNTIME_CONFIG = path.join(tmpDir, "nonexistent-runtime.json");
  process.env.PI_PET_CLAWD_REMOTE_CONFIG = remoteConfigPath;

  try {
    const { tools, commands } = registerComponents();
    const boardWriteCmd = commands.get("pet-board-write");
    const boardTool = tools.get("pet_board");
    assert.ok(boardTool);

    const rawSessionId = "pi:test-session-board";
    const ctx = makeCtx(rawSessionId);

    // Enable board write
    await boardWriteCmd.handler("on", ctx);

    // ── 1. pet_board (action: "read" when status is none) ──
    const read1 = await boardTool.execute("tc-read-1", { action: "read" }, undefined, undefined, ctx);
    assert.equal(read1.isError, false);
    assert.equal(requests.length, 1);
    const req1 = requests[0];
    assert.equal(req1.path, "/pet-team/board/read");
    assert.equal(req1.method, "POST");
    assert.equal(req1.headers["x-clawd-routing-nonce"], ROUTING_NONCE);
    assert.deepEqual(req1.body, {
      schemaVersion: "1",
      kind: "team_board_read",
      rawSessionId,
      capabilityToken: VALID_TOKEN,
    });

    const read1Json = read1.content[0].text;
    assert.equal(read1Json.includes("secret_team_1"), false);
    assert.equal(read1Json.includes("secret_pet_1"), false);
    assert.equal(read1Json.includes(VALID_TOKEN), false);
    assert.equal(read1.details.schemaVersion, "1");
    assert.equal(read1.details.kind, "team_board_read");
    assert.equal(read1.details.status, "none");
    assert.equal(read1.details.board, undefined);

    const read1Parsed = JSON.parse(read1Json);
    assert.equal(read1Parsed.schemaVersion, undefined);
    assert.equal(read1Parsed.kind, undefined);
    assert.equal(read1Parsed.status, "none");
    assert.equal(read1Parsed.board, undefined);

    // ── 2. pet_board (action: "write", initial write with baseRevision 0) ──
    const initialMarkdown = "# Team Board\n\n- Task 1: Complete tests\t[done]\r\n- Task 2: Review PR 🚀";
    const write1 = await boardTool.execute(
      "tc-write-1",
      { action: "write", baseRevision: 0, markdown: initialMarkdown },
      undefined,
      undefined,
      ctx
    );
    assert.equal(write1.isError, false);
    assert.equal(requests.length, 2);
    const req2 = requests[1];
    assert.equal(req2.path, "/pet-team/board/write");
    assert.equal(req2.method, "POST");
    assert.equal(req2.headers["x-clawd-routing-nonce"], ROUTING_NONCE);
    assert.deepEqual(req2.body, {
      schemaVersion: "1",
      kind: "team_board_write",
      rawSessionId,
      capabilityToken: VALID_TOKEN,
      baseRevision: 0,
      markdown: initialMarkdown,
    });

    const write1Json = write1.content[0].text;
    assert.equal(write1Json.includes("secret_team_1"), false);
    assert.equal(write1Json.includes(VALID_TOKEN), false);
    assert.equal(write1.details.schemaVersion, "1");
    assert.equal(write1.details.kind, "team_board_write");
    assert.equal(write1.details.status, "updated");
    assert.equal(write1.details.board.revision, 1);
    assert.equal(write1.details.board.markdown, initialMarkdown);
    assert.equal(write1.details.board.updatedAtMs, 1700000000000);
    assert.deepEqual(write1.details.board.updatedBy, { displayName: "Pi Writer", role: "member" });

    const write1Parsed = JSON.parse(write1Json);
    assert.equal(write1Parsed.schemaVersion, undefined);
    assert.equal(write1Parsed.kind, undefined);
    assert.equal(write1Parsed.status, "updated");
    assert.equal(write1Parsed.board.revision, 1);
    assert.equal(write1Parsed.board.markdown, undefined);
    assert.equal(write1Parsed.board.updatedAtMs, undefined);
    assert.deepEqual(write1Parsed.board.updatedBy, { displayName: "Pi Writer", role: "member" });

    // ── 3. pet_board (action: "read" after write) ──
    const read2 = await boardTool.execute("tc-read-2", { action: "read" }, undefined, undefined, ctx);
    assert.equal(read2.isError, false);
    assert.equal(requests.length, 3);
    const read2Json = read2.content[0].text;
    assert.equal(read2Json.includes("secret_team_1"), false);
    assert.equal(read2Json.includes("secret_pet_1"), false);
    assert.equal(read2Json.includes("secret_updater_pet"), false);
    assert.equal(read2Json.includes("secret_host"), false);
    assert.equal(read2Json.includes(VALID_TOKEN), false);
    const read2Parsed = JSON.parse(read2Json);
    assert.equal(read2Parsed.status, "active");
    assert.equal(read2Parsed.board.revision, 1);
    assert.equal(read2Parsed.board.markdown, initialMarkdown);
    assert.deepEqual(read2Parsed.board.updatedBy, { displayName: "Pi Author", role: "leader" });

    // ── 4. pet_board (action: "write", 409 conflict on stale baseRevision) ──
    const writeConflict = await boardTool.execute(
      "tc-write-conflict",
      { action: "write", baseRevision: 0, markdown: "# Stale Write" }, // stale: baseRevision 0 instead of 1
      undefined,
      undefined,
      ctx
    );
    assert.equal(writeConflict.isError, true);
    assert.equal(requests.length, 4);
    const writeConflictJson = writeConflict.content[0].text;
    assert.equal(writeConflictJson.includes("secret_team_1"), false);
    assert.equal(writeConflictJson.includes("pi:secret_session"), false);
    assert.equal(writeConflictJson.includes(VALID_TOKEN), false);
    assert.equal(writeConflict.details.schemaVersion, "1");
    assert.equal(writeConflict.details.kind, "team_board_write");
    assert.equal(writeConflict.details.status, "conflict");
    assert.equal(writeConflict.details.currentRevision, 1);
    assert.equal(writeConflict.details.reason, "Revision mismatch");

    const conflictParsed = JSON.parse(writeConflictJson);
    assert.equal(conflictParsed.schemaVersion, undefined);
    assert.equal(conflictParsed.kind, undefined);
    assert.equal(conflictParsed.status, "conflict");
    assert.equal(conflictParsed.currentRevision, 1);
    assert.equal(conflictParsed.reason, "Revision mismatch");
  } finally {
    await server.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});

// ── 10. Local Wire Requests ───────────────────────────────────────────────────

test("exact board read and write local wire requests", async () => {
  const requests = [];
  const localServer = await startLocalTestServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({
        path: req.url,
        method: req.method,
        headers: req.headers,
        body,
      });

      res.writeHead(200, {
        "Content-Type": "application/json",
        "x-clawd-server": "clawd-on-desk",
      });

      if (req.url === "/pet-team/board/read") {
        res.end(
          JSON.stringify({
            schemaVersion: "1",
            kind: "team_board_read",
            status: "active",
            board: {
              revision: 3,
              markdown: "# Local Board",
              updatedAtMs: 1690000000000,
              updatedBy: { displayName: "Local Pi", role: "member" },
            },
          })
        );
      } else if (req.url === "/pet-team/board/write") {
        res.end(
          JSON.stringify({
            schemaVersion: "1",
            kind: "team_board_write",
            status: "updated",
            board: {
              revision: 4,
              markdown: body.markdown,
              updatedAtMs: 1690000001000,
            },
          })
        );
      }
    });
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-board-local-"));
  const runtimeFile = path.join(tmpDir, "runtime.json");
  fs.writeFileSync(
    runtimeFile,
    JSON.stringify({ app: "clawd-on-desk", port: localServer.port, ownerPid: process.pid })
  );

  setPeerCapabilitySlot(VALID_TOKEN);
  process.env.PI_PET_CLAWD_RUNTIME_CONFIG = runtimeFile;
  process.env.PI_PET_CLAWD_REMOTE_CONFIG = path.join(tmpDir, "nonexistent-remote.json");

  try {
    const { tools, commands } = registerComponents();
    const boardWriteCmd = commands.get("pet-board-write");
    const boardTool = tools.get("pet_board");
    assert.ok(boardTool);

    const rawSessionId = "pi:test-session-local";
    const ctx = makeCtx(rawSessionId);

    await boardWriteCmd.handler("on", ctx);

    // Read
    const readRes = await boardTool.execute("tc-loc-r", { action: "read" }, undefined, undefined, ctx);
    assert.equal(readRes.isError, false);
    assert.equal(requests[0].path, "/pet-team/board/read");
    assert.equal(requests[0].headers["x-clawd-routing-nonce"], undefined); // No routing nonce for local mode
    assert.deepEqual(requests[0].body, {
      schemaVersion: "1",
      kind: "team_board_read",
      rawSessionId,
      capabilityToken: VALID_TOKEN,
    });

    // Write
    const writeRes = await boardTool.execute(
      "tc-loc-w",
      { action: "write", baseRevision: 3, markdown: "# Updated Local" },
      undefined,
      undefined,
      ctx
    );
    assert.equal(writeRes.isError, false);
    assert.equal(requests[1].path, "/pet-team/board/write");
    assert.equal(requests[1].headers["x-clawd-routing-nonce"], undefined);
    assert.deepEqual(requests[1].body, {
      schemaVersion: "1",
      kind: "team_board_write",
      rawSessionId,
      capabilityToken: VALID_TOKEN,
      baseRevision: 3,
      markdown: "# Updated Local",
    });
  } finally {
    await localServer.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});

// ── 11. Unit sanitization tests for Board ───────────────────────────────────

test("sanitizeBoardDetails, sanitizeBoardObject, and sanitizeBoardUpdatedBy enforce strict projections and leak prevention", () => {
  // 1. UpdatedBy sanitization
  const rawUpdatedBy = {
    displayName: "  Alice Pi\x00  ",
    role: "leader\t",
    petId: "secret_pet",
    rawSessionId: "pi:secret_session",
    host: "secret_host",
  };
  const updatedBySanitized = extension.sanitizeBoardUpdatedBy(rawUpdatedBy);
  assert.deepEqual(updatedBySanitized, {
    displayName: "Alice Pi",
    role: "leader",
  });
  assert.equal(updatedBySanitized.petId, undefined);
  assert.equal(updatedBySanitized.rawSessionId, undefined);
  assert.equal(updatedBySanitized.host, undefined);

  // 2. Board object sanitization
  const validMarkdown = "# Title\n\nLine 1\r\nLine 2\tTabbed text ✨ 🚀\n日本語テキスト";
  const rawBoard = {
    schemaVersion: "1",
    teamId: "secret_team_id",
    petId: "secret_pet_id",
    revision: 2,
    markdown: validMarkdown,
    updatedAtMs: 1700000000000,
    updatedByPetId: "secret_updater_pet",
    updatedBy: rawUpdatedBy,
    forbiddenKey: "must_be_stripped",
  };

  const boardSanitized = extension.sanitizeBoardObject(rawBoard);
  assert.deepEqual(boardSanitized, {
    revision: 2,
    markdown: validMarkdown,
    updatedAtMs: 1700000000000,
    updatedBy: {
      displayName: "Alice Pi",
      role: "leader",
    },
  });
  assert.equal(boardSanitized.teamId, undefined);
  assert.equal(boardSanitized.petId, undefined);
  assert.equal(boardSanitized.updatedByPetId, undefined);
  assert.equal(boardSanitized.forbiddenKey, undefined);

  // 3. Invalid markdown (control chars) -> returns null
  assert.equal(extension.sanitizeBoardObject({ revision: 1, markdown: "Hello\x00World" }), null);
  assert.equal(extension.sanitizeBoardObject({ revision: 1, markdown: "Hello\x1bWorld" }), null);
  assert.equal(extension.sanitizeBoardObject({ revision: 1, markdown: "Hello\x80World" }), null);

  // 4. Oversized markdown (> 8192 UTF-8 bytes) -> returns null
  assert.equal(extension.sanitizeBoardObject({ revision: 1, markdown: "a".repeat(8193) }), null);

  // 5. Invalid revision -> returns null
  assert.equal(extension.sanitizeBoardObject({ revision: -1, markdown: "test" }), null);
  assert.equal(extension.sanitizeBoardObject({ revision: 1.5, markdown: "test" }), null);
  assert.equal(extension.sanitizeBoardObject({ revision: "1", markdown: "test" }), null);
  assert.deepEqual(
    extension.sanitizeBoardUpdatedBy({ displayName: "Alice", role: "admin" }),
    { displayName: "Alice", role: "member" }
  );

  // 6. Full board details sanitization with conflict response
  const conflictResponse = {
    schemaVersion: "1",
    kind: "team_board_write",
    status: "conflict",
    currentRevision: 3,
    reason: "Revision mismatch",
    teamId: "secret_team",
    petId: "secret_pet",
    rawSessionId: "pi:secret",
    token: "secret_token",
    capabilityToken: "secret_cap",
  };
  const sanitizedConflict = extension.sanitizeBoardDetails(conflictResponse, null, "team_board_write");
  assert.deepEqual(sanitizedConflict, {
    schemaVersion: "1",
    kind: "team_board_write",
    status: "conflict",
    currentRevision: 3,
    reason: "Revision mismatch",
  });
  assert.equal(sanitizedConflict.teamId, undefined);
  assert.equal(sanitizedConflict.petId, undefined);
  assert.equal(sanitizedConflict.rawSessionId, undefined);
  assert.equal(sanitizedConflict.token, undefined);
  assert.equal(sanitizedConflict.capabilityToken, undefined);

  const invalidActive = extension.sanitizeBoardDetails({
    schemaVersion: "1",
    kind: "team_board_read",
    status: "active",
    board: { revision: 1, markdown: "bad\x00markdown" },
  });
  assert.deepEqual(invalidActive, {
    schemaVersion: "1",
    kind: "team_board_read",
    status: "failed",
    reason: "invalid board response",
  });

  // 7. Non-object or empty payload fallback
  assert.deepEqual(extension.sanitizeBoardDetails(null, "fallback error", "team_board_read"), {
    schemaVersion: "1",
    kind: "team_board_read",
    status: "failed",
    reason: "fallback error",
  });
});
