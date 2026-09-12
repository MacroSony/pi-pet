"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  MAX_TEAM_MEMBERS,
  MAX_TEAM_NAME_LENGTH,
  MIN_TEAM_NAME_LENGTH,
  TEAM_MEMBERSHIP_POLICY,
  VALID_TEAM_ROLES,
  VALID_TEAM_STATUSES,
  createTeamStore,
  derivePetId,
  isSafeTeamId,
} = require("..");

const temporaryDirs = [];

const USER_ACTOR = Object.freeze({ kind: "user" });

afterEach(() => {
  while (temporaryDirs.length) {
    fs.rmSync(temporaryDirs.pop(), { recursive: true, force: true });
  }
});

function createTestEnvironment() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-test-teams-"));
  temporaryDirs.push(dataDir);
  return { dataDir };
}

function makePetId(name) {
  return derivePetId({ profileId: "local", agentId: "pi", rawSessionId: name });
}

describe("Team Store: Factory and Constants", () => {
  it("exports expected constants and helper functions", () => {
    assert.strictEqual(MAX_TEAM_MEMBERS, 8);
    assert.strictEqual(MIN_TEAM_NAME_LENGTH, 1);
    assert.strictEqual(MAX_TEAM_NAME_LENGTH, 80);
    assert.strictEqual(TEAM_MEMBERSHIP_POLICY, "user_only");
    assert.deepStrictEqual(Array.from(VALID_TEAM_ROLES), ["leader", "member", "observer"]);
    assert.deepStrictEqual(Array.from(VALID_TEAM_STATUSES), ["active", "dissolved"]);
    assert.strictEqual(isSafeTeamId("team_abc123"), true);
    assert.strictEqual(isSafeTeamId("team_../unsafe"), false);
    assert.strictEqual(isSafeTeamId("invalid_prefix"), false);
  });
});

describe("Team Store: Creation & Querying (Success)", () => {
  it("creates a team with default single leader member, status active, revision 1", () => {
    const { dataDir } = createTestEnvironment();
    const mockTime = 1000000;
    const store = createTeamStore({ dataDir, now: () => mockTime });

    const leaderPetId = makePetId("leader-1");
    const result = store.createTeam({
      name: "Alpha Squad",
      leaderPetId,
      actor: USER_ACTOR,
    });

    assert.strictEqual(result.ok, true);
    const team = result.team;
    assert.strictEqual(team.schemaVersion, "1");
    assert.match(team.teamId, /^team_[A-Za-z0-9_-]{1,60}$/);
    assert.strictEqual(team.name, "Alpha Squad");
    assert.strictEqual(team.status, "active");
    assert.strictEqual(team.revision, 1);
    assert.strictEqual(team.membershipPolicy, "user_only");
    assert.strictEqual(team.leaderPetId, leaderPetId);
    assert.strictEqual(team.createdAtMs, 1000000);
    assert.strictEqual(team.updatedAtMs, 1000000);
    assert.strictEqual(team.members.length, 1);
    assert.deepStrictEqual(team.members[0], {
      petId: leaderPetId,
      role: "leader",
      joinedAtMs: 1000000,
    });

    // Verify on disk file
    const filePath = path.join(dataDir, "teams", `team-${team.teamId}.json`);
    assert.strictEqual(fs.existsSync(filePath), true);
    const onDisk = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.deepStrictEqual(onDisk, team);

    // Query via getTeam with plain object
    const fetched = store.getTeam({ teamId: team.teamId });
    assert.deepStrictEqual(fetched, team);
  });

  it("creates a team with multiple initial members including member and observer roles", () => {
    const { dataDir } = createTestEnvironment();
    const store = createTeamStore({ dataDir });

    const leader = makePetId("leader");
    const member1 = makePetId("member-1");
    const observer1 = makePetId("observer-1");

    const result = store.createTeam({
      name: "Core Devs",
      leaderPetId: leader,
      members: [
        { petId: leader, role: "leader" },
        { petId: member1, role: "member" },
        { petId: observer1, role: "observer" },
      ],
      actor: USER_ACTOR,
    });

    assert.strictEqual(result.ok, true);
    const team = result.team;
    assert.strictEqual(team.members.length, 3);
    assert.strictEqual(team.members.find((m) => m.petId === leader).role, "leader");
    assert.strictEqual(team.members.find((m) => m.petId === member1).role, "member");
    assert.strictEqual(team.members.find((m) => m.petId === observer1).role, "observer");
  });

  it("rejects a conflicting explicit role for the designated leader", () => {
    const { dataDir } = createTestEnvironment();
    const store = createTeamStore({ dataDir });
    const leader = makePetId("leader-conflict");

    const result = store.createTeam({
      name: "Conflicting Leader",
      leaderPetId: leader,
      members: [{ petId: leader, role: "observer" }],
      actor: USER_ACTOR,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "invalid_leader_role");
  });

  it("creates a team when members array contains string IDs and automatically adds leader", () => {
    const { dataDir } = createTestEnvironment();
    const store = createTeamStore({ dataDir });

    const leader = makePetId("leader");
    const member1 = makePetId("member-1");

    const result = store.createTeam({
      name: "Simple Team",
      leaderPetId: leader,
      members: [member1],
      actor: USER_ACTOR,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.team.members.length, 2);
    assert.strictEqual(result.team.members[0].petId, leader);
    assert.strictEqual(result.team.members[0].role, "leader");
    assert.strictEqual(result.team.members[1].petId, member1);
    assert.strictEqual(result.team.members[1].role, "member");
  });

  it("lists teams for a specific pet (listTeamsForPet)", () => {
    const { dataDir } = createTestEnvironment();
    const store = createTeamStore({ dataDir });

    const petA = makePetId("petA");
    const petB = makePetId("petB");
    const petC = makePetId("petC");

    const t1 = store.createTeam({ name: "Team 1", leaderPetId: petA, members: [petB], actor: USER_ACTOR }).team;
    const t2 = store.createTeam({ name: "Team 2", leaderPetId: petB, members: [petC], actor: USER_ACTOR }).team;
    const t3 = store.createTeam({ name: "Team 3", leaderPetId: petC, actor: USER_ACTOR }).team;

    // petA is in Team 1 only
    const petATeams = store.listTeamsForPet({ petId: petA });
    assert.strictEqual(petATeams.length, 1);
    assert.strictEqual(petATeams[0].teamId, t1.teamId);

    // petB is in Team 1 and Team 2
    const petBTeams = store.listTeamsForPet({ petId: petB });
    assert.strictEqual(petBTeams.length, 2);
    const petBTeamIds = petBTeams.map((t) => t.teamId).sort();
    assert.deepStrictEqual(petBTeamIds, [t1.teamId, t2.teamId].sort());

    // petC is in Team 2 and Team 3
    const petCTeams = store.listTeamsForPet({ petId: petC });
    assert.strictEqual(petCTeams.length, 2);

    // Unknown pet has no teams
    const unknownTeams = store.listTeamsForPet({ petId: makePetId("unknown") });
    assert.deepStrictEqual(unknownTeams, []);
  });
});

describe("Team Store: Caller Restriction & Envelope Protection", () => {
  it("forbids caller-specified teamId and createdAtMs in createTeam", () => {
    const { dataDir } = createTestEnvironment();
    const store = createTeamStore({ dataDir });
    const leader = makePetId("leader");

    const resTeamId = store.createTeam({
      name: "Bad Team",
      leaderPetId: leader,
      teamId: "team_custom_001",
      actor: USER_ACTOR,
    });
    assert.strictEqual(resTeamId.ok, false);
    assert.strictEqual(resTeamId.error, "invalid_options");

    const resCreatedAt = store.createTeam({
      name: "Bad Team 2",
      leaderPetId: leader,
      createdAtMs: 1234567,
      actor: USER_ACTOR,
    });
    assert.strictEqual(resCreatedAt.ok, false);
    assert.strictEqual(resCreatedAt.error, "invalid_options");
  });

  it("forbids caller-specified joinedAtMs on members in createTeam", () => {
    const { dataDir } = createTestEnvironment();
    const store = createTeamStore({ dataDir });
    const leader = makePetId("leader");
    const m1 = makePetId("m1");

    const res = store.createTeam({
      name: "Bad Member",
      leaderPetId: leader,
      members: [{ petId: m1, joinedAtMs: 1000 }],
      actor: USER_ACTOR,
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "invalid_members");
  });

  it("rejects unknown option keys on all methods (prevent envelope expansion)", () => {
    const { dataDir } = createTestEnvironment();
    const store = createTeamStore({ dataDir });
    const leader = makePetId("leader");
    const m1 = makePetId("m1");

    // createTeam with extra key
    const rCreate = store.createTeam({
      name: "T1",
      leaderPetId: leader,
      actor: USER_ACTOR,
      unknownKey: "bad",
    });
    assert.strictEqual(rCreate.ok, false);
    assert.strictEqual(rCreate.error, "invalid_options");

    // create valid team
    const validTeam = store.createTeam({
      name: "Valid",
      leaderPetId: leader,
      actor: USER_ACTOR,
    }).team;

    // getTeam with non-plain-object / extra key
    assert.strictEqual(store.getTeam(validTeam.teamId), null);
    assert.strictEqual(store.getTeam({ teamId: validTeam.teamId, extra: 1 }), null);

    // listTeamsForPet with non-plain-object / extra key
    assert.deepStrictEqual(store.listTeamsForPet(leader), []);
    assert.deepStrictEqual(store.listTeamsForPet({ petId: leader, extra: 1 }), []);

    // addMember with extra key
    const rAdd = store.addMember({
      teamId: validTeam.teamId,
      petId: m1,
      baseRevision: 1,
      actor: USER_ACTOR,
      extra: true,
    });
    assert.strictEqual(rAdd.ok, false);
    assert.strictEqual(rAdd.error, "invalid_options");

    // removeMember with extra key
    const rRemove = store.removeMember({
      teamId: validTeam.teamId,
      petId: m1,
      baseRevision: 1,
      actor: USER_ACTOR,
      extra: true,
    });
    assert.strictEqual(rRemove.ok, false);
    assert.strictEqual(rRemove.error, "invalid_options");

    // setMemberRole with extra key
    const rRole = store.setMemberRole({
      teamId: validTeam.teamId,
      petId: m1,
      role: "member",
      baseRevision: 1,
      actor: USER_ACTOR,
      extra: true,
    });
    assert.strictEqual(rRole.ok, false);
    assert.strictEqual(rRole.error, "invalid_options");

    // dissolveTeam with extra key
    const rDissolve = store.dissolveTeam({
      teamId: validTeam.teamId,
      baseRevision: 1,
      actor: USER_ACTOR,
      extra: true,
    });
    assert.strictEqual(rDissolve.ok, false);
    assert.strictEqual(rDissolve.error, "invalid_options");
  });

  it("rejects non-plain object or multi-argument calls without normalizer overhead", () => {
    const { dataDir } = createTestEnvironment();
    const store = createTeamStore({ dataDir });
    const leader = makePetId("leader");
    const m1 = makePetId("m1");

    const team = store.createTeam({ name: "T", leaderPetId: leader, actor: USER_ACTOR }).team;

    // Overload calls with 2 arguments
    const r2Args = store.addMember(team.teamId, { petId: m1, baseRevision: 1, actor: USER_ACTOR });
    assert.strictEqual(r2Args.ok, false);
    assert.strictEqual(r2Args.error, "invalid_options");

    // Primitive / null / array options
    assert.strictEqual(store.createTeam(null).ok, false);
    assert.strictEqual(store.createTeam("string").ok, false);
    assert.strictEqual(store.createTeam([]).ok, false);
    assert.strictEqual(store.addMember(null).ok, false);
    assert.strictEqual(store.removeMember(null).ok, false);
    assert.strictEqual(store.setMemberRole(null).ok, false);
    assert.strictEqual(store.dissolveTeam(null).ok, false);
  });
});

describe("Team Store: ID Collision Handling", () => {
  it("retries on teamId collision and fails explicitly without overwriting existing team", () => {
    const { dataDir } = createTestEnvironment();
    const leader1 = makePetId("leader-1");
    const leader2 = makePetId("leader-2");

    // Mock randomBytes that always returns the exact same hex
    const fixedBuffer = Buffer.from("0123456789abcdef01234567", "hex");
    const store = createTeamStore({
      dataDir,
      randomBytes: () => fixedBuffer,
    });

    // First create succeeds
    const firstRes = store.createTeam({
      name: "First Team",
      leaderPetId: leader1,
      actor: USER_ACTOR,
    });
    assert.strictEqual(firstRes.ok, true);
    assert.strictEqual(firstRes.team.teamId, "team_0123456789abcdef01234567");

    // Second create with same collision generator should retry and fail with id_collision
    const secondRes = store.createTeam({
      name: "Second Team",
      leaderPetId: leader2,
      actor: USER_ACTOR,
    });
    assert.strictEqual(secondRes.ok, false);
    assert.strictEqual(secondRes.error, "id_collision");

    // Verify first team was not overwritten
    const fetched = store.getTeam({ teamId: "team_0123456789abcdef01234567" });
    assert.strictEqual(fetched.name, "First Team");
    assert.strictEqual(fetched.leaderPetId, leader1);
  });
});

describe("Team Store: Strict Team Name & Control Character Validation", () => {
  it("trims whitespace and accepts names between 1 and 80 code points", () => {
    const { dataDir } = createTestEnvironment();
    const store = createTeamStore({ dataDir });
    const leader = makePetId("leader");

    // 1 code point
    const r1 = store.createTeam({ name: "A", leaderPetId: leader, actor: USER_ACTOR });
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.team.name, "A");

    // Trimmed name
    const rTrim = store.createTeam({ name: "  Trimmed Team  ", leaderPetId: leader, actor: USER_ACTOR });
    assert.strictEqual(rTrim.ok, true);
    assert.strictEqual(rTrim.team.name, "Trimmed Team");

    // 80 emoji code points
    const emoji80 = "🚀".repeat(80);
    assert.strictEqual(Array.from(emoji80).length, 80);
    const r2 = store.createTeam({ name: emoji80, leaderPetId: leader, actor: USER_ACTOR });
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.team.name, emoji80);
  });

  it("rejects C0 and C1 control characters in team name", () => {
    const { dataDir } = createTestEnvironment();
    const store = createTeamStore({ dataDir });
    const leader = makePetId("leader");

    // C0 controls: \x00, \n, \r, \t, \x1F, \x7F
    assert.strictEqual(store.createTeam({ name: "Team\x00Null", leaderPetId: leader, actor: USER_ACTOR }).error, "invalid_name");
    assert.strictEqual(store.createTeam({ name: "Team\nNewline", leaderPetId: leader, actor: USER_ACTOR }).error, "invalid_name");
    assert.strictEqual(store.createTeam({ name: "Team\tTab", leaderPetId: leader, actor: USER_ACTOR }).error, "invalid_name");
    assert.strictEqual(store.createTeam({ name: "Team\x7FDel", leaderPetId: leader, actor: USER_ACTOR }).error, "invalid_name");
    assert.strictEqual(store.createTeam({ name: "Team\x1FUnit", leaderPetId: leader, actor: USER_ACTOR }).error, "invalid_name");

    // C1 controls: \x80 to \x9F
    assert.strictEqual(store.createTeam({ name: "Team\x80C1", leaderPetId: leader, actor: USER_ACTOR }).error, "invalid_name");
    assert.strictEqual(store.createTeam({ name: "Team\x9FC1", leaderPetId: leader, actor: USER_ACTOR }).error, "invalid_name");
  });

  it("rejects empty name, all-whitespace name, or names exceeding 80 code points after trim", () => {
    const { dataDir } = createTestEnvironment();
    const store = createTeamStore({ dataDir });
    const leader = makePetId("leader");

    const rEmpty = store.createTeam({ name: "", leaderPetId: leader, actor: USER_ACTOR });
    assert.strictEqual(rEmpty.ok, false);
    assert.strictEqual(rEmpty.error, "invalid_name");

    const rSpaces = store.createTeam({ name: "     ", leaderPetId: leader, actor: USER_ACTOR });
    assert.strictEqual(rSpaces.ok, false);
    assert.strictEqual(rSpaces.error, "invalid_name");

    const emoji81 = "🚀".repeat(81);
    const rTooLong = store.createTeam({ name: emoji81, leaderPetId: leader, actor: USER_ACTOR });
    assert.strictEqual(rTooLong.ok, false);
    assert.strictEqual(rTooLong.error, "invalid_name");
  });
});

describe("Team Store: Strict Actor Authorization", () => {
  it("strictly requires actor to be { kind: 'user' } and rejects all other forms", () => {
    const { dataDir } = createTestEnvironment();
    const store = createTeamStore({ dataDir });
    const leader = makePetId("leader");
    const m1 = makePetId("m1");

    // Missing actor
    assert.strictEqual(store.createTeam({ name: "T", leaderPetId: leader }).error, "forbidden");
    // Undefined/null actor
    assert.strictEqual(store.createTeam({ name: "T", leaderPetId: leader, actor: undefined }).error, "forbidden");
    assert.strictEqual(store.createTeam({ name: "T", leaderPetId: leader, actor: null }).error, "forbidden");
    // String actor
    assert.strictEqual(store.createTeam({ name: "T", leaderPetId: leader, actor: "user" }).error, "forbidden");
    assert.strictEqual(store.createTeam({ name: "T", leaderPetId: leader, actor: "agent" }).error, "forbidden");
    // Empty object
    assert.strictEqual(store.createTeam({ name: "T", leaderPetId: leader, actor: {} }).error, "forbidden");
    // Wrong kind
    assert.strictEqual(store.createTeam({ name: "T", leaderPetId: leader, actor: { kind: "agent" } }).error, "forbidden");
    // Wrong property
    assert.strictEqual(store.createTeam({ name: "T", leaderPetId: leader, actor: { type: "user" } }).error, "forbidden");
    // Conflicting / extra fields
    assert.strictEqual(store.createTeam({ name: "T", leaderPetId: leader, actor: { kind: "user", role: "agent" } }).error, "forbidden");
    assert.strictEqual(store.createTeam({ name: "T", leaderPetId: leader, actor: { kind: "user", extra: 123 } }).error, "forbidden");

    // Valid user actor succeeds
    const team = store.createTeam({ name: "T", leaderPetId: leader, actor: USER_ACTOR }).team;

    // Check all mutations with bad actors
    assert.strictEqual(store.addMember({ teamId: team.teamId, petId: m1, baseRevision: 1, actor: { type: "agent" } }).error, "forbidden");
    assert.strictEqual(store.addMember({ teamId: team.teamId, petId: m1, baseRevision: 1, actor: null }).error, "forbidden");
    assert.strictEqual(store.removeMember({ teamId: team.teamId, petId: m1, baseRevision: 1, actor: "user" }).error, "forbidden");
    assert.strictEqual(store.setMemberRole({ teamId: team.teamId, petId: m1, role: "observer", baseRevision: 1, actor: {} }).error, "forbidden");
    assert.strictEqual(store.dissolveTeam({ teamId: team.teamId, baseRevision: 1, actor: { kind: "user", spoof: true } }).error, "forbidden");
  });
});

describe("Team Store: Base Revision Safe Integer Validation & OCC", () => {
  it("rejects non-safe-integer baseRevisions with invalid_revision", () => {
    const { dataDir } = createTestEnvironment();
    const store = createTeamStore({ dataDir });
    const leader = makePetId("leader");
    const m1 = makePetId("m1");

    const team = store.createTeam({ name: "Rev Test", leaderPetId: leader, actor: USER_ACTOR }).team;

    assert.strictEqual(store.addMember({ teamId: team.teamId, petId: m1, baseRevision: 1.5, actor: USER_ACTOR }).error, "invalid_revision");
    assert.strictEqual(store.addMember({ teamId: team.teamId, petId: m1, baseRevision: "1", actor: USER_ACTOR }).error, "invalid_revision");
    assert.strictEqual(store.addMember({ teamId: team.teamId, petId: m1, baseRevision: NaN, actor: USER_ACTOR }).error, "invalid_revision");
    assert.strictEqual(store.addMember({ teamId: team.teamId, petId: m1, baseRevision: 0, actor: USER_ACTOR }).error, "invalid_revision");
    assert.strictEqual(store.addMember({ teamId: team.teamId, petId: m1, baseRevision: -1, actor: USER_ACTOR }).error, "invalid_revision");
    assert.strictEqual(store.addMember({ teamId: team.teamId, petId: m1, baseRevision: Number.MAX_SAFE_INTEGER + 10, actor: USER_ACTOR }).error, "invalid_revision");
  });

  it("rejects mismatched baseRevision with conflict and returns currentRevision", () => {
    const { dataDir } = createTestEnvironment();
    const store = createTeamStore({ dataDir });
    const leader = makePetId("leader");
    const m1 = makePetId("m1");

    const createRes = store.createTeam({ name: "OCC Test", leaderPetId: leader, actor: USER_ACTOR });
    assert.strictEqual(createRes.ok, true);
    const teamId = createRes.team.teamId;

    const badAdd = store.addMember({
      teamId,
      petId: m1,
      baseRevision: 99,
      actor: USER_ACTOR,
    });
    assert.strictEqual(badAdd.ok, false);
    assert.strictEqual(badAdd.error, "conflict");
    assert.strictEqual(badAdd.currentRevision, 1);

    const goodAdd = store.addMember({
      teamId,
      petId: m1,
      baseRevision: 1,
      actor: USER_ACTOR,
    });
    assert.strictEqual(goodAdd.ok, true);
    assert.strictEqual(goodAdd.team.revision, 2);
  });
});

describe("Team Store: Same Role No-op & Atomic Leader Transfer", () => {
  it("does not increment revision on same-role no-op in setMemberRole", () => {
    const { dataDir } = createTestEnvironment();
    let clock = 1000;
    const store = createTeamStore({ dataDir, now: () => clock });
    const leader = makePetId("leader");
    const m1 = makePetId("m1");

    const team = store.createTeam({
      name: "No-op Team",
      leaderPetId: leader,
      members: [m1],
      actor: USER_ACTOR,
    }).team;
    assert.strictEqual(team.revision, 1);
    assert.strictEqual(team.updatedAtMs, 1000);

    clock = 2000;
    // Setting role "member" on m1 who is already "member"
    const noOpRes = store.setMemberRole({
      teamId: team.teamId,
      petId: m1,
      role: "member",
      baseRevision: 1,
      actor: USER_ACTOR,
    });

    assert.strictEqual(noOpRes.ok, true);
    assert.strictEqual(noOpRes.team.revision, 1);
    assert.strictEqual(noOpRes.team.updatedAtMs, 1000); // Unchanged

    // Setting role "leader" on current leader is also a no-op
    const leaderNoOp = store.setMemberRole({
      teamId: team.teamId,
      petId: leader,
      role: "leader",
      baseRevision: 1,
      actor: USER_ACTOR,
    });
    assert.strictEqual(leaderNoOp.ok, true);
    assert.strictEqual(leaderNoOp.team.revision, 1);
  });

  it("atomically transfers leadership and increments revision", () => {
    const { dataDir } = createTestEnvironment();
    let clock = 1000;
    const store = createTeamStore({ dataDir, now: () => clock });
    const leader1 = makePetId("leader-1");
    const leader2 = makePetId("leader-2");

    const team = store.createTeam({
      name: "Transfer Team",
      leaderPetId: leader1,
      members: [leader2],
      actor: USER_ACTOR,
    }).team;

    clock = 2000;
    const transferRes = store.setMemberRole({
      teamId: team.teamId,
      petId: leader2,
      role: "leader",
      baseRevision: 1,
      actor: USER_ACTOR,
    });

    assert.strictEqual(transferRes.ok, true);
    const updated = transferRes.team;
    assert.strictEqual(updated.revision, 2);
    assert.strictEqual(updated.updatedAtMs, 2000);
    assert.strictEqual(updated.leaderPetId, leader2);

    const oldLeader = updated.members.find((m) => m.petId === leader1);
    const newLeader = updated.members.find((m) => m.petId === leader2);
    assert.strictEqual(oldLeader.role, "member");
    assert.strictEqual(newLeader.role, "leader");
  });
});

describe("Team Store: Persisted Record Exact-Key Strict Validation & Timestamp Invariants", () => {
  it("rejects persisted team files with extra keys or corrupted member keys", () => {
    const { dataDir } = createTestEnvironment();
    const store = createTeamStore({ dataDir });
    const leader = makePetId("leader");

    const team = store.createTeam({ name: "Strict Team", leaderPetId: leader, actor: USER_ACTOR }).team;
    const teamsDir = path.join(dataDir, "teams");

    // 1. Extra key on team
    const teamExtra = { ...team, teamId: "team_extra_team", extraKey: "hacked" };
    fs.writeFileSync(path.join(teamsDir, "team-team_extra_team.json"), JSON.stringify(teamExtra), "utf8");
    assert.strictEqual(store.getTeam({ teamId: "team_extra_team" }), null);

    // 2. Extra key on member
    const memberExtra = {
      ...team,
      teamId: "team_extra_member",
      members: [{ petId: leader, role: "leader", joinedAtMs: team.createdAtMs, extraMemberKey: 1 }],
    };
    fs.writeFileSync(path.join(teamsDir, "team-team_extra_member.json"), JSON.stringify(memberExtra), "utf8");
    assert.strictEqual(store.getTeam({ teamId: "team_extra_member" }), null);
  });

  it("enforces timestamp invariants: updated >= created, joined >= created and joined <= updated", () => {
    const { dataDir } = createTestEnvironment();
    const store = createTeamStore({ dataDir });
    const leader = makePetId("leader");

    const team = store.createTeam({ name: "Timestamp Team", leaderPetId: leader, actor: USER_ACTOR }).team;
    const teamsDir = path.join(dataDir, "teams");

    // 1. updatedAtMs < createdAtMs
    const badUpdated = { ...team, teamId: "team_bad_updated", createdAtMs: 2000, updatedAtMs: 1000 };
    fs.writeFileSync(path.join(teamsDir, "team-team_bad_updated.json"), JSON.stringify(badUpdated), "utf8");
    assert.strictEqual(store.getTeam({ teamId: "team_bad_updated" }), null);

    // 2. joinedAtMs < createdAtMs
    const badJoinedEarly = {
      ...team,
      teamId: "team_bad_joined_early",
      createdAtMs: 2000,
      updatedAtMs: 2000,
      members: [{ petId: leader, role: "leader", joinedAtMs: 1000 }],
    };
    fs.writeFileSync(path.join(teamsDir, "team-team_bad_joined_early.json"), JSON.stringify(badJoinedEarly), "utf8");
    assert.strictEqual(store.getTeam({ teamId: "team_bad_joined_early" }), null);

    // 3. joinedAtMs > updatedAtMs
    const badJoinedLate = {
      ...team,
      teamId: "team_bad_joined_late",
      createdAtMs: 2000,
      updatedAtMs: 2000,
      members: [{ petId: leader, role: "leader", joinedAtMs: 3000 }],
    };
    fs.writeFileSync(path.join(teamsDir, "team-team_bad_joined_late.json"), JSON.stringify(badJoinedLate), "utf8");
    assert.strictEqual(store.getTeam({ teamId: "team_bad_joined_late" }), null);

    // 4. Negative createdAtMs
    const badNegative = { ...team, teamId: "team_bad_neg", createdAtMs: -5 };
    fs.writeFileSync(path.join(teamsDir, "team-team_bad_neg.json"), JSON.stringify(badNegative), "utf8");
    assert.strictEqual(store.getTeam({ teamId: "team_bad_neg" }), null);
  });
});

describe("Team Store: 8 Members Limit", () => {
  it("rejects creating a team with > 8 members", () => {
    const { dataDir } = createTestEnvironment();
    const store = createTeamStore({ dataDir });

    const leader = makePetId("leader");
    const members = [];
    for (let i = 1; i <= 8; i++) {
      members.push(makePetId(`member-${i}`));
    }
    // leader + 8 members = 9 members
    const result = store.createTeam({
      name: "Too Large Team",
      leaderPetId: leader,
      members,
      actor: USER_ACTOR,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "max_members_exceeded");
  });

  it("allows adding up to 8 members and rejects the 9th member", () => {
    const { dataDir } = createTestEnvironment();
    const store = createTeamStore({ dataDir });

    const leader = makePetId("leader");
    let current = store.createTeam({ name: "Growth Team", leaderPetId: leader, actor: USER_ACTOR }).team;
    assert.strictEqual(current.members.length, 1);

    // Add 7 more members (total 8)
    for (let i = 2; i <= 8; i++) {
      const petId = makePetId(`member-${i}`);
      const addRes = store.addMember({
        teamId: current.teamId,
        petId,
        baseRevision: current.revision,
        actor: USER_ACTOR,
      });
      assert.strictEqual(addRes.ok, true);
      current = addRes.team;
      assert.strictEqual(current.members.length, i);
    }
    assert.strictEqual(current.members.length, 8);

    // 9th member attempt should fail
    const p9 = makePetId("member-9");
    const overflowRes = store.addMember({
      teamId: current.teamId,
      petId: p9,
      baseRevision: current.revision,
      actor: USER_ACTOR,
    });
    assert.strictEqual(overflowRes.ok, false);
    assert.strictEqual(overflowRes.error, "max_members_exceeded");
    assert.strictEqual(overflowRes.currentRevision, 8);

    // Duplicate member check
    const dupRes = store.addMember({
      teamId: current.teamId,
      petId: leader,
      baseRevision: current.revision,
      actor: USER_ACTOR,
    });
    assert.strictEqual(dupRes.ok, false);
    assert.strictEqual(dupRes.error, "already_member");
  });
});

describe("Team Store: Leader Protection", () => {
  it("prevents removing the leader", () => {
    const { dataDir } = createTestEnvironment();
    const store = createTeamStore({ dataDir });
    const leader = makePetId("leader");
    const m1 = makePetId("m1");

    const team = store.createTeam({
      name: "Protection Team",
      leaderPetId: leader,
      members: [m1],
      actor: USER_ACTOR,
    }).team;

    const removeRes = store.removeMember({
      teamId: team.teamId,
      petId: leader,
      baseRevision: team.revision,
      actor: USER_ACTOR,
    });

    assert.strictEqual(removeRes.ok, false);
    assert.strictEqual(removeRes.error, "cannot_remove_leader");
    assert.strictEqual(removeRes.currentRevision, 1);
  });

  it("prevents directly demoting the leader without transferring leadership", () => {
    const { dataDir } = createTestEnvironment();
    const store = createTeamStore({ dataDir });
    const leader = makePetId("leader");

    const team = store.createTeam({
      name: "Demote Test",
      leaderPetId: leader,
      actor: USER_ACTOR,
    }).team;

    const demoteRes = store.setMemberRole({
      teamId: team.teamId,
      petId: leader,
      role: "member",
      baseRevision: team.revision,
      actor: USER_ACTOR,
    });

    assert.strictEqual(demoteRes.ok, false);
    assert.strictEqual(demoteRes.error, "cannot_demote_leader");
  });
});

describe("Team Store: Dissolve Lifecycle", () => {
  it("dissolves a team and prevents further mutations while remaining readable", () => {
    const { dataDir } = createTestEnvironment();
    const store = createTeamStore({ dataDir });
    const leader = makePetId("leader");
    const member = makePetId("member");

    const team = store.createTeam({
      name: "Dissolve Team",
      leaderPetId: leader,
      members: [member],
      actor: USER_ACTOR,
    }).team;

    // Dissolve team
    const dissolveRes = store.dissolveTeam({
      teamId: team.teamId,
      baseRevision: team.revision,
      actor: USER_ACTOR,
    });
    assert.strictEqual(dissolveRes.ok, true);
    assert.strictEqual(dissolveRes.team.status, "dissolved");
    assert.strictEqual(dissolveRes.team.revision, 2);

    // Dissolving again fails
    const reDissolve = store.dissolveTeam({
      teamId: team.teamId,
      baseRevision: 2,
      actor: USER_ACTOR,
    });
    assert.strictEqual(reDissolve.ok, false);
    assert.strictEqual(reDissolve.error, "team_dissolved");

    // addMember on dissolved team fails
    const addRes = store.addMember({
      teamId: team.teamId,
      petId: makePetId("new-p"),
      baseRevision: 2,
      actor: USER_ACTOR,
    });
    assert.strictEqual(addRes.ok, false);
    assert.strictEqual(addRes.error, "team_dissolved");

    // removeMember on dissolved team fails
    const removeRes = store.removeMember({
      teamId: team.teamId,
      petId: member,
      baseRevision: 2,
      actor: USER_ACTOR,
    });
    assert.strictEqual(removeRes.ok, false);
    assert.strictEqual(removeRes.error, "team_dissolved");

    // setMemberRole on dissolved team fails
    const roleRes = store.setMemberRole({
      teamId: team.teamId,
      petId: member,
      role: "observer",
      baseRevision: 2,
      actor: USER_ACTOR,
    });
    assert.strictEqual(roleRes.ok, false);
    assert.strictEqual(roleRes.error, "team_dissolved");

    // Querying dissolved team still works
    const fetched = store.getTeam({ teamId: team.teamId });
    assert.ok(fetched);
    assert.strictEqual(fetched.status, "dissolved");

    // listTeamsForPet still includes dissolved team
    const list = store.listTeamsForPet({ petId: leader });
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].status, "dissolved");
  });
});

describe("Team Store: Bad Files, Corruption & Fail-Closed", () => {
  it("returns null on getTeam and skips corrupted/missing/oversized files in listTeamsForPet", () => {
    const { dataDir } = createTestEnvironment();
    const store = createTeamStore({ dataDir });
    const leader = makePetId("leader");

    const validTeam = store.createTeam({
      name: "Valid Team",
      leaderPetId: leader,
      actor: USER_ACTOR,
    }).team;

    const teamsDir = path.join(dataDir, "teams");

    // 1. Corrupt JSON file
    fs.writeFileSync(path.join(teamsDir, "team-team_corrupt.json"), "{ invalid json", "utf8");
    assert.strictEqual(store.getTeam({ teamId: "team_corrupt" }), null);

    // 2. Oversized file (> 16 KiB)
    const bigData = { ...validTeam, teamId: "team_oversized", padding: "x".repeat(20000) };
    fs.writeFileSync(
      path.join(teamsDir, "team-team_oversized.json"),
      JSON.stringify(bigData),
      "utf8"
    );
    assert.strictEqual(store.getTeam({ teamId: "team_oversized" }), null);

    // 3. Schema invalid file (missing leader, bad revision, etc.)
    const badSchema = { ...validTeam, teamId: "team_badschema", revision: -1 };
    fs.writeFileSync(
      path.join(teamsDir, "team-team_badschema.json"),
      JSON.stringify(badSchema),
      "utf8"
    );
    assert.strictEqual(store.getTeam({ teamId: "team_badschema" }), null);

    // 4. Filename and embedded teamId must match.
    const mismatchedId = { ...validTeam, teamId: "team_embedded_other" };
    fs.writeFileSync(
      path.join(teamsDir, "team-team_filename_mismatch.json"),
      JSON.stringify(mismatchedId),
      "utf8"
    );
    assert.strictEqual(store.getTeam({ teamId: "team_filename_mismatch" }), null);

    // 5. listTeamsForPet safely ignores bad files and returns only validTeam
    const list = store.listTeamsForPet({ petId: leader });
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].teamId, validTeam.teamId);
  });

  it("handles non-existent or uninitialized teams directory gracefully", () => {
    const { dataDir } = createTestEnvironment();
    const nonExistentDir = path.join(dataDir, "does-not-exist");
    const store = createTeamStore({ dataDir: nonExistentDir });

    assert.strictEqual(store.getTeam({ teamId: "team_missing" }), null);
    assert.deepStrictEqual(store.listTeamsForPet({ petId: makePetId("p1") }), []);
  });
});

describe("Team Store: Path Safety & Identifier Validation", () => {
  it("rejects path traversal and malformed identifiers in all methods", () => {
    const { dataDir } = createTestEnvironment();
    const store = createTeamStore({ dataDir });
    const leader = makePetId("leader");

    // Invalid teamId in getTeam
    assert.strictEqual(store.getTeam({ teamId: "../etc/passwd" }), null);
    assert.strictEqual(store.getTeam({ teamId: "team_../../escaped" }), null);
    assert.strictEqual(store.getTeam({ teamId: "not_a_team" }), null);

    // Invalid petId in listTeamsForPet
    assert.deepStrictEqual(store.listTeamsForPet({ petId: "../unsafe" }), []);

    // Invalid teamId in mutations
    const r1 = store.addMember({ teamId: "../team", petId: leader, baseRevision: 1, actor: USER_ACTOR });
    assert.strictEqual(r1.ok, false);
    assert.strictEqual(r1.error, "invalid_team_id");

    const r2 = store.removeMember({ teamId: "team_../bad", petId: leader, baseRevision: 1, actor: USER_ACTOR });
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(r2.error, "invalid_team_id");

    const r3 = store.setMemberRole({ teamId: "bad", petId: leader, role: "member", baseRevision: 1, actor: USER_ACTOR });
    assert.strictEqual(r3.ok, false);
    assert.strictEqual(r3.error, "invalid_team_id");

    const r4 = store.dissolveTeam({ teamId: "../../bad", baseRevision: 1, actor: USER_ACTOR });
    assert.strictEqual(r4.ok, false);
    assert.strictEqual(r4.error, "invalid_team_id");

    // Invalid petId in mutations
    const validTeam = store.createTeam({ name: "Safe Team", leaderPetId: leader, actor: USER_ACTOR }).team;
    const r5 = store.addMember({
      teamId: validTeam.teamId,
      petId: "../traversal",
      baseRevision: 1,
      actor: USER_ACTOR,
    });
    assert.strictEqual(r5.ok, false);
    assert.strictEqual(r5.error, "invalid_pet_id");
  });
});

describe("Team Store: Copy Isolation", () => {
  it("ensures mutating returned team object cannot contaminate internal state or disk", () => {
    const { dataDir } = createTestEnvironment();
    const store = createTeamStore({ dataDir });
    const leader = makePetId("leader");
    const m1 = makePetId("m1");

    const res = store.createTeam({
      name: "Original Name",
      leaderPetId: leader,
      members: [m1],
      actor: USER_ACTOR,
    });
    assert.strictEqual(res.ok, true);
    const returnedTeam = res.team;

    // Mutate returned object
    returnedTeam.name = "Hacked Name";
    returnedTeam.members[0].role = "observer";
    returnedTeam.members.push({ petId: "hacked", role: "leader", joinedAtMs: 0 });

    // Subsequent getTeam must return untampered original state
    const fetched = store.getTeam({ teamId: returnedTeam.teamId });
    assert.strictEqual(fetched.name, "Original Name");
    assert.strictEqual(fetched.members.length, 2);
    assert.strictEqual(fetched.members[0].role, "leader");

    // Mutate getTeam return value
    fetched.members.pop();
    const fetchedAgain = store.getTeam({ teamId: returnedTeam.teamId });
    assert.strictEqual(fetchedAgain.members.length, 2);

    // Mutate listTeamsForPet return value
    const list = store.listTeamsForPet({ petId: leader });
    list[0].name = "Mutated In List";
    const freshFetch = store.getTeam({ teamId: returnedTeam.teamId });
    assert.strictEqual(freshFetch.name, "Original Name");
  });
});

describe("Team Store: Atomic Persistence & No Temp File Residue", () => {
  it("leaves zero .tmp files in teams directory across creation and updates", () => {
    const { dataDir } = createTestEnvironment();
    const store = createTeamStore({ dataDir });
    const leader = makePetId("leader");
    const m1 = makePetId("m1");
    const m2 = makePetId("m2");

    const team = store.createTeam({ name: "Atomic Team", leaderPetId: leader, actor: USER_ACTOR }).team;
    const add1 = store.addMember({ teamId: team.teamId, petId: m1, baseRevision: 1, actor: USER_ACTOR }).team;
    const add2 = store.addMember({ teamId: team.teamId, petId: m2, baseRevision: 2, actor: USER_ACTOR }).team;
    const role = store.setMemberRole({ teamId: team.teamId, petId: m2, role: "observer", baseRevision: 3, actor: USER_ACTOR }).team;
    const rem = store.removeMember({ teamId: team.teamId, petId: m1, baseRevision: 4, actor: USER_ACTOR }).team;
    store.dissolveTeam({ teamId: team.teamId, baseRevision: 5, actor: USER_ACTOR });

    const teamsDir = path.join(dataDir, "teams");
    const files = fs.readdirSync(teamsDir);

    // Must only have the 1 JSON file, 0 .tmp files
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0], `team-${team.teamId}.json`);
    const tmpFiles = files.filter((f) => f.includes(".tmp"));
    assert.strictEqual(tmpFiles.length, 0);
  });
});

describe("Team Store: Custom Injected Clock & Random Bytes", () => {
  it("uses custom now function and randomBytes generator when provided", () => {
    const { dataDir } = createTestEnvironment();
    const clock = 555555;
    const customRandom = () => Buffer.from("0123456789abcdef01234567", "hex");

    const store = createTeamStore({
      dataDir,
      now: () => clock,
      randomBytes: customRandom,
    });

    const leader = makePetId("leader");
    const res = store.createTeam({
      name: "Custom Generator Team",
      leaderPetId: leader,
      actor: USER_ACTOR,
    });

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.team.teamId, "team_0123456789abcdef01234567");
    assert.strictEqual(res.team.createdAtMs, 555555);
    assert.strictEqual(res.team.updatedAtMs, 555555);
  });

  it("keeps updatedAtMs monotonic when the wall clock moves backwards", () => {
    const { dataDir } = createTestEnvironment();
    let clock = 2000;
    const store = createTeamStore({ dataDir, now: () => clock });
    const leader = makePetId("leader-clock");
    const member = makePetId("member-clock");

    const created = store.createTeam({
      name: "Clock Team",
      leaderPetId: leader,
      actor: USER_ACTOR,
    }).team;
    assert.strictEqual(created.updatedAtMs, 2000);

    clock = 1000;
    const added = store.addMember({
      teamId: created.teamId,
      petId: member,
      baseRevision: created.revision,
      actor: USER_ACTOR,
    });

    assert.strictEqual(added.ok, true);
    assert.strictEqual(added.team.updatedAtMs, 2000);
    assert.strictEqual(added.team.members.find((entry) => entry.petId === member).joinedAtMs, 2000);
    assert.deepStrictEqual(store.getTeam({ teamId: created.teamId }), added.team);
  });
});
