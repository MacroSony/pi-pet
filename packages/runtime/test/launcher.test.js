"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { isSafeSessionId } = require("..");

const root = path.resolve(__dirname, "../../..");

test("runtime IDs are portable basenames, not Windows ADS or paths", () => {
  for (const value of ["..", "a/b", "a\\b", "pet:stream", "a\n", "a?", "a*", "", "a".repeat(129)]) {
    assert.equal(isSafeSessionId(value), false, JSON.stringify(value));
  }
  assert.equal(isSafeSessionId("pet_a-1"), true);
});

test("POSIX launcher resolves root independently, honors overrides and forwards arguments", {
  skip: process.platform === "win32",
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-launcher-"));
  try {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    const output = path.join(dir, "observed.json");
    const fakeNpm = path.join(bin, "npm");
    // No GUI, dependency install, or real npm execution: record only the contract.
    fs.writeFileSync(fakeNpm, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.PET_TEST_OUTPUT, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),module:process.env.CLAWD_PET_RUNTIME_MODULE,status:process.env.CLAWD_PET_BRIDGE_STATUS_DIR,renderer:process.env.CLAWD_PET_BRIDGE_RENDERER_BIN,assets:process.env.CLAWD_PET_BRIDGE_ASSETS_DIR,agents:process.env.CLAWD_PET_BRIDGE_AGENT_IDS}));\n`);
    fs.chmodSync(fakeNpm, 0o755);
    const env = {
      PATH: bin + path.delimiter + process.env.PATH,
      HOME: dir,
      PET_TEST_OUTPUT: output,
      CLAWD_PET_BRIDGE_STATUS_DIR: path.join(dir, "custom status"),
      CLAWD_PET_BRIDGE_ASSETS_DIR: path.join(dir, "custom assets"),
      CLAWD_PET_BRIDGE_RENDERER_BIN: process.execPath,
      CLAWD_PET_BRIDGE_AGENT_IDS: "pi,codex",
    };
    const result = spawnSync("sh", [path.join(root, "scripts/run-with-bridge.sh"), "--example", "two words"], {
      cwd: dir, env, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), {
      args: ["start", "--", "--example", "two words"],
      cwd: path.join(root, "clawd-on-desk"),
      module: path.join(root, "packages/runtime"),
      status: env.CLAWD_PET_BRIDGE_STATUS_DIR,
      renderer: process.execPath,
      assets: env.CLAWD_PET_BRIDGE_ASSETS_DIR,
      agents: "pi,codex",
    });
    fs.unlinkSync(output);
    const missing = spawnSync("sh", [path.join(root, "scripts/run-with-bridge.sh")], {
      cwd: dir, env: { ...env, CLAWD_PET_RUNTIME_MODULE: path.join(dir, "missing") }, encoding: "utf8",
    });
    assert.notEqual(missing.status, 0);
    assert.equal(fs.existsSync(output), false);
    assert.match(missing.stderr, /runtime module was not found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
