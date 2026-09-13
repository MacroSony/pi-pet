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
