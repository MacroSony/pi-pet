"use strict";

// Identity is shared by status ingestion and expression delivery. If these
// exports diverge, expressExpression cannot find the active status file.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const identity = require("../identity");
const interaction = require("../interaction");
const clawd = require("../adapters/clawd");
const root = require("..");

function legacyPetId(value = {}) {
  const normalize = (text, maxLength) =>
    typeof text === "string"
      ? text.replace(/[\0\r\n]+/g, " ").trim().slice(0, maxLength)
      : "";
  const profileId = normalize(value && value.profileId, 256) || "local";
  const agentId = normalize(value && value.agentId, 256) || "unknown";
  const rawSessionId = normalize(
    (value && value.rawSessionId) || (value && value.id),
    4096
  ) || "unknown";
  const digest = crypto
    .createHash("sha256")
    .update(`${profileId}\0${agentId}\0${rawSessionId}`, "utf8")
    .digest("hex")
    .slice(0, 24);
  return `pet_${digest}`;
}

test("runtime surfaces share one pet identity implementation", () => {
  assert.equal(interaction.derivePetId, identity.derivePetId);
  assert.equal(clawd.stablePetSessionId, identity.derivePetId);
  assert.equal(root.derivePetId, identity.derivePetId);
  assert.equal(root.stablePetSessionId, identity.derivePetId);
});

test("shared identity preserves the legacy byte-for-byte formula", () => {
  const cases = [
    { profileId: "local", agentId: "pi", rawSessionId: "abc-123" },
    { profileId: "bruhw-pc2", agentId: "Pi", rawSessionId: "ses_X/yz" },
    { profileId: "", agentId: "", id: "fallback-id" },
    { profileId: "  padded\t", agentId: "pi", rawSessionId: "a\0b\nc" },
    {},
    null,
    { profileId: "x".repeat(500), agentId: "y".repeat(500), rawSessionId: "z".repeat(5000) },
  ];

  for (const value of cases) {
    assert.equal(identity.derivePetId(value), legacyPetId(value), JSON.stringify(value));
  }
});

test("derivePetId output shape", () => {
  const petId = identity.derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "x" });
  assert.match(petId, /^pet_[a-f0-9]{24}$/);
});
