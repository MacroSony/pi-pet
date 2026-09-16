"use strict";

// One desktop setting, written only by its local single-writer coordinator.
// This is not cross-process CAS and contains no session/Team authorization.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function exactKeys(value, keys) {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}
function validRect(r) {
  return exactKeys(r, ["x", "y", "width", "height"])
    && [r.x, r.y, r.width, r.height].every(Number.isSafeInteger)
    && Math.abs(r.x) <= 1000000 && Math.abs(r.y) <= 1000000
    && r.width > 0 && r.width <= 100000 && r.height > 0 && r.height <= 100000;
}
function containsRect(outer, inner) {
  return validRect(outer) && validRect(inner)
    && inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}
function validateActivityArea(area) {
  if (!exactKeys(area, ["monitor", "rect"])) return false;
  const m = area.monitor;
  return exactKeys(m, ["name", "workArea", "scaleFactor"])
    && typeof m.name === "string" && m.name.length <= 256
    && !/[\x00-\x1f\x7f-\x9f]/.test(m.name)
    && Number.isFinite(m.scaleFactor) && m.scaleFactor >= 0.25 && m.scaleFactor <= 8
    && containsRect(m.workArea, area.rect);
}
function validRecord(record) {
  return exactKeys(record, ["schemaVersion", "revision", "area"])
    && record.schemaVersion === "1"
    && Number.isSafeInteger(record.revision) && record.revision >= 0
    && (record.area === null || validateActivityArea(record.area));
}
function error(code) { return Object.assign(new Error(code), { code }); }

function createActivityAreaStore(options = {}) {
  const env = options.env || process.env;
  const dataDir = options.dataDir || env.PI_PET_DATA_DIR
    || path.join(env.USERPROFILE || env.HOME || os.homedir(), ".pi-pet");
  const file = path.join(dataDir, "layout", "activity-area.json");
  function read() {
    try {
      if (fs.statSync(file).size > 4096) throw error("invalid_activity_area_file");
      const content = fs.readFileSync(file, "utf8");
      if (Buffer.byteLength(content) > 4096) throw error("invalid_activity_area_file");
      const record = JSON.parse(content);
      if (!validRecord(record)) throw error("invalid_activity_area_file");
      return record;
    } catch (err) {
      if (err.code === "ENOENT") return { schemaVersion: "1", revision: 0, area: null };
      throw error("activity_area_unavailable");
    }
  }
  function write(input) {
    if (!exactKeys(input, ["baseRevision", "area"]) || !Number.isSafeInteger(input.baseRevision)
      || input.baseRevision < 0 || (input.area !== null && !validateActivityArea(input.area))) {
      throw error("invalid_activity_area");
    }
    const previous = read();
    if (input.baseRevision !== previous.revision) {
      return { status: "conflict", ...previous };
    }
    if (previous.revision >= Number.MAX_SAFE_INTEGER) throw error("activity_area_unavailable");
    const record = { schemaVersion: "1", revision: previous.revision + 1, area: input.area };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      throw error("activity_area_save_failed");
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
    return { status: "updated", ...JSON.parse(JSON.stringify(record)) };
  }
  return { read, write };
}

module.exports = { createActivityAreaStore, validateActivityArea, containsRect };
