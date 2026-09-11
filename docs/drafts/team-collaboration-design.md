# Team Collaboration and Shared Board (Draft)

> Status: design draft, not implemented. The canonical execution order remains [PLAN.md](../../PLAN.md).
>
> Product rule: **Team is a durable relationship; Huddle is a temporary spatial arrangement; Board is shared memory.**

## 1. Purpose

A Pi Pet Team connects existing live agent sessions without becoming an agent runtime or task orchestrator. Team members can:

- identify each other through opaque, authorized handles;
- exchange bounded, attributable messages;
- share a structured plan / note space;
- adopt bounded roles such as leader, member or observer, plus optional display labels;
- request semantic desktop arrangements such as huddle or celebrate.

Pi Pet does not spawn, kill or own these sessions. Removing a member from a Team never terminates its harness process.

## 2. Ownership and hosting

The neutral Team and Board contracts belong to Pi Pet. The first coordinator implementation may be hosted by Clawd because Clawd already owns the authorized session directory, Remote SSH identities and cross-machine routing.

```text
packages/team-runtime/       schema, ACL, mutations, receipts, persistence
Clawd integration adapter    host process, session resolution, Remote SSH routing
Pi extension                 agent-facing tools and target-session inbox
Tauri renderer               Team UI, Board view, bubbles and spatial presentation
```

No public HTTP/WebSocket port is added. Local calls use the existing loopback trust boundary; remote calls reuse Clawd Secure Remote SSH transport.

The coordinator stores canonical Team/Board state. Remote agents do not edit a shared filesystem and Board is not a repo synchronization system.

## 3. Identity model

The coordinator resolves all identity. Agent-facing tools never receive or submit raw harness session IDs.

- `petId`: canonical Pi Pet identity, internal to trusted adapters.
- `memberHandle`: short-lived opaque handle returned for an authorized Team/catalog view.
- `teamId`: stable portable identifier, not chosen by an Agent.
- `messageId` / `mutationId`: adapter-generated identifiers used for dedup and receipts.

A handle is scoped to its caller, Team and expiry. It cannot be reused to enumerate another Team or infer host paths.

## 4. Team model

Illustrative schema; exact wire schema will be frozen before implementation:

```json
{
  "schemaVersion": "1",
  "teamId": "team_...",
  "name": "Renderer Fix",
  "revision": 12,
  "leaderPetId": "pet_...",
  "members": [
    {
      "petId": "pet_...",
      "role": "leader",
      "state": "active",
      "joinedAtMs": 0,
      "addedBy": "user"
    }
  ],
  "membershipPolicy": "user_only",
  "createdAtMs": 0,
  "updatedAtMs": 0
}
```

### 4.1 Roles

| Role | Intended authority |
|---|---|
| User / owner | Full control; can override, freeze, demote, remove or dissolve |
| Leader | Manage plan and assignments; manage membership only when policy permits |
| Member | Read Board, add notes, claim work and update owned tasks |
| Observer | Read-only Team and Board access |

Roles are Pi Pet ACL labels, not harness/provider permissions. `reviewer`,
`researcher`, `designer` and similar names are optional display labels, not
hard-coded privileged roles and not triggers for source-specific animations.

### 4.2 Membership policies

```text
user_only       only the user changes membership
leader_invite   leader may invite; target/user acceptance is required
leader_manage   leader may directly manage already-authorized sessions
```

Default: `user_only`.

Rules:

- Only active, authorized catalog entries with `canJoinTeam=true` may be targeted.
- `remove` revokes Team/Board/message access but does not close the session or pet.
- A user-pinned member cannot be removed by a leader.
- User input and user membership decisions outrank all Agent requests.
- No automatic leader election in v1. If the leader leaves, the Team is leaderless until the user assigns another.
- Team size has a bounded configurable cap; proposed v1 default is 8.

## 5. Shared Board model

Board v1 is structured data rendered as a kanban/whiteboard-like surface. It is not a freeform collaborative canvas.

```json
{
  "schemaVersion": "1",
  "teamId": "team_...",
  "revision": 31,
  "goal": { "text": "Fix renderer relaunch race", "updatedBy": "pet_..." },
  "tasks": [
    {
      "id": "task_...",
      "text": "Add regression test",
      "status": "doing",
      "assignee": "pet_...",
      "createdBy": "pet_...",
      "createdAtMs": 0,
      "updatedAtMs": 0
    }
  ],
  "notes": [],
  "decisions": [],
  "blockers": [],
  "artifacts": []
}
```

### 5.1 Allowed content

- Goal: bounded plain text.
- Task statuses: `todo | doing | blocked | done | cancelled`.
- Notes, decisions and blockers: bounded attributed entries.
- Artifacts: references and human-readable summaries, not uploaded file contents.

Forbidden by default:

- transcripts or context windows;
- provider credentials, environment dumps and secrets;
- arbitrary tool input/output blobs;
- automatic repository file replication;
- instructions presented as if authored by the user.

All Agent-authored content is visibly attributed. The user may also edit the
Board directly through its desktop window; user mutations remain revisioned and
audited rather than bypassing the mutation model.

### 5.2 Mutation protocol

Agents do not overwrite the full Board. They submit bounded operations against a known revision:

```json
{
  "baseRevision": 31,
  "operations": [
    { "op": "add_task", "text": "Run Windows smoke", "assignee": "member_handle" },
    { "op": "set_task_status", "taskId": "task_...", "status": "doing" },
    { "op": "append_note", "text": "Failure reproduces only after sleep." }
  ]
}
```

Initial operation set:

```text
set_goal
add_task
assign_task
set_task_status
append_note
add_decision
add_blocker
resolve_blocker
add_artifact_reference
```

Rules:

- Every mutation includes adapter-generated `mutationId`, caller identity and `baseRevision`.
- Identical `(teamId, mutationId)` returns the prior receipt without replay.
- A stale conflicting revision is rejected with the latest revision; it is never silently last-write-wins.
- The coordinator serializes accepted mutations per Team.
- Entries carry author/time metadata; mutation history is auditable.
- Board updates do not trigger an Agent turn by themselves. Use `pet_send` when another member must be notified or awakened.

Deletion and arbitrary section replacement are deferred. V1 prefers cancellation/resolution records over destructive removal.

## 6. Agent-facing tools

Tool names are provisional. The tool surface should remain small and hide transport/identity details.

### Queries

```text
pet_team_status()
pet_board_read(section?, sinceRevision?)
pet_list_sessions(state?, host?)
```

### Actions

```text
pet_team_manage(action, target?, role?)
pet_board_update(baseRevision, operations[])
pet_send(target, text)
pet_arrange(intent)
```

`pet_team_manage` actions:

```text
invite | remove | leave | set_role
```

`pet_arrange` intents:

```text
huddle | pair | dismiss | celebrate | disagree
```

The adapter automatically binds the caller session and Team. The Agent never supplies `petId`, raw session IDs, timestamps, command IDs, exact coordinates, routing nonce or profile identity.

## 7. Messaging and priority

Message classes:

1. `user_message`: explicit user input, delivered through the harness user-message API.
2. `peer_message`: attributed Team/peer message, delivered as a custom Agent message.
3. `team_event`: membership/role/Board metadata; does not impersonate conversation.

Priority:

```text
user input
> permission / severe error
> current task
> explicitly user-authorized urgent team event
> normal team message
> external peer message
> social/performance interaction
```

An Agent cannot mark its own message urgent. Peer messages default to `followUp`, carry TTL/dedup/hop/thread budget and are subject to ACL and rate limits.

## 8. Spatial behavior

Team membership and physical arrangement are independent. Dragging pets close,
`pair` or `huddle` may offer a Team action, but proximity never grants Team,
Board or messaging permission by itself.

- `huddle`: gather visible Team members around a coordinator-chosen anchor and optionally open/focus Board.
- `pair`: place two collaborating members near each other.
- `dismiss`: restore pre-arrangement positions when still valid.
- `celebrate`: temporary gathering/expression; does not change membership.
- `disagree`: bounded visual performance; does not start autonomous debate by itself.

Only the local spatial coordinator sees exact window coordinates. Agents submit semantic intents. User drag, alert state and active input cancel automatic movement immediately.

## 9. Ephemeral child activities

A foreground/one-shot subagent is not automatically a Team member. It is a
short-lived activity owned by the parent session and may be represented by a
small sprite inside or near the parent pet.

```json
{
  "schemaVersion": "1",
  "childId": "child_...",
  "parentPetId": "pet_...",
  "source": "pi-tool",
  "sourceCallId": "tool-call-...",
  "kind": "subagent",
  "phase": "started",
  "label": "minimal worker",
  "createdAtMs": 0,
  "expiresAtMs": 0
}
```

Rules:

- `ChildActivity` is presentation state, not `Session`, `Pet` or `TeamMember`.
- It has no Inbox, user-input target, membership powers or Board capability.
- It follows the parent pet visually; if the parent belongs to a Team, visual
  color/badge inheritance grants no Team permission.
- Concurrent children are tracked by stable source call IDs. Render individual
  sprites up to a small cap, then collapse overflow to `+N`.
- Completion/failure/cancellation may produce a brief generic reaction. A
  profile name such as `reviewer` never implies `disagree`, approval or any
  other scripted story.
- Child results return to the parent. The parent or user decides whether to
  update the Board; Pi Pet does not auto-copy arbitrary child output into it.

Pi Forge's current foreground children are clean, one-shot Pi processes and do
not load third-party extensions. Giving them live Board access would also add
information/tools beyond the exact prepared and approval-fingerprinted plan.
Therefore Board access is forbidden by default.

A future orchestration integration may attach a bounded, revision-pinned Board
excerpt to a delegated task only if it is included before preparation/sealing
and visible in the approval plan. It still does not make the child a Team
member. Runtime Board reads/writes from a sealed child are out of scope.

Pi Forge may be the first optional source adapter because Pi tool events expose
unique call IDs and parallel completion. The neutral `ChildActivity` contract
must not depend on Forge profile roles or private progress details.

## 10. Harness rollout

### Pi — reference implementation

- Extension lifecycle starts/stops inbox polling.
- `sendUserMessage` handles user input.
- custom `sendMessage` handles attributed peer messages and triggers a turn when policy permits.
- Native Pi tools expose Team and Board actions.
- Recognized parallel subagent tool calls may optionally project generic
  `ChildActivity` sprites; this is not required for Team/Board v1.

### OpenCode — second adapter

- Reuse the existing in-process plugin `ctx.client` and authenticated reverse bridge.
- Use the live owning instance/session rather than a detached persisted session ID.
- Map available capabilities explicitly; do not claim Pi-equivalent queue semantics without tests.

### DeepSeek Harness — experimental

- Existing in-process plugin supports public session events and approval handling.
- Board support is possible only through a verified public tool/plugin seam.
- Inbox support requires a verified public session submit/ask seam.
- If either seam is absent, expose only the capabilities actually supported; never read private projection storage.

Claude Code and Codex are deferred. Claude should eventually reuse its native Agent Teams/messaging; ordinary Codex TUI must not be controlled through simulated keyboard input.

## 11. Prototype slice

A one-evening prototype may deliberately support only:

- 2–3 local Pi sessions;
- manual Team creation and leader assignment;
- local inbox with simple watcher/short polling;
- one revisioned Board JSON;
- `read`, `add_task`, `set_task_status`, `append_note`;
- one-shot `pet_send` with source bubble;
- snap-to huddle and celebrate.

The prototype does not prove remote reliability, ACL completeness, crash recovery, migration, multi-monitor correctness or multi-harness compatibility.

## 12. Deferred / explicitly out of scope

- Freeform canvas geometry, drawing and collaborative cursors.
- Full project-management features, calendars, estimates and dashboards.
- Repo/file sync or artifact transfer.
- Transcript sharing or automatic context-window merging.
- Unbounded autonomous conversations or automatic urgent messages.
- Agent-controlled exact coordinates or screen capture.
- Session spawn/kill, PTY, terminal control, worktrees or provider calls.
- Automatic leader election and unsupervised Team merging.
- Promoting one-shot foreground subagents into Team members or giving them live
  Board/Inbox access.

## 13. Acceptance checklist for v1

- [ ] User can create a Team from authorized Pi sessions and assign one leader.
- [ ] Team persists while pets disperse, reconnect or temporarily go offline.
- [ ] Every Board mutation is attributed, revisioned and deduplicated.
- [ ] Two concurrent updates cannot silently overwrite each other.
- [ ] Leader authority follows membership policy; user can always override it.
- [ ] Kicking a member does not terminate its session.
- [ ] Board updates do not wake every Agent automatically.
- [ ] Peer messages show their real source and obey TTL/rate/hop budgets.
- [ ] Huddle/dismiss never grants new message or Board permissions.
- [ ] Renderer receives only semantic layout intent; user drag wins.
- [ ] Optional ChildActivity sprites never create Team members or inherit Board/Inbox ACL.
