"use strict";

// Root-owned shared pet identity module.
// Single source of truth for deterministic petId calculation and identity string normalization.

const crypto = require("node:crypto");

const PET_ID_PREFIX = "pet_";
const PET_ID_HASH_LENGTH = 24;

function normalizeIdentityText(value, maxLength = 256) {
  if (typeof value !== "string") return "";
  return value.replace(/[\0\r\n]+/g, " ").trim().slice(0, maxLength);
}

function derivePetId(identity = {}) {
  const profileId = normalizeIdentityText(identity && identity.profileId, 256) || "local";
  const agentId = normalizeIdentityText(identity && identity.agentId, 256) || "unknown";
  const rawSessionId = normalizeIdentityText(
    (identity && identity.rawSessionId) || (identity && identity.id),
    4096
  ) || "unknown";

  const digest = crypto
    .createHash("sha256")
    .update(`${profileId}\0${agentId}\0${rawSessionId}`, "utf8")
    .digest("hex")
    .slice(0, PET_ID_HASH_LENGTH);

  return `${PET_ID_PREFIX}${digest}`;
}

function isSafePetId(petId) {
  return typeof petId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(petId) && !petId.includes("..");
}

module.exports = { derivePetId, isSafePetId };
