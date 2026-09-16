"use strict";

const { randomUUID } = require("node:crypto");
const { isSafePetId } = require("./identity");
const { validateActivityArea } = require("./activity-area-store");
const { planGatheringLayout } = require("./gathering-layout");

const REPORT_TTL_MS = 3000;
const MAX_REPORTS = 128;
const OPAQUE_ID = /^[A-Za-z0-9._:-]{1,64}$/;

function exact(value, keys) {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function rect(value) {
  return exact(value, ["x", "y", "width", "height"])
    && [value.x, value.y, value.width, value.height].every(Number.isSafeInteger)
    && Math.abs(value.x) <= 1000000 && Math.abs(value.y) <= 1000000
    && value.width > 0 && value.width <= 100000 && value.height > 0 && value.height <= 100000;
}
function opaque(value) { return typeof value === "string" && OPAQUE_ID.test(value); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
function same(a, b) { return JSON.stringify(stable(a)) === JSON.stringify(stable(b)); }
function monitorValid(monitor) {
  return validateActivityArea({ monitor, rect: monitor && monitor.workArea });
}
function validMonitors(monitors) {
  if (!Array.isArray(monitors) || monitors.length < 1 || monitors.length > 16) return false;
  const seen = new Set();
  return monitors.every((monitor) => {
    if (!monitorValid(monitor)) return false;
    const signature = JSON.stringify(stable(monitor));
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}
function validReport(data) {
  return exact(data, ["schemaVersion", "petId", "instanceId", "seq", "controlEpoch", "rect", "scaleFactor", "monitors", "blocked", "cancelSceneId", "outcome"])
    && data.schemaVersion === "1" && isSafePetId(data.petId) && opaque(data.instanceId)
    && Number.isSafeInteger(data.seq) && data.seq >= 0 && Number.isSafeInteger(data.controlEpoch) && data.controlEpoch >= 0 && rect(data.rect)
    && Number.isFinite(data.scaleFactor) && data.scaleFactor >= 0.25 && data.scaleFactor <= 8
    && validMonitors(data.monitors) && typeof data.blocked === "boolean"
    && (data.cancelSceneId === null || opaque(data.cancelSceneId))
    && (data.outcome === null || data.outcome === "moving" || data.outcome === "arrived" || data.outcome === "cancelled");
}
function validCaller(data) {
  return exact(data, ["schemaVersion", "petId", "instanceId"])
    && data.schemaVersion === "1" && isSafePetId(data.petId) && opaque(data.instanceId);
}
function validAreaRecord(record) {
  return exact(record, ["schemaVersion", "revision", "area"]) && record.schemaVersion === "1"
    && Number.isSafeInteger(record.revision) && record.revision >= 0 && validateActivityArea(record.area);
}
function validTeam(team) {
  if (!team || typeof team !== "object" || Array.isArray(team) || typeof team.teamId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(team.teamId)
    || !Array.isArray(team.members) || !Array.isArray(team.eligible) || team.members.length < 1 || team.members.length > 8) return false;
  const members = new Set(team.members);
  return team.members.every(isSafePetId) && members.size === team.members.length
    && team.eligible.every((petId) => members.has(petId));
}
function hasMonitor(monitors, monitor) { return monitors.some((candidate) => same(candidate, monitor)); }

function createGatheringScene({ readArea, resolveTeam, now = Date.now } = {}) {
  if (typeof readArea !== "function" || typeof resolveTeam !== "function" || typeof now !== "function") {
    throw new TypeError("createGatheringScene requires readArea, resolveTeam, and now");
  }
  const reports = new Map();
  let scene = null;

  function reject(reason) { return { status: "rejected", reason }; }
  function readValidArea() {
    const record = readArea();
    return validAreaRecord(record) ? record : null;
  }
  function prune(time) {
    for (const [petId, report] of reports) {
      if (time < report.at || time - report.at > REPORT_TTL_MS) {
        cancelParticipant(petId);
        reports.delete(petId);
      }
    }
    if (reports.size <= MAX_REPORTS) return;
    [...reports.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, reports.size - MAX_REPORTS)
      .forEach(([petId]) => {
        cancelParticipant(petId);
        reports.delete(petId);
      });
  }
  function cancelParticipant(petId) {
    if (!scene) return;
    const participant = scene.participants.get(petId);
    if (participant) participant.cancelled = true;
  }
  // This is deliberately checked on every response that could cause a move.
  // It only removes original participants; new Team members never join this scene.
  function validateScene() {
    if (!scene) return { ok: true };
    let area;
    try { area = readValidArea(); } catch { scene = null; return { ok: false, reason: "area_unavailable" }; }
    if (!area || area.revision !== scene.revision || !same(area.area, scene.area)) {
      scene = null;
      return { ok: false, reason: "area_changed" };
    }
    let anySameTeam = false;
    try {
      for (const participant of scene.participants.values()) {
        if (participant.cancelled) continue;
        const team = resolveTeam(participant.petId);
        if (!validTeam(team) || team.teamId !== scene.teamId || !team.members.includes(participant.petId)
          || !team.eligible.includes(participant.petId)) {
          participant.cancelled = true;
        } else anySameTeam = true;
      }
    } catch {
      scene = null;
      return { ok: false, reason: "team_unavailable" };
    }
    // A dissolved Team has no remaining authoritative member. A removal/offline
    // leaves another member authoritative, so it only cancels the affected pet.
    if (!anySameTeam) {
      scene = null;
      return { ok: false, reason: "team_ended" };
    }
    return { ok: true };
  }
  function responseFor(petId) {
    if (!scene) return { status: "ok", scene: null };
    const participant = scene.participants.get(petId);
    if (!participant || participant.cancelled) return { status: "ok", scene: null };
    return { status: "ok", scene: {
      sceneId: scene.sceneId,
      target: clone(participant.target),
      area: clone(scene.area),
    } };
  }

  function report(data) {
    if (!validReport(data)) return reject("invalid_report");
    const time = now();
    if (!Number.isSafeInteger(time) || time < 0) return reject("clock_unavailable");
    prune(time);
    const previous = reports.get(data.petId);
    if (previous && previous.instanceId === data.instanceId && data.seq <= previous.seq) return reject("stale_seq");
    if (previous && previous.instanceId !== data.instanceId) cancelParticipant(data.petId);
    reports.set(data.petId, { ...clone(data), at: time });
    // Enforce the bound in this call, not on the next report. Eviction has the
    // same no-rejoin semantics as TTL expiry, including unseen assignments.
    if (reports.size > MAX_REPORTS) prune(time);

    const current = validateScene();
    if (!current.ok && (current.reason === "area_unavailable" || current.reason === "team_unavailable")) return reject(current.reason);
    if (scene) {
      const participant = scene.participants.get(data.petId);
      if (participant) {
        const sourceSize = { width: participant.sourceWidth, height: participant.sourceHeight };
        const targetSize = { width: participant.target.width, height: participant.target.height };
        if (participant.instanceId !== data.instanceId || participant.controlEpoch !== data.controlEpoch || !same(participant.monitors, data.monitors)
          || (!same(sourceSize, { width: data.rect.width, height: data.rect.height })
            && !same(targetSize, { width: data.rect.width, height: data.rect.height }))) {
          participant.cancelled = true;
        }
        if (data.blocked || data.cancelSceneId === scene.sceneId) participant.cancelled = true;
        if (data.outcome === "arrived" && !participant.cancelled) participant.arrived = true;
      }
    }
    return responseFor(data.petId);
  }

  function start(data) {
    if (!validCaller(data)) return reject("invalid_start");
    const time = now();
    if (!Number.isSafeInteger(time) || time < 0) return reject("clock_unavailable");
    prune(time);
    const callerReport = reports.get(data.petId);
    if (!callerReport || callerReport.instanceId !== data.instanceId || callerReport.blocked || time - callerReport.at > REPORT_TTL_MS) {
      return reject("caller_not_live");
    }
    let team, area;
    try { team = resolveTeam(data.petId); area = readValidArea(); } catch { return reject("unavailable"); }
    if (!validTeam(team) || !team.members.includes(data.petId) || !team.eligible.includes(data.petId)) return reject("team_unavailable");
    if (!area) return reject("area_unavailable");
    const old = validateScene();
    if (!old.ok && (old.reason === "area_unavailable" || old.reason === "team_unavailable")) return reject(old.reason);
    if (scene && scene.teamId !== team.teamId) return reject("other_team_active");

    const selected = [];
    for (const petId of team.members) {
      if (!team.eligible.includes(petId)) continue;
      const item = reports.get(petId);
      if (!item || item.blocked || time - item.at > REPORT_TTL_MS || !hasMonitor(item.monitors, area.area.monitor)) continue;
      selected.push({ petId, report: item });
    }
    if (!selected.some((entry) => entry.petId === data.petId)) return reject("caller_not_eligible");
    const sizes = selected.map(({ petId, report }) => ({
      petId,
      width: Math.ceil(report.rect.width * area.area.monitor.scaleFactor / report.scaleFactor),
      height: Math.ceil(report.rect.height * area.area.monitor.scaleFactor / report.scaleFactor),
    }));
    const layout = planGatheringLayout(area.area.rect, sizes);
    if (!layout.ok) return reject(layout.reason === "insufficient_space" ? "insufficient_space" : "invalid_layout");
    const targets = new Map(layout.targets.map((target) => [target.petId, target]));
    scene = {
      sceneId: randomUUID(), teamId: team.teamId, revision: area.revision, area: clone(area.area), participants: new Map(),
    };
    for (const size of sizes) {
      const reportItem = reports.get(size.petId);
      const position = targets.get(size.petId);
      scene.participants.set(size.petId, {
        petId: size.petId, instanceId: reportItem.instanceId, controlEpoch: reportItem.controlEpoch, sourceWidth: reportItem.rect.width,
        sourceHeight: reportItem.rect.height, monitors: clone(reportItem.monitors),
        target: { x: position.x, y: position.y, width: size.width, height: size.height }, cancelled: false, arrived: false,
      });
    }
    return { status: "started", participants: sizes.length };
  }

  function end(data) {
    if (!validCaller(data)) return reject("invalid_end");
    const item = reports.get(data.petId);
    if (!scene || !item || item.instanceId !== data.instanceId) return reject("not_active");
    let team;
    try { team = resolveTeam(data.petId); } catch { return reject("unavailable"); }
    if (!validTeam(team) || team.teamId !== scene.teamId || !team.members.includes(data.petId)) return reject("not_member");
    scene = null;
    return { status: "ended" };
  }
  return { report, start, end };
}

module.exports = { createGatheringScene, REPORT_TTL_MS, MAX_REPORTS };
