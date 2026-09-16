"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createActivityAreaStore, validateActivityArea, containsRect } = require("../activity-area-store");
const area = () => ({ monitor: { name: "Display", workArea: { x: -1920, y: -100, width: 1920, height: 1040 }, scaleFactor: 1.5 }, rect: { x: -1600, y: 0, width: 800, height: 400 } });
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pet-area-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, store: createActivityAreaStore({ dataDir }), file: path.join(dataDir, "layout/activity-area.json") };
}
test("area defaults disabled, persists across restart and is shared with OCC", (t) => {
  const { dataDir, store } = fixture(t);
  assert.deepEqual(store.read(), { schemaVersion: "1", revision: 0, area: null });
  const input = area();
  assert.equal(store.write({ baseRevision: 0, area: input }).status, "updated");
  input.rect.x = 0;
  const second = createActivityAreaStore({ dataDir });
  assert.deepEqual(second.read().area, area());
  const conflict = second.write({ baseRevision: 0, area: null });
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.revision, 1);
  assert.deepEqual(store.read().area, area());
  assert.equal(second.write({ baseRevision: 1, area: null }).revision, 2);
  assert.equal(store.read().area, null);
});
test("strict geometry validates full windows, negative origins and scale", () => {
  assert.equal(validateActivityArea(area()), true);
  for (const mutate of [
    (a) => { a.rect.x = -200; }, (a) => { a.rect.y = 800; },
    (a) => { a.rect.width = 0; }, (a) => { a.rect.height = 0.5; },
    (a) => { a.rect.x = Infinity; }, (a) => { a.monitor.scaleFactor = NaN; },
    (a) => { a.monitor.scaleFactor = 0; }, (a) => { a.monitor.name = "bad\nname"; },
    (a) => { a.monitor.name = "bad\u0085name"; }, (a) => { a.monitor.name = "😀".repeat(129); },
    (a) => { a.token = "nope"; }, (a) => { a.monitor.id = "nope"; },
    (a) => { a.rect.right = 0; }, (a) => { delete a.monitor; },
  ]) { const a = area(); mutate(a); assert.equal(validateActivityArea(a), false); }
  assert.equal(containsRect({ x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 100, height: 100 }), true);
});
test("invalid changes cannot modify a valid saved area", (t) => {
  const { store, file } = fixture(t);
  store.write({ baseRevision: 0, area: area() });
  const before = fs.readFileSync(file, "utf8");
  for (const input of [{ baseRevision: -1, area: null }, { baseRevision: 1 }, { baseRevision: 1, area: {} }, { baseRevision: 1, area: null, extra: true }]) {
    assert.throws(() => store.write(input), /invalid_activity_area/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  }
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["activity-area.json"]);
});
test("corrupt/oversized/future records fail closed without overwriting them", (t) => {
  const { store, file } = fixture(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const raw of ["{bad", " ".repeat(4097), JSON.stringify({ schemaVersion: "2", revision: 1, area: null })]) {
    fs.writeFileSync(file, raw);
    assert.throws(() => store.read(), /activity_area_unavailable/);
    assert.throws(() => store.write({ baseRevision: 0, area: null }), /activity_area_unavailable/);
    assert.equal(fs.readFileSync(file, "utf8"), raw);
  }
});
