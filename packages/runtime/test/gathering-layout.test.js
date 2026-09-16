"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { planGatheringLayout } = require("../gathering-layout");

function assertInsideAndSeparated(area, participants, targets, gap) {
  const windows = targets.map((target) => {
    const participant = participants.find((item) => item.petId === target.petId);
    assert.ok(target.x >= area.x && target.y >= area.y);
    assert.ok(target.x + participant.width <= area.x + area.width);
    assert.ok(target.y + participant.height <= area.y + area.height);
    return { ...target, width: participant.width, height: participant.height };
  });
  for (let i = 0; i < windows.length; i += 1) {
    for (let j = i + 1; j < windows.length; j += 1) {
      const a = windows[i];
      const b = windows[j];
      const separated = a.x + a.width + gap <= b.x || b.x + b.width + gap <= a.x
        || a.y + a.height + gap <= b.y || b.y + b.height + gap <= a.y;
      assert.ok(separated, `${a.petId} and ${b.petId} overlap or miss the gap`);
    }
  }
}

test("lays out heterogeneous windows in order and keeps their full rectangles separated", () => {
  const area = { x: 0, y: 0, width: 300, height: 200 };
  const participants = [
    { petId: "alpha", width: 60, height: 40 },
    { petId: "bravo", width: 40, height: 60 },
    { petId: "charlie", width: 50, height: 30 },
    { petId: "delta", width: 30, height: 50 },
  ];
  const result = planGatheringLayout(area, participants, 10);

  assert.equal(result.ok, true);
  assert.deepEqual(result.targets.map((target) => target.petId), participants.map((item) => item.petId));
  assertInsideAndSeparated(area, participants, result.targets, 10);
});

test("wraps eight members into additional rows using maximum-sized cells", () => {
  const area = { x: 0, y: 0, width: 180, height: 170 };
  const participants = Array.from({ length: 8 }, (_, index) => ({
    petId: `pet_${index}`,
    width: index % 2 ? 45 : 50,
    height: index % 3 ? 35 : 40,
  }));
  const result = planGatheringLayout(area, participants, 10);

  assert.equal(result.ok, true);
  assert.equal(result.targets.length, 8);
  assert.deepEqual(result.targets.map((target) => target.petId), participants.map((item) => item.petId));
  assert.equal(result.targets[3].y, result.targets[0].y + 50);
  assertInsideAndSeparated(area, participants, result.targets, 10);
});

test("centers a single member, including in a negative-origin area", () => {
  const single = planGatheringLayout(
    { x: 10, y: 20, width: 101, height: 99 },
    [{ petId: "solo", width: 40, height: 30 }]
  );
  assert.deepEqual(single, { ok: true, targets: [{ petId: "solo", x: 40, y: 54 }] });

  const negative = planGatheringLayout(
    { x: -500, y: -200, width: 200, height: 120 },
    [{ petId: "north", width: 40, height: 20 }]
  );
  assert.deepEqual(negative, { ok: true, targets: [{ petId: "north", x: -420, y: -150 }] });
});

test("rejects layouts that cannot fit all maximum-sized cells", () => {
  const result = planGatheringLayout(
    { x: 0, y: 0, width: 100, height: 100 },
    [{ petId: "one", width: 60, height: 60 }, { petId: "two", width: 60, height: 60 }]
  );
  assert.deepEqual(result, { ok: false, reason: "insufficient_space" });
});

test("is deterministic and does not depend on caller mutation or global state", () => {
  const area = { x: -20, y: 5, width: 190, height: 120 };
  const participants = [
    { petId: "a", width: 50, height: 40 },
    { petId: "b", width: 30, height: 20 },
    { petId: "c", width: 40, height: 30 },
  ];
  const before = JSON.parse(JSON.stringify({ area, participants }));
  const first = planGatheringLayout(area, participants, 12);
  const second = planGatheringLayout(area, participants, 12);

  assert.deepEqual(first, second);
  assert.deepEqual({ area, participants }, before);
});

test("rejects malformed, fractional, NaN, duplicate, and invalid-gap inputs", () => {
  const area = { x: 0, y: 0, width: 200, height: 100 };
  const valid = [{ petId: "valid", width: 20, height: 20 }];
  const invalidCalls = [
    () => planGatheringLayout({ ...area, extra: true }, valid),
    () => planGatheringLayout({ ...area, x: 0.5 }, valid),
    () => planGatheringLayout({ ...area, width: NaN }, valid),
    () => planGatheringLayout(area, [{ petId: "valid", width: 20 }]),
    () => planGatheringLayout(area, [{ petId: "valid", width: 20.5, height: 20 }]),
    () => planGatheringLayout(area, [{ petId: "valid", width: NaN, height: 20 }]),
    () => planGatheringLayout(area, [
      { petId: "same", width: 20, height: 20 },
      { petId: "same", width: 20, height: 20 },
    ]),
    () => planGatheringLayout(area, valid, -1),
    () => planGatheringLayout(area, valid, 1.5),
    () => planGatheringLayout(area, valid, NaN),
    () => planGatheringLayout(area, valid, 100001),
  ];

  for (const call of invalidCalls) {
    const result = call();
    assert.equal(result.ok, false);
    assert.equal(typeof result.reason, "string");
    assert.equal(Object.hasOwn(result, "targets"), false);
  }
});
