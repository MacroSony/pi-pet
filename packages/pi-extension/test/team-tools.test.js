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

// ── 2. Gating for pet_team_create and pet_team_dissolve ───────────────────────

test("pet_team_create and pet_team_dissolve are rejected when autonomy is off; status is not gated", async () => {
  const { tools } = registerComponents();
  const createTool = tools.get("pet_team_create");
  const dissolveTool = tools.get("pet_team_dissolve");
  const statusTool = tools.get("pet_team_status");

  setPeerCapabilitySlot(VALID_TOKEN);
  const ctx = makeCtx("ses-gate");

  // Autonomy is OFF by default
  const createRes = await createTool.execute(
    "call-1",
    { name: "My Team", targets: ["psh_member1"] },
    undefined,
    undefined,
    ctx
  );
  assert.equal(createRes.isError, true);
  const createBody = JSON.parse(createRes.content[0].text);
  assert.equal(createBody.status, "rejected");
  assert.ok(createBody.reason.includes("/pet-team-autonomy on"));

  const dissolveRes = await dissolveTool.execute(
    "call-2",
    {},
    undefined,
    undefined,
    ctx
  );
  assert.equal(dissolveRes.isError, true);
  const dissolveBody = JSON.parse(dissolveRes.content[0].text);
  assert.equal(dissolveBody.status, "rejected");
  assert.ok(dissolveBody.reason.includes("/pet-team-autonomy on"));

  // pet_team_status is read-only and NOT gated by autonomy (it fails on transport if not configured, not autonomy)
  const statusRes = await statusTool.execute(
    "call-3",
    {},
    undefined,
    undefined,
    ctx
  );
  // Transport is unconfigured so fails on config, NOT autonomy
  const statusBody = JSON.parse(statusRes.content[0].text);
  assert.ok(!statusBody.reason.includes("/pet-team-autonomy on"));
});

// ── 3. Exact Wire Bodies, Pass-Through & Sanitized Responses ──────────────────

test("exact status, create, dissolve wire requests, psh pass-through, and sanitized responses", async () => {
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
    const statusTool = tools.get("pet_team_status");
    const createTool = tools.get("pet_team_create");
    const dissolveTool = tools.get("pet_team_dissolve");

    const rawSessionId = "pi:test-session-leader";
    const ctx = makeCtx(rawSessionId);

    // Enable autonomy
    await autonomyCmd.handler("on", ctx);

    // ── 1. pet_team_status ──
    const statusResult = await statusTool.execute("tc-stat-1", {}, undefined, undefined, ctx);
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

    const statusParsed = JSON.parse(statusJson);
    assert.equal(statusParsed.schemaVersion, "1");
    assert.equal(statusParsed.kind, "team_status");
    assert.equal(statusParsed.status, "active");
    assert.equal(statusParsed.team.name, "Alpha Squad");
    assert.equal(statusParsed.team.members.length, 2);
    assert.equal(statusParsed.team.members[1].handle, "psh_fresh_worker_handle_123");

    // ── 2. pet_team_create (with psh machine-pass-through) ──
    const targetHandles = ["psh_target_alpha_111", "psh_target_beta_222"];
    const createResult = await createTool.execute(
      "tc-create-1",
      { name: "Bravo Squad", targets: targetHandles },
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

    // ── 3. pet_team_dissolve ──
    const dissolveResult = await dissolveTool.execute("tc-dissolve-1", {}, undefined, undefined, ctx);
    assert.equal(dissolveResult.isError, false);
    assert.equal(requests.length, 3);
    const reqDissolve = requests[2];
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

// ── 4. Unit sanitization tests ────────────────────────────────────────────────

test("sanitizeTeamDetails, sanitizeTeamObject, and sanitizeTeamMember enforce strict projections", () => {
  const rawMember = {
    displayName: "  Node Pi\x00  ",
    host: "local\t",
    state: "running",
    role: "leader",
    canMessage: true,
    handle: "psh_valid_123",
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
  });
  assert.equal(memberSanitized.petId, undefined);
  assert.equal(memberSanitized.rawSessionId, undefined);

  // Invalid handle format is omitted
  const badHandleMember = extension.sanitizeTeamMember({ ...rawMember, handle: "invalid_handle" });
  assert.equal(badHandleMember.handle, undefined);

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
        },
      ],
    },
  });
  assert.equal(teamSanitized.teamId, undefined);
  assert.equal(teamSanitized.team.secretField, undefined);
});

// ── 5. /pet-board-write command tests ──────────────────────────────────────────

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

// ── 6. Gating for pet_board_write ──────────────────────────────────────────────

test("pet_board_write is rejected when /pet-board-write is off; pet_board_read is not gated", async () => {
  const { tools, commands } = registerComponents();
  const writeTool = tools.get("pet_board_write");
  const readTool = tools.get("pet_board_read");
  const boardWriteCmd = commands.get("pet-board-write");

  setPeerCapabilitySlot(VALID_TOKEN);
  const ctx = makeCtx("ses-board-gate");

  // Board write is OFF by default
  const writeRes = await writeTool.execute(
    "call-1",
    { baseRevision: 0, markdown: "# Hello" },
    undefined,
    undefined,
    ctx
  );
  assert.equal(writeRes.isError, true);
  const writeBody = JSON.parse(writeRes.content[0].text);
  assert.equal(writeBody.status, "rejected");
  assert.ok(writeBody.reason.includes("/pet-board-write on"));

  // pet_board_read is read-only and NOT gated by /pet-board-write
  const readRes = await readTool.execute(
    "call-2",
    {},
    undefined,
    undefined,
    ctx
  );
  // Transport is unconfigured so it fails on transport config, NOT board write gating
  const readBody = JSON.parse(readRes.content[0].text);
  assert.ok(!readBody.reason.includes("/pet-board-write on"));

  // Enabling on session-1 does not enable on session-2 (session isolation)
  await boardWriteCmd.handler("on", makeCtx("ses-board-session-1"));
  const writeRes2 = await writeTool.execute(
    "call-3",
    { baseRevision: 0, markdown: "# Hello" },
    undefined,
    undefined,
    makeCtx("ses-board-session-2")
  );
  assert.equal(writeRes2.isError, true);
  const writeBody2 = JSON.parse(writeRes2.content[0].text);
  assert.equal(writeBody2.status, "rejected");
  assert.ok(writeBody2.reason.includes("/pet-board-write on"));
});

// ── 7. Parameter validation for pet_board_read & pet_board_write ──────────────

test("pet_board_read and pet_board_write parameter validation", async () => {
  const { tools, commands } = registerComponents();
  const writeTool = tools.get("pet_board_write");
  const readTool = tools.get("pet_board_read");
  const boardWriteCmd = commands.get("pet-board-write");

  setPeerCapabilitySlot(VALID_TOKEN);
  const ctx = makeCtx("ses-board-val");
  await boardWriteCmd.handler("on", ctx);

  // 1. pet_board_read parameter validation
  const readBadParams = await readTool.execute("tc-r-1", "bad-params", undefined, undefined, ctx);
  assert.equal(readBadParams.isError, true);
  assert.equal(JSON.parse(readBadParams.content[0].text).reason, "Parameters must be an object");

  const readUnexpected = await readTool.execute("tc-r-2", { extra: true }, undefined, undefined, ctx);
  assert.equal(readUnexpected.isError, true);
  assert.ok(JSON.parse(readUnexpected.content[0].text).reason.includes('Unexpected parameter: "extra"'));

  // 2. pet_board_write parameter validation
  const writeBadParams = await writeTool.execute("tc-w-1", null, undefined, undefined, ctx);
  assert.equal(writeBadParams.isError, true);
  assert.equal(JSON.parse(writeBadParams.content[0].text).reason, "Parameters must be an object");

  const writeUnexpected = await writeTool.execute("tc-w-2", { baseRevision: 0, markdown: "", foo: 1 }, undefined, undefined, ctx);
  assert.equal(writeUnexpected.isError, true);
  assert.ok(JSON.parse(writeUnexpected.content[0].text).reason.includes('Unexpected parameter: "foo"'));

  // baseRevision: must be non-negative safe integer
  for (const badRev of [-1, 1.5, NaN, Infinity, -Infinity, "0", null, undefined, {}]) {
    const res = await writeTool.execute("tc-w-rev", { baseRevision: badRev, markdown: "test" }, undefined, undefined, ctx);
    assert.equal(res.isError, true);
    assert.ok(JSON.parse(res.content[0].text).reason.includes("baseRevision must be a non-negative safe integer"));
  }

  // markdown: must be string
  for (const badMd of [123, null, undefined, {}, []]) {
    const res = await writeTool.execute("tc-w-md", { baseRevision: 0, markdown: badMd }, undefined, undefined, ctx);
    assert.equal(res.isError, true);
    assert.ok(JSON.parse(res.content[0].text).reason.includes("markdown must be a string"));
  }

  // markdown: byte length <= 8192 bytes
  const oversizedMd = "a".repeat(8193);
  const resOver = await writeTool.execute("tc-w-over", { baseRevision: 0, markdown: oversizedMd }, undefined, undefined, ctx);
  assert.equal(resOver.isError, true);
  assert.ok(JSON.parse(resOver.content[0].text).reason.includes("markdown byte length exceeds maximum 8192 UTF-8 bytes"));

  // markdown: disallowed C0/C1 control characters
  for (const badChar of ["\x00", "\x01", "\x08", "\x0B", "\x0C", "\x0E", "\x1F", "\x7F", "\x80", "\x9F"]) {
    const resCtrl = await writeTool.execute("tc-w-ctrl", { baseRevision: 0, markdown: `Hello${badChar}World` }, undefined, undefined, ctx);
    assert.equal(resCtrl.isError, true);
    assert.ok(JSON.parse(resCtrl.content[0].text).reason.includes("markdown contains disallowed control characters"));
  }
});

// ── 8. Remote Wire Requests, OCC Conflict Handling & Sanitized Responses ──────

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
    const readTool = tools.get("pet_board_read");
    const writeTool = tools.get("pet_board_write");

    const rawSessionId = "pi:test-session-board";
    const ctx = makeCtx(rawSessionId);

    // Enable board write
    await boardWriteCmd.handler("on", ctx);

    // ── 1. pet_board_read when status is none ──
    const read1 = await readTool.execute("tc-read-1", {}, undefined, undefined, ctx);
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
    const read1Parsed = JSON.parse(read1Json);
    assert.equal(read1Parsed.schemaVersion, "1");
    assert.equal(read1Parsed.kind, "team_board_read");
    assert.equal(read1Parsed.status, "none");
    assert.equal(read1Parsed.board, undefined);

    // ── 2. pet_board_write initial write (baseRevision 0) ──
    const initialMarkdown = "# Team Board\n\n- Task 1: Complete tests\t[done]\r\n- Task 2: Review PR 🚀";
    const write1 = await writeTool.execute(
      "tc-write-1",
      { baseRevision: 0, markdown: initialMarkdown },
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
    const write1Parsed = JSON.parse(write1Json);
    assert.equal(write1Parsed.schemaVersion, "1");
    assert.equal(write1Parsed.kind, "team_board_write");
    assert.equal(write1Parsed.status, "updated");
    assert.equal(write1Parsed.board.revision, 1);
    assert.equal(write1Parsed.board.markdown, initialMarkdown);
    assert.equal(write1Parsed.board.updatedAtMs, 1700000000000);
    assert.deepEqual(write1Parsed.board.updatedBy, { displayName: "Pi Writer", role: "member" });

    // ── 3. pet_board_read after write ──
    const read2 = await readTool.execute("tc-read-2", {}, undefined, undefined, ctx);
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

    // ── 4. pet_board_write 409 conflict on stale baseRevision ──
    const writeConflict = await writeTool.execute(
      "tc-write-conflict",
      { baseRevision: 0, markdown: "# Stale Write" }, // stale: baseRevision 0 instead of 1
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
    const conflictParsed = JSON.parse(writeConflictJson);
    assert.equal(conflictParsed.schemaVersion, "1");
    assert.equal(conflictParsed.kind, "team_board_write");
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

// ── 9. Local Wire Requests ───────────────────────────────────────────────────

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
    const readTool = tools.get("pet_board_read");
    const writeTool = tools.get("pet_board_write");

    const rawSessionId = "pi:test-session-local";
    const ctx = makeCtx(rawSessionId);

    await boardWriteCmd.handler("on", ctx);

    // Read
    const readRes = await readTool.execute("tc-loc-r", {}, undefined, undefined, ctx);
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
    const writeRes = await writeTool.execute("tc-loc-w", { baseRevision: 3, markdown: "# Updated Local" }, undefined, undefined, ctx);
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

// ── 10. Unit sanitization tests for Board ────────────────────────────────────

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
