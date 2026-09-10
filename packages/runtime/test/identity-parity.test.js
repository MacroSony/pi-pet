"use strict";

// Parity guard: interaction.derivePetId must stay byte-identical to the Clawd
// adapter's stablePetSessionId — it is the single source of truth for pet
// identity, and status files on disk are named by it. If these diverge,
// expressExpression can never find the active session.

const test = require("node:test");
const assert = require("node:assert/strict");

const { derivePetId } = require("../interaction");
const { stablePetSessionId } = require("../adapters/clawd");

test("derivePetId matches stablePetSessionId byte-for-byte", () => {
  const cases = [
    { profileId: "local", agentId: "pi", rawSessionId: "abc-123" },
    // mixed-case agentId must NOT be lowercased (adapter does not)
    { profileId: "bruhw-pc2", agentId: "Pi", rawSessionId: "ses_X/yz" },
    // id fallback + empty components hitting defaults
    { profileId: "", agentId: "", id: "fallback-id" },
    // control-char normalization parity
    { profileId: "  padded\t", agentId: "pi", rawSessionId: "a\0b\nc" },
  ];
  for (const identity of cases) {
    assert.equal(derivePetId(identity), stablePetSessionId(identity), JSON.stringify(identity));
  }
});

test("derivePetId output shape", () => {
  const petId = derivePetId({ profileId: "local", agentId: "pi", rawSessionId: "x" });
  assert.match(petId, /^pet_[a-f0-9]{24}$/);
});
