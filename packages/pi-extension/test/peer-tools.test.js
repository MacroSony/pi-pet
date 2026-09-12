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

function setPeerCapabilitySlot(token = VALID_TOKEN, version = 1) {
  globalThis[PEER_SLOT] = Object.freeze({
    version,
    token,
  });
}

function clearPeerCapabilitySlot() {
  delete globalThis[PEER_SLOT];
}

function makeCtx(sessionId) {
  return { sessionManager: { getSessionId: () => sessionId } };
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

function registerTools(pi = {}) {
  const tools = new Map();
  const mockPi = {
    ...pi,
    registerTool(def) {
      if (def && def.name) {
        tools.set(def.name, def);
      }
    },
  };
  extension(mockPi, { Type: typeboxStub.Type });
  return tools;
}

// ── 1. Exact Tool Registration & Schema ──────────────────────────────────────

test("registers all three tools: pet_express, pet_list_sessions, and pet_send", () => {
  const tools = registerTools();
  assert.equal(tools.size, 3);
  assert.ok(tools.has("pet_express"));
  assert.ok(tools.has("pet_list_sessions"));
  assert.ok(tools.has("pet_send"));

  const listDef = tools.get("pet_list_sessions");
  assert.equal(listDef.name, "pet_list_sessions");
  assert.equal(listDef.label, "List Pet Sessions");
  assert.equal(typeof listDef.description, "string");
  assert.equal(typeof listDef.promptSnippet, "string");
  assert.ok(Array.isArray(listDef.promptGuidelines));
  assert.equal(listDef.parameters.type, "object");
  assert.equal(listDef.parameters.properties.state.type, "string");
  assert.equal(listDef.parameters.properties.state.maxLength, 120);
  assert.equal(listDef.parameters.properties.host.type, "string");
  assert.equal(listDef.parameters.properties.host.maxLength, 120);

  const sendDef = tools.get("pet_send");
  assert.equal(sendDef.name, "pet_send");
  assert.equal(sendDef.label, "Send Peer Note");
  assert.equal(typeof sendDef.description, "string");
  assert.equal(typeof sendDef.promptSnippet, "string");
  assert.ok(Array.isArray(sendDef.promptGuidelines));
  assert.equal(sendDef.parameters.type, "object");
  assert.equal(sendDef.parameters.properties.target.type, "string");
  assert.equal(sendDef.parameters.properties.target.minLength, 1);
  assert.equal(sendDef.parameters.properties.target.maxLength, 128);
  assert.equal(sendDef.parameters.properties.text.type, "string");
  assert.equal(sendDef.parameters.properties.text.minLength, 1);
  assert.equal(sendDef.parameters.properties.text.maxLength, 2000);
});

// ── 2. Local Config & Remote Preference ──────────────────────────────────────

test("loadLocalRuntimeConfig strictly parses valid runtime.json", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-cfg-"));
  const runtimeFile = path.join(tmpDir, "runtime.json");

  // Valid
  fs.writeFileSync(
    runtimeFile,
    JSON.stringify({ app: "clawd-on-desk", port: 23334, ownerPid: 1234 })
  );
  const cfg = extension.loadLocalRuntimeConfig({ PI_PET_CLAWD_RUNTIME_CONFIG: runtimeFile });
  assert.deepEqual(cfg, { mode: "local", port: 23334, ownerPid: 1234 });

  // Invalid app
  fs.writeFileSync(
    runtimeFile,
    JSON.stringify({ app: "other-app", port: 23334, ownerPid: 1234 })
  );
  assert.equal(extension.loadLocalRuntimeConfig({ PI_PET_CLAWD_RUNTIME_CONFIG: runtimeFile }), null);

  // Invalid port (out of range 23333..23337)
  fs.writeFileSync(
    runtimeFile,
    JSON.stringify({ app: "clawd-on-desk", port: 23338, ownerPid: 1234 })
  );
  assert.equal(extension.loadLocalRuntimeConfig({ PI_PET_CLAWD_RUNTIME_CONFIG: runtimeFile }), null);

  // Invalid port (non-integer)
  fs.writeFileSync(
    runtimeFile,
    JSON.stringify({ app: "clawd-on-desk", port: 23334.5, ownerPid: 1234 })
  );
  assert.equal(extension.loadLocalRuntimeConfig({ PI_PET_CLAWD_RUNTIME_CONFIG: runtimeFile }), null);

  // Invalid ownerPid (negative or 0 or non-integer)
  fs.writeFileSync(
    runtimeFile,
    JSON.stringify({ app: "clawd-on-desk", port: 23334, ownerPid: 0 })
  );
  assert.equal(extension.loadLocalRuntimeConfig({ PI_PET_CLAWD_RUNTIME_CONFIG: runtimeFile }), null);

  // Relative path override rejected
  assert.equal(
    extension.loadLocalRuntimeConfig({ PI_PET_CLAWD_RUNTIME_CONFIG: "relative/runtime.json" }),
    null
  );
});

test("resolvePeerTransportConfig prefers valid remote over local config", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-pref-"));
  const localFile = path.join(tmpDir, "runtime.json");
  const remoteFile = path.join(tmpDir, "clawd-remote.json");

  fs.writeFileSync(
    localFile,
    JSON.stringify({ app: "clawd-on-desk", port: 23333, ownerPid: 5555 })
  );
  fs.writeFileSync(
    remoteFile,
    JSON.stringify({
      remotePort: 44444,
      routingNonce: "0123456789abcdef0123456789abcdef",
      profileId: "remote-prof",
    })
  );

  const env = {
    PI_PET_CLAWD_RUNTIME_CONFIG: localFile,
    PI_PET_CLAWD_REMOTE_CONFIG: remoteFile,
  };

  // Both exist -> prefers remote
  const transport = extension.resolvePeerTransportConfig(env);
  assert.equal(transport.mode, "remote");
  assert.equal(transport.port, 44444);
  assert.equal(transport.routingNonce, "0123456789abcdef0123456789abcdef");

  // Only local exists -> uses local
  const envLocalOnly = {
    PI_PET_CLAWD_RUNTIME_CONFIG: localFile,
    PI_PET_CLAWD_REMOTE_CONFIG: path.join(tmpDir, "nonexistent.json"),
  };
  const transportLocal = extension.resolvePeerTransportConfig(envLocalOnly);
  assert.equal(transportLocal.mode, "local");
  assert.equal(transportLocal.port, 23333);
  assert.equal(transportLocal.ownerPid, 5555);
  assert.equal(transportLocal.routingNonce, undefined);

  // Neither exists -> returns null
  const envNone = {
    PI_PET_CLAWD_RUNTIME_CONFIG: path.join(tmpDir, "nonexistent1.json"),
    PI_PET_CLAWD_REMOTE_CONFIG: path.join(tmpDir, "nonexistent2.json"),
  };
  assert.equal(extension.resolvePeerTransportConfig(envNone), null);
});

// ── 3. Exact Request Body, Headers, and Path ─────────────────────────────────

test("pet_list_sessions sends exact request body, path, and headers for local and remote", async () => {
  const requests = [];
  const server = await startLocalTestServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      requests.push({
        path: req.url,
        method: req.method,
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "x-clawd-server": "clawd-on-desk",
      });
      res.end(
        JSON.stringify({
          schemaVersion: "1",
          kind: "peer_catalog",
          sessions: [],
        })
      );
    });
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-req-list-"));
  const localConfigPath = path.join(tmpDir, "runtime.json");
  fs.writeFileSync(
    localConfigPath,
    JSON.stringify({ app: "clawd-on-desk", port: server.port, ownerPid: process.pid })
  );

  setPeerCapabilitySlot(VALID_TOKEN);
  process.env.PI_PET_CLAWD_RUNTIME_CONFIG = localConfigPath;
  process.env.PI_PET_CLAWD_REMOTE_CONFIG = path.join(tmpDir, "nonexistent-remote.json");

  try {
    const tools = registerTools();
    const listTool = tools.get("pet_list_sessions");

    // Local request with state & host filters
    const result = await listTool.execute(
      "tc-list-1",
      { state: "idle", host: "local" },
      undefined,
      undefined,
      makeCtx("ses-alpha")
    );

    assert.equal(result.isError, false);
    assert.equal(requests.length, 1);
    const req1 = requests[0];
    assert.equal(req1.path, "/pet-peer/catalog");
    assert.equal(req1.method, "POST");
    assert.equal(req1.headers["content-type"], "application/json");
    assert.equal(req1.headers["x-clawd-routing-nonce"], undefined, "local must not send nonce");
    assert.deepEqual(req1.body, {
      schemaVersion: "1",
      kind: "peer_catalog_query",
      rawSessionId: "pi:ses-alpha",
      capabilityToken: VALID_TOKEN,
      state: "idle",
      host: "local",
    });

    // Remote request
    const remoteNonce = "abcdef0123456789abcdef0123456789";
    const remoteConfigPath = path.join(tmpDir, "clawd-remote.json");
    fs.writeFileSync(
      remoteConfigPath,
      JSON.stringify({ remotePort: server.port, routingNonce: remoteNonce, profileId: "p-remote" })
    );
    process.env.PI_PET_CLAWD_REMOTE_CONFIG = remoteConfigPath;

    const resultRemote = await listTool.execute(
      "tc-list-2",
      {},
      undefined,
      undefined,
      makeCtx("ses-beta")
    );

    assert.equal(resultRemote.isError, false);
    assert.equal(requests.length, 2);
    const req2 = requests[1];
    assert.equal(req2.path, "/pet-peer/catalog");
    assert.equal(req2.headers["x-clawd-routing-nonce"], remoteNonce);
    assert.deepEqual(req2.body, {
      schemaVersion: "1",
      kind: "peer_catalog_query",
      rawSessionId: "pi:ses-beta",
      capabilityToken: VALID_TOKEN,
    });
  } finally {
    clearPeerCapabilitySlot();
    await server.close();
  }
});

test("pet_send sends exact request body, path, and headers for local and remote", async () => {
  const requests = [];
  const server = await startLocalTestServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      requests.push({
        path: req.url,
        method: req.method,
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "x-clawd-server": "clawd-on-desk",
      });
      res.end(
        JSON.stringify({
          schemaVersion: "1",
          status: "queued",
          messageId: "msg_test_001",
        })
      );
    });
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-req-send-"));
  const localConfigPath = path.join(tmpDir, "runtime.json");
  fs.writeFileSync(
    localConfigPath,
    JSON.stringify({ app: "clawd-on-desk", port: server.port, ownerPid: process.pid })
  );

  setPeerCapabilitySlot(VALID_TOKEN);
  process.env.PI_PET_CLAWD_RUNTIME_CONFIG = localConfigPath;
  process.env.PI_PET_CLAWD_REMOTE_CONFIG = path.join(tmpDir, "nonexistent-remote.json");

  try {
    const tools = registerTools();
    const sendTool = tools.get("pet_send");

    const result = await sendTool.execute(
      "tc-send-1",
      { target: "psh_target_1", text: "Hello peer!" },
      undefined,
      undefined,
      makeCtx("ses-sender")
    );

    assert.equal(result.isError, false);
    assert.equal(requests.length, 1);
    const req = requests[0];
    assert.equal(req.path, "/pet-peer/send");
    assert.equal(req.method, "POST");
    assert.equal(req.headers["content-type"], "application/json");
    assert.equal(req.headers["x-clawd-routing-nonce"], undefined);
    assert.deepEqual(req.body, {
      schemaVersion: "1",
      kind: "peer_send",
      rawSessionId: "pi:ses-sender",
      capabilityToken: VALID_TOKEN,
      target: "psh_target_1",
      text: "Hello peer!",
    });
  } finally {
    clearPeerCapabilitySlot();
    await server.close();
  }
});

// ── 4. Bad / Missing Shared Slot (at execution time) ─────────────────────────

test("tool fails closed when shared slot is missing, invalid, or updated dynamically", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-slot-"));
  const localConfigPath = path.join(tmpDir, "runtime.json");
  fs.writeFileSync(
    localConfigPath,
    JSON.stringify({ app: "clawd-on-desk", port: 23333, ownerPid: process.pid })
  );
  process.env.PI_PET_CLAWD_RUNTIME_CONFIG = localConfigPath;
  process.env.PI_PET_CLAWD_REMOTE_CONFIG = path.join(tmpDir, "nonexistent-remote.json");

  const tools = registerTools();
  const sendTool = tools.get("pet_send");
  const listTool = tools.get("pet_list_sessions");

  // 1. Missing slot
  clearPeerCapabilitySlot();
  const resMissingList = await listTool.execute("tc1", {}, undefined, undefined, makeCtx("ses-1"));
  assert.equal(resMissingList.isError, true);
  assert.equal(resMissingList.details.status, "rejected");
  assert.ok(resMissingList.details.reason.includes("token unavailable or invalid"));

  const resMissingSend = await sendTool.execute(
    "tc2",
    { target: "psh_1", text: "hi" },
    undefined,
    undefined,
    makeCtx("ses-1")
  );
  assert.equal(resMissingSend.isError, true);
  assert.equal(resMissingSend.details.status, "rejected");

  // 2. Wrong version
  setPeerCapabilitySlot(VALID_TOKEN, 2);
  const resBadVer = await sendTool.execute(
    "tc3",
    { target: "psh_1", text: "hi" },
    undefined,
    undefined,
    makeCtx("ses-1")
  );
  assert.equal(resBadVer.isError, true);

  // 3. Uppercase hex or bad length token
  setPeerCapabilitySlot(VALID_TOKEN.toUpperCase(), 1);
  const resBadHex = await sendTool.execute(
    "tc4",
    { target: "psh_1", text: "hi" },
    undefined,
    undefined,
    makeCtx("ses-1")
  );
  assert.equal(resBadHex.isError, true);

  setPeerCapabilitySlot("012345", 1);
  const resShortToken = await sendTool.execute(
    "tc5",
    { target: "psh_1", text: "hi" },
    undefined,
    undefined,
    makeCtx("ses-1")
  );
  assert.equal(resShortToken.isError, true);

  // 4. The token reader remains internal; only the shared Symbol is public.
  assert.equal(extension.readPeerCapabilityToken, undefined);

  clearPeerCapabilitySlot();
});

// ── 5. Default Session Rejection ─────────────────────────────────────────────

test("rejects default, pi:default, pi:, and uninitialized sessions", async () => {
  setPeerCapabilitySlot(VALID_TOKEN);
  const tools = registerTools();
  const sendTool = tools.get("pet_send");
  const listTool = tools.get("pet_list_sessions");

  const badContexts = [
    makeCtx("default"),
    makeCtx("pi:default"),
    makeCtx("pi:"),
    makeCtx(""),
    makeCtx("   "),
    {},
    null,
    undefined,
  ];

  for (const ctx of badContexts) {
    const resList = await listTool.execute("tc-def", {}, undefined, undefined, ctx);
    assert.equal(resList.isError, true);
    assert.equal(resList.details.status, "rejected");
    assert.ok(resList.details.reason.includes("Invalid or uninitialized session"));

    const resSend = await sendTool.execute(
      "tc-def",
      { target: "psh_target", text: "hello" },
      undefined,
      undefined,
      ctx
    );
    assert.equal(resSend.isError, true);
    assert.equal(resSend.details.status, "rejected");
    assert.ok(resSend.details.reason.includes("Invalid or uninitialized session"));
  }

  clearPeerCapabilitySlot();
});

// ── 6. Wrong Server Header Verification ──────────────────────────────────────

test("fails closed when response header x-clawd-server is missing or not clawd-on-desk", async () => {
  let serverHeader = undefined;
  const server = await startLocalTestServer((req, res) => {
    const headers = { "Content-Type": "application/json" };
    if (serverHeader !== undefined) {
      headers["x-clawd-server"] = serverHeader;
    }
    res.writeHead(200, headers);
    res.end(JSON.stringify({ schemaVersion: "1", kind: "peer_catalog", sessions: [] }));
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-hdr-"));
  const localConfigPath = path.join(tmpDir, "runtime.json");
  fs.writeFileSync(
    localConfigPath,
    JSON.stringify({ app: "clawd-on-desk", port: server.port, ownerPid: process.pid })
  );

  setPeerCapabilitySlot(VALID_TOKEN);
  process.env.PI_PET_CLAWD_RUNTIME_CONFIG = localConfigPath;
  process.env.PI_PET_CLAWD_REMOTE_CONFIG = path.join(tmpDir, "nonexistent-remote.json");

  try {
    const tools = registerTools();
    const listTool = tools.get("pet_list_sessions");

    // Missing header
    serverHeader = undefined;
    const resNoHdr = await listTool.execute("tc-hdr1", {}, undefined, undefined, makeCtx("ses-1"));
    assert.equal(resNoHdr.isError, true);
    assert.ok(resNoHdr.details.reason.includes("Invalid server header"));

    // Wrong header
    serverHeader = "not-clawd";
    const resWrongHdr = await listTool.execute("tc-hdr2", {}, undefined, undefined, makeCtx("ses-1"));
    assert.equal(resWrongHdr.isError, true);
    assert.ok(resWrongHdr.details.reason.includes("Invalid server header"));

    // Exact matching header accepted
    serverHeader = "clawd-on-desk";
    const resValidHdr = await listTool.execute("tc-hdr3", {}, undefined, undefined, makeCtx("ses-1"));
    assert.equal(resValidHdr.isError, false);
  } finally {
    clearPeerCapabilitySlot();
    await server.close();
  }
});

// ── 7. Oversized and Malformed Responses / Requests ──────────────────────────

test("enforces 16KiB request limit and 64KiB response limit", async () => {
  let mode = "normal";
  const server = await startLocalTestServer((req, res) => {
    if (mode === "oversized") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "x-clawd-server": "clawd-on-desk",
      });
      // Stream > 64 KiB
      const chunk = "A".repeat(16384);
      res.write(chunk);
      res.write(chunk);
      res.write(chunk);
      res.write(chunk);
      res.write(chunk); // 80 KiB total
      res.end();
    } else if (mode === "malformed-json") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "x-clawd-server": "clawd-on-desk",
      });
      res.end("<html>Not JSON</html>");
    } else {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "x-clawd-server": "clawd-on-desk",
      });
      res.end(JSON.stringify({ schemaVersion: "1", status: "queued", messageId: "msg_ok" }));
    }
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-size-"));
  const localConfigPath = path.join(tmpDir, "runtime.json");
  fs.writeFileSync(
    localConfigPath,
    JSON.stringify({ app: "clawd-on-desk", port: server.port, ownerPid: process.pid })
  );

  setPeerCapabilitySlot(VALID_TOKEN);
  process.env.PI_PET_CLAWD_RUNTIME_CONFIG = localConfigPath;
  process.env.PI_PET_CLAWD_REMOTE_CONFIG = path.join(tmpDir, "nonexistent-remote.json");

  try {
    const tools = registerTools();
    const sendTool = tools.get("pet_send");

    // 1. Response > 64 KiB
    mode = "oversized";
    const resOversized = await sendTool.execute(
      "tc-sz-1",
      { target: "psh_1", text: "hello" },
      undefined,
      undefined,
      makeCtx("ses-1")
    );
    assert.equal(resOversized.isError, true);
    assert.ok(resOversized.details.reason.includes("64 KiB"));

    // 2. Malformed JSON response
    mode = "malformed-json";
    const resBadJson = await sendTool.execute(
      "tc-sz-2",
      { target: "psh_1", text: "hello" },
      undefined,
      undefined,
      makeCtx("ses-1")
    );
    assert.equal(resBadJson.isError, true);
    assert.ok(resBadJson.details.reason.includes("Non-JSON"));

    // 3. Request > 16 KiB via postPeerJson
    const oversizedBody = { payload: "X".repeat(20000) };
    const directRes = await extension.postPeerJson(
      { port: server.port, mode: "local" },
      "/pet-peer/send",
      oversizedBody
    );
    assert.equal(directRes.ok, false);
    assert.ok(directRes.reason.includes("16 KiB"));
  } finally {
    clearPeerCapabilitySlot();
    await server.close();
  }
});

// ── 8. Catalog Projection & No Leaks ─────────────────────────────────────────

test("defensively projects catalog entries, strips private/forbidden fields, and drops invalid items", async () => {
  const server = await startLocalTestServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "x-clawd-server": "clawd-on-desk",
    });
    res.end(
      JSON.stringify({
        schemaVersion: "1",
        kind: "peer_catalog",
        sessions: [
          // Valid entry with forbidden leaky fields attached
          {
            handle: "psh_valid_1",
            displayName: "Desktop Pet 1",
            host: "local",
            state: "idle",
            capabilities: ["receive_peer_message"],
            canMessage: true,
            expiresAtMs: 1700000300000,
            petId: "pet_SECRET_1",
            profileId: "prof_SECRET_1",
            rawSessionId: "pi:ses-SECRET",
            capabilityToken: "token_SECRET",
            cwd: "/home/bruhw/secret/path",
            pid: 99999,
            replyHandle: "psh_reply_secret",
          },
          // Malformed entry: missing psh_ prefix
          {
            handle: "invalid_handle_without_psh",
            displayName: "Bad Pet",
            host: "local",
            state: "idle",
            capabilities: ["receive_peer_message"],
            canMessage: true,
            expiresAtMs: 1700000300000,
          },
          // Malformed entry: missing displayName
          {
            handle: "psh_valid_2",
            displayName: "",
            host: "local",
            state: "idle",
            capabilities: ["receive_peer_message"],
            canMessage: true,
            expiresAtMs: 1700000300000,
          },
          // Malformed entry: non-array capabilities
          {
            handle: "psh_valid_3",
            displayName: "Pet 3",
            host: "local",
            state: "idle",
            capabilities: "invalid",
            canMessage: true,
            expiresAtMs: 1700000300000,
          },
          // Malformed entry: non-boolean canMessage
          {
            handle: "psh_valid_4",
            displayName: "Pet 4",
            host: "local",
            state: "idle",
            capabilities: ["receive_peer_message"],
            canMessage: "true",
            expiresAtMs: 1700000300000,
          },
          // Malformed entry: invalid expiresAtMs
          {
            handle: "psh_valid_5",
            displayName: "Pet 5",
            host: "local",
            state: "idle",
            capabilities: ["receive_peer_message"],
            canMessage: true,
            expiresAtMs: -1,
          },
        ],
      })
    );
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-cat-"));
  const localConfigPath = path.join(tmpDir, "runtime.json");
  fs.writeFileSync(
    localConfigPath,
    JSON.stringify({ app: "clawd-on-desk", port: server.port, ownerPid: process.pid })
  );

  setPeerCapabilitySlot(VALID_TOKEN);
  process.env.PI_PET_CLAWD_RUNTIME_CONFIG = localConfigPath;
  process.env.PI_PET_CLAWD_REMOTE_CONFIG = path.join(tmpDir, "nonexistent-remote.json");

  try {
    const tools = registerTools();
    const listTool = tools.get("pet_list_sessions");

    const result = await listTool.execute("tc-cat", {}, undefined, undefined, makeCtx("ses-caller"));

    assert.equal(result.isError, false);
    assert.equal(result.details.schemaVersion, "1");
    assert.equal(result.details.kind, "peer_catalog");
    assert.equal(result.details.sessions.length, 1, "malformed entries must be dropped");

    const session = result.details.sessions[0];
    assert.deepEqual(Object.keys(session).sort(), [
      "canMessage",
      "capabilities",
      "displayName",
      "expiresAtMs",
      "handle",
      "host",
      "state",
    ]);

    assert.equal(session.handle, "psh_valid_1");
    assert.equal(session.displayName, "Desktop Pet 1");
    assert.equal(session.host, "local");
    assert.equal(session.state, "idle");
    assert.deepEqual(session.capabilities, ["receive_peer_message"]);
    assert.equal(session.canMessage, true);
    assert.equal(session.expiresAtMs, 1700000300000);

    // Ensure forbidden fields are strictly absent
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("pet_SECRET"), false);
    assert.equal(serialized.includes("prof_SECRET"), false);
    assert.equal(serialized.includes("ses-SECRET"), false);
    assert.equal(serialized.includes("token_SECRET"), false);
    assert.equal(serialized.includes("secret/path"), false);
    assert.equal(serialized.includes("99999"), false);
    assert.equal(serialized.includes("psh_reply_secret"), false);
    assert.equal(serialized.includes(VALID_TOKEN), false);
  } finally {
    clearPeerCapabilitySlot();
    await server.close();
  }
});

// ── 9. Send Response Projection & No Leaks ───────────────────────────────────

test("sanitizes send response details, preserves allowed fields only, and suppresses leaks", async () => {
  const server = await startLocalTestServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "x-clawd-server": "clawd-on-desk",
    });
    res.end(
      JSON.stringify({
        schemaVersion: "1",
        status: "queued",
        messageId: "msg_clean_123",
        threadId: "thr_clean_456",
        hopCount: 0,
        maxHops: 1,
        createdAtMs: 1700000000000,
        expiresAtMs: 1700000060000,
        // Leaky fields from rogue server
        replyHandle: "psh_LEAK_REPLY",
        petId: "pet_LEAK_TARGET",
        profileId: "prof_LEAK",
        sourcePetId: "pet_LEAK_SOURCE",
        targetPetId: "pet_LEAK_TGT",
        dedupKey: "dedup_LEAK",
        token: "token_LEAK",
        rawSessionId: "pi:LEAK_RAW",
      })
    );
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-snd-"));
  const localConfigPath = path.join(tmpDir, "runtime.json");
  fs.writeFileSync(
    localConfigPath,
    JSON.stringify({ app: "clawd-on-desk", port: server.port, ownerPid: process.pid })
  );

  setPeerCapabilitySlot(VALID_TOKEN);
  process.env.PI_PET_CLAWD_RUNTIME_CONFIG = localConfigPath;
  process.env.PI_PET_CLAWD_REMOTE_CONFIG = path.join(tmpDir, "nonexistent-remote.json");

  try {
    const tools = registerTools();
    const sendTool = tools.get("pet_send");

    const result = await sendTool.execute(
      "tc-snd-1",
      { target: "psh_target", text: "Hello!" },
      undefined,
      undefined,
      makeCtx("ses-sender")
    );

    assert.equal(result.isError, false);
    assert.deepEqual(result.details, {
      schemaVersion: "1",
      status: "queued",
      messageId: "msg_clean_123",
      threadId: "thr_clean_456",
      hopCount: 0,
      maxHops: 1,
      createdAtMs: 1700000000000,
      expiresAtMs: 1700000060000,
    });

    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("psh_LEAK_REPLY"), false);
    assert.equal(serialized.includes("pet_LEAK"), false);
    assert.equal(serialized.includes("prof_LEAK"), false);
    assert.equal(serialized.includes("dedup_LEAK"), false);
    assert.equal(serialized.includes("token_LEAK"), false);
    assert.equal(serialized.includes("pi:LEAK_RAW"), false);
    assert.equal(serialized.includes(VALID_TOKEN), false);
  } finally {
    clearPeerCapabilitySlot();
    await server.close();
  }
});

// ── 10. Unicode 2000 Emoji Accepted / 2001 Rejected ─────────────────────────

test("accepts 2000 Unicode code points (emoji) and rejects 2001 code points", async () => {
  let receivedText = null;
  const server = await startLocalTestServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      receivedText = body.text;
      res.writeHead(200, {
        "Content-Type": "application/json",
        "x-clawd-server": "clawd-on-desk",
      });
      res.end(JSON.stringify({ status: "queued", messageId: "msg_unicode" }));
    });
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-uni-"));
  const localConfigPath = path.join(tmpDir, "runtime.json");
  fs.writeFileSync(
    localConfigPath,
    JSON.stringify({ app: "clawd-on-desk", port: server.port, ownerPid: process.pid })
  );

  setPeerCapabilitySlot(VALID_TOKEN);
  process.env.PI_PET_CLAWD_RUNTIME_CONFIG = localConfigPath;
  process.env.PI_PET_CLAWD_REMOTE_CONFIG = path.join(tmpDir, "nonexistent-remote.json");

  try {
    const tools = registerTools();
    const sendTool = tools.get("pet_send");

    // 2000 emoji code points (each emoji is 2 UTF-16 code units, length = 4000)
    const emoji2000 = "🚀".repeat(2000);
    assert.equal(extension.countCodePoints(emoji2000), 2000);
    assert.equal(emoji2000.length, 4000);

    const res2000 = await sendTool.execute(
      "tc-uni-2000",
      { target: "psh_target", text: emoji2000 },
      undefined,
      undefined,
      makeCtx("ses-sender")
    );
    assert.equal(res2000.isError, false);
    assert.equal(receivedText, emoji2000);

    // 2001 emoji code points -> rejected
    const emoji2001 = "🚀".repeat(2001);
    assert.equal(extension.countCodePoints(emoji2001), 2001);

    const res2001 = await sendTool.execute(
      "tc-uni-2001",
      { target: "psh_target", text: emoji2001 },
      undefined,
      undefined,
      makeCtx("ses-sender")
    );
    assert.equal(res2001.isError, true);
    assert.equal(res2001.details.status, "rejected");
    assert.ok(res2001.details.reason.includes("2000 Unicode code points"));

    // Empty text -> rejected
    const resEmpty = await sendTool.execute(
      "tc-uni-empty",
      { target: "psh_target", text: "" },
      undefined,
      undefined,
      makeCtx("ses-sender")
    );
    assert.equal(resEmpty.isError, true);
    assert.equal(resEmpty.details.status, "rejected");
  } finally {
    clearPeerCapabilitySlot();
    await server.close();
  }
});

// ── 11. Invalid Target Handle & Unexpected Parameters ────────────────────────

test("validates target handle format and rejects unexpected parameter keys", async () => {
  setPeerCapabilitySlot(VALID_TOKEN);
  const tools = registerTools();
  const sendTool = tools.get("pet_send");
  const listTool = tools.get("pet_list_sessions");

  // Bad targets
  const badTargets = [
    "session_123", // missing psh_ prefix
    "pet_abc123",  // wrong prefix
    "",            // empty
    "psh_" + "a".repeat(126), // 130 chars > 128
    "psh_with space",
    "psh_with/slash",
    "psh_with\nnewline",
    "psh_with\0null",
    12345,
    null,
  ];

  for (const target of badTargets) {
    const res = await sendTool.execute(
      "tc-tgt",
      { target, text: "valid text" },
      undefined,
      undefined,
      makeCtx("ses-1")
    );
    assert.equal(res.isError, true);
    assert.equal(res.details.status, "rejected");
  }

  // Unexpected parameter in pet_send
  const resExtraSend = await sendTool.execute(
    "tc-extra-send",
    { target: "psh_1", text: "hi", profileId: "local", hopCount: 0 },
    undefined,
    undefined,
    makeCtx("ses-1")
  );
  assert.equal(resExtraSend.isError, true);
  assert.equal(resExtraSend.details.status, "rejected");
  assert.ok(resExtraSend.details.reason.includes("Unexpected parameter"));

  // Unexpected parameter in pet_list_sessions
  const resExtraList = await listTool.execute(
    "tc-extra-list",
    { state: "idle", secretToken: "abc" },
    undefined,
    undefined,
    makeCtx("ses-1")
  );
  assert.equal(resExtraList.isError, true);
  assert.equal(resExtraList.details.status, "rejected");
  assert.ok(resExtraList.details.reason.includes("Unexpected parameter"));

  clearPeerCapabilitySlot();
});

// ── 12. Server Rejections Surfaced as isError ────────────────────────────────

test("surfaces server rejections and non-success statuses as isError: true", async () => {
  let serverResponse = {};
  let serverStatusCode = 200;

  const server = await startLocalTestServer((req, res) => {
    res.writeHead(serverStatusCode, {
      "Content-Type": "application/json",
      "x-clawd-server": "clawd-on-desk",
    });
    res.end(JSON.stringify(serverResponse));
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-rej-"));
  const localConfigPath = path.join(tmpDir, "runtime.json");
  fs.writeFileSync(
    localConfigPath,
    JSON.stringify({ app: "clawd-on-desk", port: server.port, ownerPid: process.pid })
  );

  setPeerCapabilitySlot(VALID_TOKEN);
  process.env.PI_PET_CLAWD_RUNTIME_CONFIG = localConfigPath;
  process.env.PI_PET_CLAWD_REMOTE_CONFIG = path.join(tmpDir, "nonexistent-remote.json");

  try {
    const tools = registerTools();
    const sendTool = tools.get("pet_send");

    // HTTP 200 with status: 'rejected'
    serverResponse = { status: "rejected", reason: "Target session offline" };
    serverStatusCode = 200;
    const resRej = await sendTool.execute(
      "tc-rej-1",
      { target: "psh_tgt", text: "hi" },
      undefined,
      undefined,
      makeCtx("ses-1")
    );
    assert.equal(resRej.isError, true);
    assert.equal(resRej.details.status, "rejected");
    assert.equal(resRej.details.reason, "Target session offline");

    // HTTP 200 with status: 'failed'
    serverResponse = { status: "failed", reason: "Target inbox queue capacity full" };
    const resFail = await sendTool.execute(
      "tc-rej-2",
      { target: "psh_tgt", text: "hi" },
      undefined,
      undefined,
      makeCtx("ses-1")
    );
    assert.equal(resFail.isError, true);
    assert.equal(resFail.details.status, "failed");

    // HTTP 400 with status: 'rejected'
    serverResponse = { status: "rejected", reason: "Invalid handle" };
    serverStatusCode = 400;
    const res400 = await sendTool.execute(
      "tc-rej-3",
      { target: "psh_tgt", text: "hi" },
      undefined,
      undefined,
      makeCtx("ses-1")
    );
    assert.equal(res400.isError, true);
    assert.equal(res400.details.status, "rejected");

    // HTTP 202 with status: 'dispatched' -> success (isError: false)
    serverResponse = { status: "dispatched", messageId: "msg_disp" };
    serverStatusCode = 202;
    const res202 = await sendTool.execute(
      "tc-disp",
      { target: "psh_tgt", text: "hi" },
      undefined,
      undefined,
      makeCtx("ses-1")
    );
    assert.equal(res202.isError, false);
    assert.equal(res202.details.status, "dispatched");
  } finally {
    clearPeerCapabilitySlot();
    await server.close();
  }
});

// ── 13. Abort Signal & Network Failure ───────────────────────────────────────

test("handles abort signal and network transport failures cleanly", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-abort-"));
  const remoteConfigPath = path.join(tmpDir, "clawd-remote.json");
  // Ask the OS for an ephemeral port, then close it so this process controls the
  // connection-refused precondition instead of assuming shared port 23337 is idle.
  const deadEndpoint = await startRemoteTestServer((_req, res) => res.end());
  const deadPort = deadEndpoint.port;
  await deadEndpoint.close();
  fs.writeFileSync(
    remoteConfigPath,
    JSON.stringify({
      remotePort: deadPort,
      routingNonce: "abcdef0123456789abcdef0123456789",
      profileId: "remote-abort-test",
    })
  );

  setPeerCapabilitySlot(VALID_TOKEN);
  process.env.PI_PET_CLAWD_RUNTIME_CONFIG = path.join(tmpDir, "nonexistent-runtime.json");
  process.env.PI_PET_CLAWD_REMOTE_CONFIG = remoteConfigPath;

  try {
    const tools = registerTools();
    const sendTool = tools.get("pet_send");

    // 1. Pre-aborted signal
    const controller = new AbortController();
    controller.abort();
    const resAborted = await sendTool.execute(
      "tc-abort-1",
      { target: "psh_1", text: "hi" },
      controller.signal,
      undefined,
      makeCtx("ses-1")
    );
    assert.equal(resAborted.isError, true);
    assert.ok(resAborted.details.reason.includes("aborted"));

    // 2. Connection refused (no server on 23337)
    const resConnRefused = await sendTool.execute(
      "tc-net-err",
      { target: "psh_1", text: "hi" },
      undefined,
      undefined,
      makeCtx("ses-1")
    );
    assert.equal(resConnRefused.isError, true);
    assert.equal(resConnRefused.details.status, "failed");
    assert.ok(typeof resConnRefused.details.reason === "string");
  } finally {
    clearPeerCapabilitySlot();
  }
});

// ── 14. Global Absence of Tokens and Raw Session IDs in Results ──────────────

test("ensures capability tokens and raw session IDs are never leaked in tool outputs", async () => {
  const server = await startLocalTestServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "x-clawd-server": "clawd-on-desk",
    });
    res.end(
      JSON.stringify({
        schemaVersion: "1",
        status: "queued",
        messageId: "msg_final",
      })
    );
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-leak-check-"));
  const localConfigPath = path.join(tmpDir, "runtime.json");
  fs.writeFileSync(
    localConfigPath,
    JSON.stringify({ app: "clawd-on-desk", port: server.port, ownerPid: process.pid })
  );

  const secretToken = "11112222333344445555666677778888aaaabbbbccccddddeeeeffff00001111";
  const secretRawSession = "pi:super-secret-session-id-xyz-999";
  setPeerCapabilitySlot(secretToken);
  process.env.PI_PET_CLAWD_RUNTIME_CONFIG = localConfigPath;
  process.env.PI_PET_CLAWD_REMOTE_CONFIG = path.join(tmpDir, "nonexistent-remote.json");

  try {
    const tools = registerTools();
    const sendTool = tools.get("pet_send");
    const listTool = tools.get("pet_list_sessions");

    const resultSend = await sendTool.execute(
      "tc-leak-send",
      { target: "psh_target", text: "hello" },
      undefined,
      undefined,
      makeCtx("super-secret-session-id-xyz-999")
    );
    const sendJson = JSON.stringify(resultSend);
    assert.equal(sendJson.includes(secretToken), false);
    assert.equal(sendJson.includes(secretRawSession), false);
    assert.equal(sendJson.includes("super-secret-session-id-xyz-999"), false);

    const resultList = await listTool.execute(
      "tc-leak-list",
      {},
      undefined,
      undefined,
      makeCtx("super-secret-session-id-xyz-999")
    );
    const listJson = JSON.stringify(resultList);
    assert.equal(listJson.includes(secretToken), false);
    assert.equal(listJson.includes(secretRawSession), false);
    assert.equal(listJson.includes("super-secret-session-id-xyz-999"), false);
  } finally {
    clearPeerCapabilitySlot();
    await server.close();
  }
});
