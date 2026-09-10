"use strict";

// pet_express extension test. The real "typebox" module is provided by Pi's
// extension loader at runtime; here we stub it (the schema object is opaque
// to our code path anyway).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const interactionPath = path.resolve(__dirname, "../../runtime/interaction.js");
const { derivePetId } = require(interactionPath);

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

function makeCtx(sessionId) {
  return { sessionManager: { getSessionId: () => sessionId } };
}

function startTestServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        port,
        server,
        close: () =>
          new Promise((res) => {
            server.close(res);
          }),
      });
    });
    server.on("error", reject);
  });
}

test("pet_express registers and delivers with runtime module configured", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-ext-"));
  process.env.PI_PET_RUNTIME_MODULE = interactionPath;
  process.env.PI_PET_DATA_DIR = dataDir;
  delete process.env.PI_PET_PROFILE_ID;
  process.env.PI_PET_CLAWD_REMOTE_CONFIG = path.join(dataDir, "nonexistent.json");

  const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "ses-test-1" });
  fs.mkdirSync(path.join(dataDir, "status"), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "status", `status-${petId}.json`),
    JSON.stringify({ state: "idle" })
  );

  let toolDef = null;
  extension({ registerTool(def) { toolDef = def; } });
  assert.ok(toolDef, "tool registered");
  assert.equal(toolDef.name, "pet_express");

  const result = await toolDef.execute(
    "tc1",
    { text: "hello pet", emotion: "happy" },
    undefined,
    undefined,
    makeCtx("ses-test-1")
  );
  assert.equal(result.details.status, "delivered");
  assert.equal(result.isError, false);

  const event = JSON.parse(
    fs.readFileSync(path.join(dataDir, "events", `event-${petId}.json`), "utf8")
  );
  assert.equal(event.petId, petId);
  assert.equal(event.payload.text, "hello pet");
  assert.equal(event.payload.emotion, "happy");
});

test("pet_express fails closed when runtime module is not configured", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-ext-no-runtime-"));
  delete process.env.PI_PET_RUNTIME_MODULE;
  process.env.PI_PET_CLAWD_REMOTE_CONFIG = path.join(dataDir, "nonexistent.json");

  let toolDef = null;
  extension({ registerTool(def) { toolDef = def; } });
  const result = await toolDef.execute(
    "tc2",
    { text: "hi" },
    undefined,
    undefined,
    makeCtx("ses-anything")
  );
  assert.equal(result.details.status, "failed");
  assert.equal(result.details.reason, "PI_PET_RUNTIME_MODULE not configured or unloadable");
  assert.equal(result.isError, true);
});

test("local-unknown-identity falls back to remote POST and returns delivered receipt from server", async () => {
  const nonce = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const requests = [];

  const testServer = await startTestServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: JSON.parse(body),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "delivered", reason: null, commandId: "cmd_remote_1" }));
    });
  });

  try {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-ext-fallback-"));
    const remoteConfigFile = path.join(dataDir, "clawd-remote.json");
    fs.writeFileSync(
      remoteConfigFile,
      JSON.stringify({
        remotePort: testServer.port,
        routingNonce: nonce,
        profileId: "prof-test",
      })
    );

    process.env.PI_PET_RUNTIME_MODULE = interactionPath;
    process.env.PI_PET_DATA_DIR = dataDir;
    process.env.PI_PET_CLAWD_REMOTE_CONFIG = remoteConfigFile;
    delete process.env.PI_PET_PROFILE_ID;

    // No status file written in dataDir, so local returns UnknownPetIdentity rejection
    let toolDef = null;
    extension({ registerTool(def) { toolDef = def; } });

    const result = await toolDef.execute(
      "tc-fallback",
      { text: "hello remote", emotion: "happy" },
      undefined,
      undefined,
      makeCtx("ses-remote-1")
    );

    assert.equal(result.details.status, "delivered");
    assert.equal(result.details.commandId, "cmd_remote_1");
    assert.equal(result.isError, false);

    assert.equal(requests.length, 1);
    const req = requests[0];
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/pet-expression");
    assert.equal(req.headers["x-clawd-routing-nonce"], nonce);
    assert.equal(req.headers["content-type"], "application/json");
    assert.equal(req.body.schemaVersion, "1");
    assert.equal(req.body.kind, "pet_expression");
    assert.equal(req.body.rawSessionId, "ses-remote-1");
    assert.equal(req.body.agentId, "pi");
    assert.equal(req.body.text, "hello remote");
    assert.equal(req.body.emotion, "happy");
    assert.equal(typeof req.body.createdAtMs, "number");
    assert.match(req.body.dedupKey, /^tc_/);
  } finally {
    await testServer.close();
  }
});

test("remote server error returns failed receipt with isError true", async () => {
  const nonce = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

  const testServer = await startTestServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    });
  });

  try {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-ext-error-"));
    const remoteConfigFile = path.join(dataDir, "clawd-remote.json");
    fs.writeFileSync(
      remoteConfigFile,
      JSON.stringify({
        remotePort: testServer.port,
        routingNonce: nonce,
        profileId: "prof-test",
      })
    );

    process.env.PI_PET_RUNTIME_MODULE = interactionPath;
    process.env.PI_PET_DATA_DIR = dataDir;
    process.env.PI_PET_CLAWD_REMOTE_CONFIG = remoteConfigFile;

    let toolDef = null;
    extension({ registerTool(def) { toolDef = def; } });

    const result = await toolDef.execute(
      "tc-error",
      { text: "trigger error" },
      undefined,
      undefined,
      makeCtx("ses-error-1")
    );

    assert.equal(result.details.status, "failed");
    assert.equal(result.isError, true);
    assert.ok(typeof result.details.reason === "string");
  } finally {
    await testServer.close();
  }
});

test("local schema rejection does not fall back to remote", async () => {
  const nonce = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
  let requestCount = 0;

  const testServer = await startTestServer((req, res) => {
    requestCount += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "delivered" }));
  });

  try {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-ext-schema-"));
    const remoteConfigFile = path.join(dataDir, "clawd-remote.json");
    fs.writeFileSync(
      remoteConfigFile,
      JSON.stringify({
        remotePort: testServer.port,
        routingNonce: nonce,
        profileId: "prof-test",
      })
    );

    process.env.PI_PET_RUNTIME_MODULE = interactionPath;
    process.env.PI_PET_DATA_DIR = dataDir;
    process.env.PI_PET_CLAWD_REMOTE_CONFIG = remoteConfigFile;

    let toolDef = null;
    extension({ registerTool(def) { toolDef = def; } });

    // Invalid emotion violates schema
    const result = await toolDef.execute(
      "tc-schema",
      { emotion: "invalid_emotion" },
      undefined,
      undefined,
      makeCtx("ses-schema-1")
    );

    assert.equal(result.details.status, "rejected");
    assert.ok(result.details.reason.startsWith("SchemaValidationError:"));
    assert.equal(result.isError, true);
    assert.equal(requestCount, 0, "no remote request should be sent on schema rejection");
  } finally {
    await testServer.close();
  }
});

test("missing remote config returns original rejection with annotation", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-ext-missing-cfg-"));
  const nonExistentConfig = path.join(dataDir, "nonexistent-clawd-remote.json");

  process.env.PI_PET_RUNTIME_MODULE = interactionPath;
  process.env.PI_PET_DATA_DIR = dataDir;
  process.env.PI_PET_CLAWD_REMOTE_CONFIG = nonExistentConfig;

  let toolDef = null;
  extension({ registerTool(def) { toolDef = def; } });

  const result = await toolDef.execute(
    "tc-no-config",
    { text: "hello" },
    undefined,
    undefined,
    makeCtx("ses-unknown-1")
  );

  assert.equal(result.details.status, "rejected");
  assert.equal(result.isError, true);
  assert.ok(result.details.reason.includes("UnknownPetIdentity"));
  assert.ok(result.details.reason.includes("(remote fallback unavailable)"));
});

test("delivers directly to remote when runtime module is absent but remote config is valid", async () => {
  const nonce = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const requests = [];

  const testServer = await startTestServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: JSON.parse(body),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "delivered", reason: null, commandId: "cmd_direct_1" }));
    });
  });

  try {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-ext-direct-"));
    const remoteConfigFile = path.join(dataDir, "clawd-remote.json");
    fs.writeFileSync(
      remoteConfigFile,
      JSON.stringify({
        remotePort: testServer.port,
        routingNonce: nonce,
        profileId: "prof-direct",
      })
    );

    delete process.env.PI_PET_RUNTIME_MODULE;
    process.env.PI_PET_CLAWD_REMOTE_CONFIG = remoteConfigFile;

    let toolDef = null;
    extension({ registerTool(def) { toolDef = def; } });

    const result = await toolDef.execute(
      "tc-direct",
      { text: "hello from direct remote" },
      undefined,
      undefined,
      makeCtx("ses-direct-1")
    );

    assert.equal(result.details.status, "delivered");
    assert.equal(result.details.commandId, "cmd_direct_1");
    assert.equal(result.isError, false);
    assert.equal(requests.length, 1);
  } finally {
    await testServer.close();
  }
});

test("rejects payload exceeding 16 KiB limit early", async () => {
  const nonce = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
  let requestCount = 0;
  const testServer = await startTestServer((req, res) => {
    requestCount += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "delivered" }));
  });

  try {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-ext-size-"));
    const remoteConfigFile = path.join(dataDir, "clawd-remote.json");
    fs.writeFileSync(
      remoteConfigFile,
      JSON.stringify({
        remotePort: testServer.port,
        routingNonce: nonce,
        profileId: "prof-size",
      })
    );

    delete process.env.PI_PET_RUNTIME_MODULE;
    process.env.PI_PET_CLAWD_REMOTE_CONFIG = remoteConfigFile;

    const receipt = await extension.postRemoteExpression(
      { remotePort: testServer.port, routingNonce: nonce, profileId: "prof-size" },
      { text: "x".repeat(20000) }
    );
    assert.equal(receipt.status, "rejected");
    assert.ok(receipt.reason.includes("maximum envelope size"));
    assert.equal(requestCount, 0);
  } finally {
    await testServer.close();
  }
});

test("remote request builder emits the canonical wire payload", () => {
  const fixedTime = 1700000000000;
  const body = extension.buildRemoteExpressionBody({
    rawSessionId: "ses-123",
    toolCallId: "call:abc/123",
    params: { text: "hello", emotion: "happy" },
    now: () => fixedTime,
  });

  assert.deepEqual(body, {
    schemaVersion: "1",
    kind: "pet_expression",
    rawSessionId: "ses-123",
    agentId: "pi",
    createdAtMs: fixedTime,
    dedupKey: "tc_call_abc_123",
    text: "hello",
    emotion: "happy",
  });

  assert.equal(extension.toolCallDedupKey(""), undefined);
  assert.equal(extension.toolCallDedupKey("a".repeat(100)), `tc_${"a".repeat(55)}`);
});

test("remote fallback predicate only accepts identity and session rejections", () => {
  for (const reason of [
    "InvalidPetIdentity: malformed",
    "UnknownPetIdentity: missing",
    "SessionClosed: ended",
  ]) {
    assert.equal(
      extension.isIdentityOrSessionRejection({ status: "rejected", reason }),
      true,
      reason
    );
  }

  for (const receipt of [
    { status: "rejected", reason: "SchemaValidationError: bad emotion" },
    { status: "expired", reason: "UnknownPetIdentity: stale command" },
    { status: "failed", reason: "SessionClosed: I/O failed" },
    { status: "rejected" },
  ]) {
    assert.equal(extension.isIdentityOrSessionRejection(receipt), false, JSON.stringify(receipt));
  }
});
