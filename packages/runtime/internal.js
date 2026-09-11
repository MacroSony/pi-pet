"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { derivePetId, isSafePetId } = require("./identity");

const MAX_ENVELOPE_SIZE = 16384; // 16 KiB
const MAX_TEXT_LENGTH = 2000;
const MAX_ID_LENGTH = 64;
const GC_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

function isSafeId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

function atomicWriteJson(targetPath, data, fsApi = fs) {
  const dir = path.dirname(targetPath);
  fsApi.mkdirSync(dir, { recursive: true });
  const content = `${JSON.stringify(data, null, 2)}\n`;
  const temporaryPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fsApi.writeFileSync(temporaryPath, content, "utf8");
  try {
    fsApi.renameSync(temporaryPath, targetPath);
  } catch {
    try {
      fsApi.writeFileSync(targetPath, content, "utf8");
    } finally {
      try { fsApi.unlinkSync(temporaryPath); } catch {}
    }
  }
}

function resolvePetIdentity(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return { ok: false, reason: "InvalidPetIdentity: options must be an object", petId: null };
  }

  let petId;
  if (options.petId) {
    petId = options.petId;
  } else if (options.rawSessionId || options.id || options.agentId || options.profileId) {
    if (!options.rawSessionId && !options.id) {
      return {
        ok: false,
        reason: "InvalidPetIdentity: rawSessionId is required to derive petId",
        petId: null,
      };
    }
    petId = derivePetId({
      profileId: options.profileId,
      agentId: options.agentId,
      rawSessionId: options.rawSessionId || options.id,
    });
  } else {
    return {
      ok: false,
      reason: "InvalidPetIdentity: session identity is required",
      petId: null,
    };
  }

  if (!isSafePetId(petId)) {
    return {
      ok: false,
      reason: "InvalidPetIdentity: malformed petId or path traversal detected",
      petId: String(petId).slice(0, MAX_ID_LENGTH),
    };
  }

  return { ok: true, petId };
}

module.exports = {
  GC_WINDOW_MS,
  MAX_ENVELOPE_SIZE,
  MAX_ID_LENGTH,
  MAX_TEXT_LENGTH,
  atomicWriteJson,
  derivePetId,
  isSafeId,
  isSafePetId,
  resolvePetIdentity,
};
