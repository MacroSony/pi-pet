"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createGatheringScene } = require("../gathering-scene");

const monitor = { name: "Main", workArea: { x: 0, y: 0, width: 800, height: 600 }, scaleFactor: 1 };
function area(revision = 1, rect = { x: 0, y: 0, width: 600, height: 400 }) {
  return { schemaVersion: "1", revision, area: { monitor, rect } };
}
function report(petId, instanceId, seq, extra = {}) {
  return { schemaVersion: "1", petId, instanceId, seq, controlEpoch: 0, rect: { x: 10, y: 10, width: 80, height: 80 }, scaleFactor: 1,
    monitors: [monitor], blocked: false, cancelSceneId: null, outcome: null, ...extra };
}
function fixture() {
  let time = 1000;
  let savedArea = area();
  let teams = new Map();
  const scene = createGatheringScene({ readArea: () => savedArea, resolveTeam: (petId) => teams.get(petId) || null, now: () => time });
  return { scene, setTime: (value) => { time = value; }, setArea: (value) => { savedArea = value; }, teams };
}
function team(id, members, eligible = members) { return { teamId: id, members, eligible }; }
function startTwo(f) {
  const active = team("team_a", ["p1", "p2"]);
  f.teams.set("p1", active); f.teams.set("p2", active);
  assert.equal(f.scene.report(report("p1", "one", 0)).status, "ok");
  assert.equal(f.scene.report(report("p2", "two", 0)).status, "ok");
  assert.deepEqual(f.scene.start({ schemaVersion: "1", petId: "p1", instanceId: "one" }), { status: "started", participants: 2 });
}

test("gathering plans fresh reports and never reveals other participant ids", () => {
  const f = fixture(); startTwo(f);
  const response = f.scene.report(report("p1", "one", 1));
  assert.equal(response.status, "ok");
  assert.equal(response.scene.area.monitor.name, "Main");
  assert.equal(response.scene.target.width, 80);
  assert.doesNotMatch(JSON.stringify(response), /p2/);
  assert.equal(f.scene.report(report("p1", "one", 1)).reason, "stale_seq");
});
test("TTL, cancellation and late reports cannot revive a participant", () => {
  const f = fixture(); startTwo(f);
  f.setTime(1001);
  const first = f.scene.report(report("p1", "one", 2, { cancelSceneId: "not-this-scene" }));
  assert.ok(first.scene);
  const id = first.scene.sceneId;
  assert.equal(f.scene.report(report("p1", "one", 3, { cancelSceneId: id })).scene, null);
  assert.equal(f.scene.report(report("p1", "one", 4)).scene, null);
});
test("membership changes cancel only affected original members; additions do not join", () => {
  const f = fixture(); startTwo(f);
  const changed = team("team_a", ["p1", "p2"], ["p2"]);
  f.teams.set("p1", changed); f.teams.set("p2", changed);
  assert.equal(f.scene.report(report("p2", "two", 1)).scene !== null, true);
  assert.equal(f.scene.report(report("p1", "one", 1)).scene, null);
  const added = team("team_a", ["p1", "p2", "p3"], ["p1", "p2", "p3"]);
  f.teams.set("p1", added); f.teams.set("p2", added); f.teams.set("p3", added);
  assert.equal(f.scene.report(report("p3", "three", 0)).scene, null);
  assert.equal(f.scene.report(report("p2", "two", 2)).scene !== null, true);
});
test("dissolve and activity-area revision changes end the scene", () => {
  const f = fixture(); startTwo(f);
  f.setArea(area(2));
  assert.equal(f.scene.report(report("p1", "one", 1)).scene, null);
  const dissolved = fixture(); startTwo(dissolved);
  dissolved.teams.clear();
  assert.equal(dissolved.scene.report(report("p1", "one", 1)).scene, null);
});
test("restart cancels old native participation, layout failure is atomic, and another Team is refused", () => {
  const f = fixture(); startTwo(f);
  assert.equal(f.scene.report(report("p1", "replacement", 0)).scene, null);
  assert.ok(f.scene.report(report("p2", "two", 1)).scene);
  const other = team("team_b", ["p3"]); f.teams.set("p3", other);
  assert.equal(f.scene.report(report("p3", "three", 0)).status, "ok");
  assert.equal(f.scene.start({ schemaVersion: "1", petId: "p3", instanceId: "three" }).reason, "other_team_active");
  const small = fixture();
  small.setArea(area(1, { x: 0, y: 0, width: 20, height: 20 }));
  const active = team("team_a", ["p1"]); small.teams.set("p1", active);
  small.scene.report(report("p1", "one", 0));
  assert.equal(small.scene.start({ schemaVersion: "1", petId: "p1", instanceId: "one" }).reason, "insufficient_space");
  assert.equal(small.scene.report(report("p1", "one", 1)).scene, null);
});

test("expired geometry never rejoins old scene and property order is immaterial", () => {
  const f = fixture(); startTwo(f);
  const reversed = {scaleFactor:1,workArea:{height:600,width:800,y:0,x:0},name:"Main"};
  assert.ok(f.scene.report(report("p1", "one", 1, {monitors:[reversed]})).scene);
  f.setTime(4002);
  assert.equal(f.scene.report(report("p1", "one", 2)).scene, null);
});
test("cancel feedback for an old scene cannot cancel a newly requested scene", () => {
  const f = fixture(); startTwo(f);
  const oldId = f.scene.report(report("p1", "one", 1)).scene.sceneId;
  assert.equal(f.scene.start({schemaVersion:"1", petId:"p1", instanceId:"one"}).status, "started");
  const next = f.scene.report(report("p1", "one", 2, {outcome:"cancelled", cancelSceneId:oldId}));
  assert.ok(next.scene); assert.notEqual(next.scene.sceneId, oldId);
});
test("blocked pets, changed geometry and missing monitors cancel without rejoining", () => {
  for (const extra of [{blocked:true}, {rect:{x:0,y:0,width:81,height:80}}, {monitors:[{...monitor,name:'changed'}]}]) {
    const f=fixture(); startTwo(f);
    assert.equal(f.scene.report(report('p1','one',1,extra)).scene,null);
    assert.equal(f.scene.report(report('p1','one',2)).scene,null);
    assert.ok(f.scene.report(report('p2','two',1)).scene);
  }
});
test("end preserves reports, next explicit start can reuse them, failed source reads fail closed", () => {
  const f=fixture(); startTwo(f);
  assert.equal(f.scene.end({schemaVersion:'1',petId:'p1',instanceId:'wrong'}).status,'rejected');
  assert.equal(f.scene.end({schemaVersion:'1',petId:'p2',instanceId:'two'}).status,'ended');
  assert.equal(f.scene.report(report('p1','one',1)).scene,null);
  assert.equal(f.scene.start({schemaVersion:'1',petId:'p1',instanceId:'one'}).status,'started');
  f.setArea(null); assert.equal(f.scene.report(report('p2','two',1)).scene,null);
});
test("DPI projection is conservative and expected post-transition size is accepted", () => {
  const f=fixture(); const active=team('team_a',['p1']); f.teams.set('p1',active);
  f.setArea({schemaVersion:'1',revision:1,area:{monitor:{...monitor,scaleFactor:1.5},rect:{x:0,y:0,width:600,height:400}}});
  const extra={monitors:[{...monitor,scaleFactor:1.5}]};
  f.scene.report(report('p1','one',0,extra));
  assert.equal(f.scene.start({schemaVersion:'1',petId:'p1',instanceId:'one'}).status,'started');
  const response=f.scene.report(report('p1','one',1,extra)); assert.equal(response.scene.target.width,120);
  const transitioned=f.scene.report(report('p1','one',2,{...extra,rect:{x:240,y:140,width:120,height:120},scaleFactor:1.5}));
  assert.ok(transitioned.scene);
});
test("a whole drag between reports cancels an assignment not fetched yet", () => {
  const f=fixture(); startTwo(f);
  // Native has not learned sceneId yet; press+release happened between reports.
  assert.equal(f.scene.report(report('p1','one',1,{controlEpoch:1})).scene,null);
  assert.equal(f.scene.report(report('p1','one',2,{controlEpoch:1})).scene,null);
  assert.ok(f.scene.report(report('p2','two',1)).scene);
  assert.equal(f.scene.start({schemaVersion:'1',petId:'p1',instanceId:'one'}).status,'started');
  assert.ok(f.scene.report(report('p1','one',3,{controlEpoch:1})).scene);
});
