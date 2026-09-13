"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  MAX_BOARD_MARKDOWN_BYTES,
  createTeamStore,
  createTeamBoardStore,
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pet-test-boards-"));
  temporaryDirs.push(dataDir);
  return { dataDir };
}

function makePetId(name) {
  return derivePetId({ profileId: "local", agentId: "pi", rawSessionId: name });
}

function setupTestTeam(teamStore, leaderPetId, extraMembers = []) {
  const members = [{ petId: leaderPetId, role: "leader" }, ...extraMembers];
  const createRes = teamStore.createTeam({
    name: "Engineering Core",
    leaderPetId,
    members,
    actor: USER_ACTOR,
  });
  assert.strictEqual(createRes.ok, true);
  return createRes.team;
}

describe("Team Board Store: Factory and Constants", () => {
  it("exports MAX_BOARD_MARKDOWN_BYTES and createTeamBoardStore factory", () => {
    assert.strictEqual(MAX_BOARD_MARKDOWN_BYTES, 8192);
    assert.strictEqual(typeof createTeamBoardStore, "function");
  });

  it("instantiates store with default teamStore when only dataDir is provided", () => {
    const { dataDir } = createTestEnvironment();
    const boardStore = createTeamBoardStore({ dataDir });
    assert.strictEqual(typeof boardStore.readBoard, "function");
    assert.strictEqual(typeof boardStore.writeBoard, "function");
  });

  it("uses custom injected teamStore, dataDir, fsApi, and now", () => {
    const { dataDir } = createTestEnvironment();
    let clockTime = 500000;
    const teamStore = createTeamStore({ dataDir, now: () => clockTime });
    const boardStore = createTeamBoardStore({
      teamStore,
      dataDir,
      now: () => clockTime,
    });

    const leader = makePetId("leader");
    const team = setupTestTeam(teamStore, leader);

    const writeRes = boardStore.writeBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: leader },
      baseRevision: 0,
      markdown: "# Hello World",
    });

    assert.strictEqual(writeRes.ok, true);
    assert.strictEqual(writeRes.board.updatedAtMs, 500000);
  });
});

describe("Team Board Store: Success Flows (Creation, Update, Query)", () => {
  it("absent valid board returns synthetic revision 0 empty markdown with null updated fields", () => {
    const { dataDir } = createTestEnvironment();
    const teamStore = createTeamStore({ dataDir });
    const boardStore = createTeamBoardStore({ teamStore, dataDir });

    const leader = makePetId("leader");
    const team = setupTestTeam(teamStore, leader);

    const res = boardStore.readBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: leader },
    });

    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.board, {
      schemaVersion: "1",
      teamId: team.teamId,
      revision: 0,
      markdown: "",
      updatedAtMs: null,
      updatedByPetId: null,
    });
  });

  it("first write with baseRevision 0 creates persisted board with revision 1, atomic file, and updated fields", () => {
    const { dataDir } = createTestEnvironment();
    const mockNow = 1700000000000;
    const teamStore = createTeamStore({ dataDir, now: () => mockNow });
    const boardStore = createTeamBoardStore({ teamStore, dataDir, now: () => mockNow });

    const leader = makePetId("leader");
    const team = setupTestTeam(teamStore, leader);

    const writeRes = boardStore.writeBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: leader },
      baseRevision: 0,
      markdown: "# Project Roadmap\n\n- Task 1\n- Task 2\r\n- Task 3\t(done)",
    });

    assert.strictEqual(writeRes.ok, true);
    assert.deepStrictEqual(writeRes.board, {
      schemaVersion: "1",
      teamId: team.teamId,
      revision: 1,
      markdown: "# Project Roadmap\n\n- Task 1\n- Task 2\r\n- Task 3\t(done)",
      updatedAtMs: 1700000000000,
      updatedByPetId: leader,
    });

    // Check file on disk
    const filePath = path.join(dataDir, "teams", `board-${team.teamId}.json`);
    assert.strictEqual(fs.existsSync(filePath), true);
    const diskRecord = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.deepStrictEqual(diskRecord, writeRes.board);

    // Read back via readBoard
    const readRes = boardStore.readBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: leader },
    });
    assert.strictEqual(readRes.ok, true);
    assert.deepStrictEqual(readRes.board, writeRes.board);
  });

  it("second write with baseRevision 1 increments to revision 2 and updates content", () => {
    const { dataDir } = createTestEnvironment();
    let clock = 1000;
    const teamStore = createTeamStore({ dataDir, now: () => clock });
    const boardStore = createTeamBoardStore({ teamStore, dataDir, now: () => clock });

    const leader = makePetId("leader");
    const member1 = makePetId("member1");
    const team = setupTestTeam(teamStore, leader, [{ petId: member1, role: "member" }]);

    // Write 1 (by leader)
    clock = 2000;
    const w1 = boardStore.writeBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: leader },
      baseRevision: 0,
      markdown: "Initial draft",
    });
    assert.strictEqual(w1.ok, true);
    assert.strictEqual(w1.board.revision, 1);
    assert.strictEqual(w1.board.updatedByPetId, leader);
    assert.strictEqual(w1.board.updatedAtMs, 2000);

    // Write 2 (by member1)
    clock = 3000;
    const w2 = boardStore.writeBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: member1 },
      baseRevision: 1,
      markdown: "Updated draft with more details",
    });
    assert.strictEqual(w2.ok, true);
    assert.strictEqual(w2.board.revision, 2);
    assert.strictEqual(w2.board.markdown, "Updated draft with more details");
    assert.strictEqual(w2.board.updatedByPetId, member1);
    assert.strictEqual(w2.board.updatedAtMs, 3000);

    // Read back
    const readRes = boardStore.readBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: leader },
    });
    assert.strictEqual(readRes.ok, true);
    assert.strictEqual(readRes.board.revision, 2);
    assert.strictEqual(readRes.board.markdown, "Updated draft with more details");
  });

  it("allows writing empty string as markdown", () => {
    const { dataDir } = createTestEnvironment();
    const teamStore = createTeamStore({ dataDir });
    const boardStore = createTeamBoardStore({ teamStore, dataDir });

    const leader = makePetId("leader");
    const team = setupTestTeam(teamStore, leader);

    const writeRes = boardStore.writeBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: leader },
      baseRevision: 0,
      markdown: "",
    });

    assert.strictEqual(writeRes.ok, true);
    assert.strictEqual(writeRes.board.revision, 1);
    assert.strictEqual(writeRes.board.markdown, "");
  });
});

describe("Team Board Store: Membership and Role Authorization", () => {
  it("allows leader to read and write", () => {
    const { dataDir } = createTestEnvironment();
    const teamStore = createTeamStore({ dataDir });
    const boardStore = createTeamBoardStore({ teamStore, dataDir });

    const leader = makePetId("leader");
    const team = setupTestTeam(teamStore, leader);

    const w = boardStore.writeBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: leader },
      baseRevision: 0,
      markdown: "Leader write",
    });
    assert.strictEqual(w.ok, true);

    const r = boardStore.readBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: leader },
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.board.markdown, "Leader write");
  });

  it("allows regular member to read and write", () => {
    const { dataDir } = createTestEnvironment();
    const teamStore = createTeamStore({ dataDir });
    const boardStore = createTeamBoardStore({ teamStore, dataDir });

    const leader = makePetId("leader");
    const member = makePetId("member");
    const team = setupTestTeam(teamStore, leader, [{ petId: member, role: "member" }]);

    const w = boardStore.writeBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: member },
      baseRevision: 0,
      markdown: "Member write",
    });
    assert.strictEqual(w.ok, true);

    const r = boardStore.readBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: member },
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.board.markdown, "Member write");
  });

  it("allows observer role to read board, both absent and persisted", () => {
    const { dataDir } = createTestEnvironment();
    const teamStore = createTeamStore({ dataDir });
    const boardStore = createTeamBoardStore({ teamStore, dataDir });

    const leader = makePetId("leader");
    const observer = makePetId("observer");
    const team = setupTestTeam(teamStore, leader, [{ petId: observer, role: "observer" }]);

    // Read absent board
    const r1 = boardStore.readBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: observer },
    });
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.board.revision, 0);

    // Leader writes
    boardStore.writeBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: leader },
      baseRevision: 0,
      markdown: "Observer can read this",
    });

    // Observer reads persisted board
    const r2 = boardStore.readBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: observer },
    });
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.board.revision, 1);
    assert.strictEqual(r2.board.markdown, "Observer can read this");
  });

  it("rejects observer role from writing to board", () => {
    const { dataDir } = createTestEnvironment();
    const teamStore = createTeamStore({ dataDir });
    const boardStore = createTeamBoardStore({ teamStore, dataDir });

    const leader = makePetId("leader");
    const observer = makePetId("observer");
    const team = setupTestTeam(teamStore, leader, [{ petId: observer, role: "observer" }]);

    const w = boardStore.writeBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: observer },
      baseRevision: 0,
      markdown: "Observer illegal write",
    });

    assert.strictEqual(w.ok, false);
    assert.strictEqual(w.error, "forbidden");
    assert.match(w.reason, /Observer members cannot write/i);
  });

  it("rejects non-member pet from reading or writing", () => {
    const { dataDir } = createTestEnvironment();
    const teamStore = createTeamStore({ dataDir });
    const boardStore = createTeamBoardStore({ teamStore, dataDir });

    const leader = makePetId("leader");
    const outsider = makePetId("outsider");
    const team = setupTestTeam(teamStore, leader);

    const r = boardStore.readBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: outsider },
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, "forbidden");
    assert.match(r.reason, /not an active member/i);

    const w = boardStore.writeBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: outsider },
      baseRevision: 0,
      markdown: "Outsider illegal write",
    });
    assert.strictEqual(w.ok, false);
    assert.strictEqual(w.error, "forbidden");
    assert.match(w.reason, /not an active member/i);
  });

  it("rejects read and write when team does not exist", () => {
    const { dataDir } = createTestEnvironment();
    const boardStore = createTeamBoardStore({ dataDir });
    const leader = makePetId("leader");

    const r = boardStore.readBoard({
      teamId: "team_nonexistent123",
      actor: { kind: "member", petId: leader },
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, "team_not_found");

    const w = boardStore.writeBoard({
      teamId: "team_nonexistent123",
      actor: { kind: "member", petId: leader },
      baseRevision: 0,
      markdown: "hello",
    });
    assert.strictEqual(w.ok, false);
    assert.strictEqual(w.error, "team_not_found");
  });

  it("rejects read and write when team is dissolved", () => {
    const { dataDir } = createTestEnvironment();
    const teamStore = createTeamStore({ dataDir });
    const boardStore = createTeamBoardStore({ teamStore, dataDir });

    const leader = makePetId("leader");
    const team = setupTestTeam(teamStore, leader);

    // Dissolve team
    const disRes = teamStore.dissolveTeam({
      teamId: team.teamId,
      baseRevision: team.revision,
      actor: USER_ACTOR,
    });
    assert.strictEqual(disRes.ok, true);

    const r = boardStore.readBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: leader },
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, "team_not_active");

    const w = boardStore.writeBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: leader },
      baseRevision: 0,
      markdown: "hello",
    });
    assert.strictEqual(w.ok, false);
    assert.strictEqual(w.error, "team_not_active");
  });

  it("strictly validates actor shape and rejects malformed actors", () => {
    const { dataDir } = createTestEnvironment();
    const teamStore = createTeamStore({ dataDir });
    const boardStore = createTeamBoardStore({ teamStore, dataDir });

    const leader = makePetId("leader");
    const team = setupTestTeam(teamStore, leader);

    // Missing actor
    assert.strictEqual(boardStore.readBoard({ teamId: team.teamId, actor: null }).ok, false);
    assert.strictEqual(boardStore.writeBoard({ teamId: team.teamId, actor: null, baseRevision: 0, markdown: "" }).ok, false);

    // User actor instead of member actor
    assert.strictEqual(boardStore.readBoard({ teamId: team.teamId, actor: { kind: "user" } }).ok, false);
    assert.strictEqual(boardStore.writeBoard({ teamId: team.teamId, actor: { kind: "user" }, baseRevision: 0, markdown: "" }).ok, false);

    // Unsafe petId in actor
    assert.strictEqual(boardStore.readBoard({ teamId: team.teamId, actor: { kind: "member", petId: "../unsafe" } }).ok, false);
    assert.strictEqual(boardStore.writeBoard({ teamId: team.teamId, actor: { kind: "member", petId: "../unsafe" }, baseRevision: 0, markdown: "" }).ok, false);

    // Extra keys in actor
    assert.strictEqual(boardStore.readBoard({ teamId: team.teamId, actor: { kind: "member", petId: leader, role: "admin" } }).ok, false);
    assert.strictEqual(boardStore.writeBoard({ teamId: team.teamId, actor: { kind: "member", petId: leader, extra: 1 }, baseRevision: 0, markdown: "" }).ok, false);
  });
});

describe("Team Board Store: OCC and Conflict Handling", () => {
  it("rejects non-zero baseRevision when board does not exist on disk", () => {
    const { dataDir } = createTestEnvironment();
    const teamStore = createTeamStore({ dataDir });
    const boardStore = createTeamBoardStore({ teamStore, dataDir });

    const leader = makePetId("leader");
    const team = setupTestTeam(teamStore, leader);

    const res = boardStore.writeBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: leader },
      baseRevision: 1, // Expected 0 since board does not exist
      markdown: "conflict test",
    });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "conflict");
    assert.strictEqual(res.currentRevision, 0);
    assert.match(res.reason, /expected 0, got 1/i);
  });

  it("rejects baseRevision 0 when board already exists at revision 1", () => {
    const { dataDir } = createTestEnvironment();
    const teamStore = createTeamStore({ dataDir });
    const boardStore = createTeamBoardStore({ teamStore, dataDir });

    const leader = makePetId("leader");
    const team = setupTestTeam(teamStore, leader);

    boardStore.writeBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: leader },
      baseRevision: 0,
      markdown: "v1",
    });

    const res = boardStore.writeBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: leader },
      baseRevision: 0, // Stale baseRevision
      markdown: "v2 stale",
    });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "conflict");
    assert.strictEqual(res.currentRevision, 1);
    assert.match(res.reason, /expected 1, got 0/i);
  });

  it("rejects stale baseRevision 1 when board has progressed to revision 2", () => {
    const { dataDir } = createTestEnvironment();
    const teamStore = createTeamStore({ dataDir });
    const boardStore = createTeamBoardStore({ teamStore, dataDir });

    const leader = makePetId("leader");
    const member = makePetId("member");
    const team = setupTestTeam(teamStore, leader, [{ petId: member, role: "member" }]);

    boardStore.writeBoard({ teamId: team.teamId, actor: { kind: "member", petId: leader }, baseRevision: 0, markdown: "v1" });
    boardStore.writeBoard({ teamId: team.teamId, actor: { kind: "member", petId: member }, baseRevision: 1, markdown: "v2" });

    const res = boardStore.writeBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: leader },
      baseRevision: 1,
      markdown: "stale v1 rewrite",
    });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "conflict");
    assert.strictEqual(res.currentRevision, 2);
  });

  it("rejects invalid non-safe-integer baseRevision", () => {
    const { dataDir } = createTestEnvironment();
    const teamStore = createTeamStore({ dataDir });
    const boardStore = createTeamBoardStore({ teamStore, dataDir });

    const leader = makePetId("leader");
    const team = setupTestTeam(teamStore, leader);

    for (const badRev of [-1, 1.5, "0", null, undefined, NaN, Infinity]) {
      const res = boardStore.writeBoard({
        teamId: team.teamId,
        actor: { kind: "member", petId: leader },
        baseRevision: badRev,
        markdown: "test",
      });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.error, "invalid_revision");
    }
  });
});

describe("Team Board Store: Unicode Byte Limit & Control Characters", () => {
  it("accepts markdown up to exactly 8192 UTF-8 bytes", () => {
    const { dataDir } = createTestEnvironment();
    const teamStore = createTeamStore({ dataDir });
    const boardStore = createTeamBoardStore({ teamStore, dataDir });

    const leader = makePetId("leader");
    const team = setupTestTeam(teamStore, leader);

    const exact8192 = "a".repeat(8192);
    assert.strictEqual(Buffer.byteLength(exact8192, "utf8"), 8192);

    const res = boardStore.writeBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: leader },
      baseRevision: 0,
      markdown: exact8192,
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.board.markdown.length, 8192);
  });

  it("handles multi-byte UTF-8 characters (CJK, Emojis, Accented chars) within byte limit", () => {
    const { dataDir } = createTestEnvironment();
    const teamStore = createTeamStore({ dataDir });
    const boardStore = createTeamBoardStore({ teamStore, dataDir });

    const leader = makePetId("leader");
    const team = setupTestTeam(teamStore, leader);

    const richText = "# 🐱 Pi Pet 团队白板 🚀\n\n- 任务 1: 验证多字节 Unicode (한국어, 日本語, Español, Français)\n- 🐶 状态: 活跃\n- 🎉 庆祝!";
    const res = boardStore.writeBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: leader },
      baseRevision: 0,
      markdown: richText,
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.board.markdown, richText);

    const read = boardStore.readBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: leader },
    });
    assert.strictEqual(read.ok, true);
    assert.strictEqual(read.board.markdown, richText);
  });

  it("rejects markdown exceeding 8192 UTF-8 bytes with markdown_too_large", () => {
    const { dataDir } = createTestEnvironment();
    const teamStore = createTeamStore({ dataDir });
    const boardStore = createTeamBoardStore({ teamStore, dataDir });

    const leader = makePetId("leader");
    const team = setupTestTeam(teamStore, leader);

    const oversized = "a".repeat(8193);
    assert.strictEqual(Buffer.byteLength(oversized, "utf8"), 8193);

    const res = boardStore.writeBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: leader },
      baseRevision: 0,
      markdown: oversized,
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "markdown_too_large");
  });

  it("allows newline (\\n), carriage return (\\r), and tab (\\t)", () => {
    const { dataDir } = createTestEnvironment();
    const teamStore = createTeamStore({ dataDir });
    const boardStore = createTeamBoardStore({ teamStore, dataDir });

    const leader = makePetId("leader");
    const team = setupTestTeam(teamStore, leader);

    const allowedControlsText = "Line 1\r\nLine 2\n\tIndented with tab\r\n\t- Item 1\n";
    const res = boardStore.writeBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: leader },
      baseRevision: 0,
      markdown: allowedControlsText,
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.board.markdown, allowedControlsText);
  });

  it("rejects disallowed C0 control characters", () => {
    const { dataDir } = createTestEnvironment();
    const teamStore = createTeamStore({ dataDir });
    const boardStore = createTeamBoardStore({ teamStore, dataDir });

    const leader = makePetId("leader");
    const team = setupTestTeam(teamStore, leader);

    const c0Disallowed = [
      "\x00", // null
      "\x01", // start of heading
      "\x07", // bell
      "\x08", // backspace
      "\x0b", // vertical tab
      "\x0c", // form feed
      "\x1b", // escape
      "\x7f", // delete
    ];

    for (const char of c0Disallowed) {
      const res = boardStore.writeBoard({
        teamId: team.teamId,
        actor: { kind: "member", petId: leader },
        baseRevision: 0,
        markdown: `Bad char: [${char}]`,
      });
      assert.strictEqual(res.ok, false, `Char 0x${char.charCodeAt(0).toString(16)} should be rejected`);
      assert.strictEqual(res.error, "invalid_markdown");
    }
  });

  it("rejects disallowed C1 control characters (0x80 to 0x9F)", () => {
    const { dataDir } = createTestEnvironment();
    const teamStore = createTeamStore({ dataDir });
    const boardStore = createTeamBoardStore({ teamStore, dataDir });

    const leader = makePetId("leader");
    const team = setupTestTeam(teamStore, leader);

    for (const code of [0x80, 0x8f, 0x90, 0x9f]) {
      const char = String.fromCharCode(code);
      const res = boardStore.writeBoard({
        teamId: team.teamId,
        actor: { kind: "member", petId: leader },
        baseRevision: 0,
        markdown: `C1 char: ${char}`,
      });
      assert.strictEqual(res.ok, false, `C1 char 0x${code.toString(16)} should be rejected`);
      assert.strictEqual(res.error, "invalid_markdown");
    }
  });

  it("rejects non-string markdown parameter", () => {
    const { dataDir } = createTestEnvironment();
    const teamStore = createTeamStore({ dataDir });
    const boardStore = createTeamBoardStore({ teamStore, dataDir });

    const leader = makePetId("leader");
    const team = setupTestTeam(teamStore, leader);

    for (const badMd of [123, true, null, undefined, {}, []]) {
      const res = boardStore.writeBoard({
        teamId: team.teamId,
        actor: { kind: "member", petId: leader },
        baseRevision: 0,
        markdown: badMd,
      });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.error, "invalid_markdown");
    }
  });
});

describe("Team Board Store: Corruption and Fail-Closed Behavior", () => {
  it("fails closed on syntactically corrupt JSON file without returning synthetic revision 0", () => {
    const { dataDir } = createTestEnvironment();
    const teamStore = createTeamStore({ dataDir });
    const boardStore = createTeamBoardStore({ teamStore, dataDir });

    const leader = makePetId("leader");
    const team = setupTestTeam(teamStore, leader);

    // Corrupt the board file
    const filePath = path.join(dataDir, "teams", `board-${team.teamId}.json`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{ invalid json content ...", "utf8");

    const r = boardStore.readBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: leader },
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, "corrupt_board");

    const w = boardStore.writeBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: leader },
      baseRevision: 0,
      markdown: "overwrite corrupt?",
    });
    assert.strictEqual(w.ok, false);
    assert.strictEqual(w.error, "corrupt_board");
  });

  it("fails closed when persisted board has missing required fields", () => {
    const { dataDir } = createTestEnvironment();
    const teamStore = createTeamStore({ dataDir });
    const boardStore = createTeamBoardStore({ teamStore, dataDir });

    const leader = makePetId("leader");
    const team = setupTestTeam(teamStore, leader);

    const filePath = path.join(dataDir, "teams", `board-${team.teamId}.json`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    // Missing updatedByPetId
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: "1",
        teamId: team.teamId,
        revision: 1,
        markdown: "Hello",
        updatedAtMs: 1000,
      }),
      "utf8"
    );

    const r = boardStore.readBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: leader },
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, "corrupt_board");
  });

  it("fails closed when persisted board has unexpected extra fields", () => {
    const { dataDir } = createTestEnvironment();
    const teamStore = createTeamStore({ dataDir });
    const boardStore = createTeamBoardStore({ teamStore, dataDir });

    const leader = makePetId("leader");
    const team = setupTestTeam(teamStore, leader);

    const filePath = path.join(dataDir, "teams", `board-${team.teamId}.json`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    fs.writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: "1",
        teamId: team.teamId,
        revision: 1,
        markdown: "Hello",
        updatedAtMs: 1000,
        updatedByPetId: leader,
        injectedPayload: "dangerous",
      }),
      "utf8"
    );

    const r = boardStore.readBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: leader },
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, "corrupt_board");
  });

  it("fails closed when persisted teamId inside file does not match teamId or filename", () => {
    const { dataDir } = createTestEnvironment();
    const teamStore = createTeamStore({ dataDir });
    const boardStore = createTeamBoardStore({ teamStore, dataDir });

    const leader = makePetId("leader");
    const team = setupTestTeam(teamStore, leader);

    const filePath = path.join(dataDir, "teams", `board-${team.teamId}.json`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    fs.writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: "1",
        teamId: "team_different_id_here",
        revision: 1,
        markdown: "Hello",
        updatedAtMs: 1000,
        updatedByPetId: leader,
      }),
      "utf8"
    );

    const r = boardStore.readBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: leader },
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, "corrupt_board");
  });

  it("fails closed when persisted revision is 0 on disk", () => {
    const { dataDir } = createTestEnvironment();
    const teamStore = createTeamStore({ dataDir });
    const boardStore = createTeamBoardStore({ teamStore, dataDir });

    const leader = makePetId("leader");
    const team = setupTestTeam(teamStore, leader);

    const filePath = path.join(dataDir, "teams", `board-${team.teamId}.json`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    // On-disk revision must be >= 1
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: "1",
        teamId: team.teamId,
        revision: 0,
        markdown: "Hello",
        updatedAtMs: 1000,
        updatedByPetId: leader,
      }),
      "utf8"
    );

    const r = boardStore.readBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: leader },
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, "corrupt_board");
  });

  it("fails closed when file size exceeds MAX_ENVELOPE_SIZE", () => {
    const { dataDir } = createTestEnvironment();
    const teamStore = createTeamStore({ dataDir });
    const boardStore = createTeamBoardStore({ teamStore, dataDir });

    const leader = makePetId("leader");
    const team = setupTestTeam(teamStore, leader);

    const filePath = path.join(dataDir, "teams", `board-${team.teamId}.json`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    // Huge file
    const hugeContent = " ".repeat(20000);
    fs.writeFileSync(filePath, hugeContent, "utf8");

    const r = boardStore.readBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: leader },
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, "corrupt_board");
  });
});

describe("Team Board Store: Copy Isolation", () => {
  it("mutating returned board from readBoard does not affect internal state or subsequent reads", () => {
    const { dataDir } = createTestEnvironment();
    const teamStore = createTeamStore({ dataDir });
    const boardStore = createTeamBoardStore({ teamStore, dataDir });

    const leader = makePetId("leader");
    const team = setupTestTeam(teamStore, leader);

    // Initial synthetic read
    const r1 = boardStore.readBoard({ teamId: team.teamId, actor: { kind: "member", petId: leader } });
    r1.board.markdown = "tampered";
    r1.board.revision = 999;

    const r2 = boardStore.readBoard({ teamId: team.teamId, actor: { kind: "member", petId: leader } });
    assert.strictEqual(r2.board.markdown, "");
    assert.strictEqual(r2.board.revision, 0);

    // Persisted read
    boardStore.writeBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: leader },
      baseRevision: 0,
      markdown: "Original markdown",
    });

    const r3 = boardStore.readBoard({ teamId: team.teamId, actor: { kind: "member", petId: leader } });
    r3.board.markdown = "mutated locally";

    const r4 = boardStore.readBoard({ teamId: team.teamId, actor: { kind: "member", petId: leader } });
    assert.strictEqual(r4.board.markdown, "Original markdown");
  });

  it("mutating returned board from writeBoard does not affect on-disk state", () => {
    const { dataDir } = createTestEnvironment();
    const teamStore = createTeamStore({ dataDir });
    const boardStore = createTeamBoardStore({ teamStore, dataDir });

    const leader = makePetId("leader");
    const team = setupTestTeam(teamStore, leader);

    const w1 = boardStore.writeBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: leader },
      baseRevision: 0,
      markdown: "Original write",
    });

    w1.board.markdown = "tampered write result";

    const r = boardStore.readBoard({ teamId: team.teamId, actor: { kind: "member", petId: leader } });
    assert.strictEqual(r.board.markdown, "Original write");
  });
});

describe("Team Board Store: Clock, Path, and Options Safety", () => {
  it("keeps updatedAtMs monotonic when wall clock moves backwards", () => {
    const { dataDir } = createTestEnvironment();
    let clock = 5000;
    const teamStore = createTeamStore({ dataDir, now: () => clock });
    const boardStore = createTeamBoardStore({ teamStore, dataDir, now: () => clock });

    const leader = makePetId("leader");
    const team = setupTestTeam(teamStore, leader);

    // Write at clock 5000
    const w1 = boardStore.writeBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: leader },
      baseRevision: 0,
      markdown: "v1",
    });
    assert.strictEqual(w1.board.updatedAtMs, 5000);

    // Wall clock steps backwards to 3000
    clock = 3000;
    const w2 = boardStore.writeBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: leader },
      baseRevision: 1,
      markdown: "v2",
    });
    assert.strictEqual(w2.ok, true);
    // updatedAtMs must remain monotonic (floor is previous updatedAtMs: 5000)
    assert.strictEqual(w2.board.updatedAtMs, 5000);
  });

  it("fails with invalid_clock if clock returns negative or invalid number", () => {
    const { dataDir } = createTestEnvironment();
    let clock = 1000;
    const teamStore = createTeamStore({ dataDir, now: () => clock });
    const boardStore = createTeamBoardStore({ teamStore, dataDir, now: () => clock });

    const leader = makePetId("leader");
    const team = setupTestTeam(teamStore, leader);

    clock = -1;
    const w = boardStore.writeBoard({
      teamId: team.teamId,
      actor: { kind: "member", petId: leader },
      baseRevision: 0,
      markdown: "v1",
    });
    assert.strictEqual(w.ok, false);
    assert.strictEqual(w.error, "invalid_clock");
  });

  it("rejects path traversal and invalid identifiers in teamId", () => {
    const { dataDir } = createTestEnvironment();
    const boardStore = createTeamBoardStore({ dataDir });
    const leader = makePetId("leader");

    const invalidIds = [
      "../etc/passwd",
      "team_../secret",
      "team_foo/bar",
      "team_foo\\bar",
      "",
      null,
      123,
      "team_$",
    ];

    for (const teamId of invalidIds) {
      const r = boardStore.readBoard({ teamId, actor: { kind: "member", petId: leader } });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.error, "invalid_team_id");

      const w = boardStore.writeBoard({ teamId, actor: { kind: "member", petId: leader }, baseRevision: 0, markdown: "" });
      assert.strictEqual(w.ok, false);
      assert.strictEqual(w.error, "invalid_team_id");
    }
  });

  it("rejects unknown option keys and non-plain-object calls", () => {
    const { dataDir } = createTestEnvironment();
    const teamStore = createTeamStore({ dataDir });
    const boardStore = createTeamBoardStore({ teamStore, dataDir });

    const leader = makePetId("leader");
    const team = setupTestTeam(teamStore, leader);

    // Extra keys
    assert.strictEqual(
      boardStore.readBoard({ teamId: team.teamId, actor: { kind: "member", petId: leader }, extraKey: "disallowed" }).ok,
      false
    );
    assert.strictEqual(
      boardStore.writeBoard({
        teamId: team.teamId,
        actor: { kind: "member", petId: leader },
        baseRevision: 0,
        markdown: "",
        extraKey: "disallowed",
      }).ok,
      false
    );

    // Non-plain-object / invalid argument count
    assert.strictEqual(boardStore.readBoard(null).ok, false);
    assert.strictEqual(boardStore.readBoard("team_123").ok, false);
    assert.strictEqual(boardStore.writeBoard(null).ok, false);
  });

  it("leaves zero .tmp file residue across writes", () => {
    const { dataDir } = createTestEnvironment();
    const teamStore = createTeamStore({ dataDir });
    const boardStore = createTeamBoardStore({ teamStore, dataDir });

    const leader = makePetId("leader");
    const team = setupTestTeam(teamStore, leader);

    for (let i = 0; i < 5; i++) {
      const w = boardStore.writeBoard({
        teamId: team.teamId,
        actor: { kind: "member", petId: leader },
        baseRevision: i,
        markdown: `Revision ${i + 1}`,
      });
      assert.strictEqual(w.ok, true);
    }

    const teamsDir = path.join(dataDir, "teams");
    const files = fs.readdirSync(teamsDir);
    const tmpFiles = files.filter((f) => f.includes(".tmp"));
    assert.strictEqual(tmpFiles.length, 0);
  });
});
