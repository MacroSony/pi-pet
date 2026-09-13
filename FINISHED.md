# Pi Pet Finished Work

> 已完成事项归档。当前待办和下一步路线见 [PLAN.md](PLAN.md)。本文件记录“已经做过并验收过”的内容，不代表所有历史计划都实现了。

## 2026-09-12 — Milestone 2 local and Secure Remote SSH peer messaging accepted

- Froze and implemented the M2 peer contract: caller-scoped opaque catalog/reply handles, capability-generation binding, provenance, TTL, dedup, source rate limit, `maxHops=1`, user-first scheduling, separate peer inboxes and conservative receipts.
- Pi peer notes use explicit custom-message provenance and `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: false })`; they never impersonate user input or autonomously wake an idle model.
- Added local and Remote SSH claim/settle consumers, dispatched source bubbles, Clawd restart heartbeat recovery, attach token rotation, stale-token protection, and strict renderer/Agent projections without raw session IDs, cwd, transcripts, tokens or internal pet IDs.
- Added show-without-activate and reliable first-appearance multi-pet staggering while preserving user-saved positions. Removed the failed proximity Huddle experiment and added anti-regression coverage; physical proximity no longer implies relationship or permissions.
- Real Windows testing passed two-local-Pi discovery and bidirectional notes, single-use handle replay rejection, owner-first busy delivery, source bubbles, no automatic model turn, and exactly-once observation.
- Real Homelab Secure Remote SSH testing passed unified cross-machine catalog, local→remote and remote→local notes, source/host provenance, TTL expiry, handle replay rejection and transport fail-closed behavior.
- Fixed SSH Disconnect lifecycle so non-connected profiles immediately lose inbox/peer capabilities, handles, rate buckets, session directory entries and presentation pets while preserving unchanged attach tokens for heartbeat recovery.
- Real Disconnect/reconnect testing passed without restarting either Windows Pi or either Homelab Pi: both catalogs recovered after heartbeat, the pre-disconnect handle returned `invalid handle: not_found`, and a fresh remote→local note was queued and observed exactly once with correct provenance.
- Accepted M2 heads: root `23b547c`, Clawd `b454b57e`, renderer `1e06c62`. Final pre-M3 root suite: **211/211**; Disconnect-focused Clawd: **421/421**; Clawd full suite: **9,416 passed / 5 unrelated existing failures / 52 skipped**.

## 2026-09-12 — Milestone 3a design and Team-state spike parked

- Created `milestone3` branches from the accepted M2 root and Clawd heads.
- Wrote [TEAM-WAKE-CONTRACT.md](docs/TEAM-WAKE-CONTRACT.md) for the hardened path: Team-authorized bounded wake, receiver opt-in, coordinator wake budgets, user-first delivery and a hard two-auto-turn thread limit.
- Completed the isolated M3a.1 neutral Team-store spike with strict v1 schema, fixed `leader/member/observer` roles, `user_only` membership, max-eight membership, generated IDs, atomic persistence, revision conflicts, leader transfer, dissolution and fail-closed corrupt-file handling. Focused tests passed **33/33** and root passed **244/244**; commit `5eed86b` was pushed.
- Product review determined that wiring Team/ACL/Board before trying active peer collaboration was premature. The Team-store commit and hardened contract are parked while a minimal receiver-local, default-off peer-wake PoC is tested on Windows and Homelab.

## 2026-09-12 — Lean peer-wake PoC automated slice complete

- Added `/pet-peer-wake on|off|status`. Opt-in is current-session/current-attach memory only, defaults off, and resets on session start, shutdown, or extension reload.
- Preserved the accepted M2 protocol and endpoints. Passive receivers still use `triggerTurn:false`; opted-in receivers dynamically use `triggerTurn:true` without adding Team state, persistence, coordinator policy, network ports, or wake-budget infrastructure.
- Reused the process-private peer capability slot to bridge the root command to Clawd's separately managed Remote SSH consumer. Token matching fails closed and no wake policy is exposed over the wire.
- Hop 0 receives only its existing single-use reply handle and bounded reply guidance. Hop 1 receives no reply handle and an explicit stop instruction. User-first claim ordering, TTL, dedup, rate limits, provenance and at-most-once settlement remain unchanged.
- Automated verification passed: root **251/251**; focused Clawd extension/capability/installer/remote-consumer **58/58**; remote wake coverage includes enabled hop 0 and hop 1.
- Real Windows → Homelab → Windows testing then passed both automatic turns without user relay: Homelab woke from idle on hop 0, replied through the supplied single-use handle, and Windows woke on hop 1 with no remaining reply handle or fresh thread. The decision gate passed. A malformed smoke payload containing only a marker caused the Homelab model to investigate unnecessarily; this was attributed to sender test construction and prompt wording was intentionally left unchanged pending repeated evidence.

## 2026-09-13 — M3a.2-lite autonomous Team complete

- Added current-attach `/pet-team-autonomy on|off|status`, default off and reset on session start, shutdown and reload.
- Added Agent-facing `pet_team_create(name, targets)`, `pet_team_status()` and leader-only `pet_team_dissolve()`. Mutations require standing user authorization; read-only status does not.
- Reused existing caller/generation-bound `psh_` catalog handles for machine-to-machine member selection. Team creation consumes and resolves them without persistence; reply handles are purpose-rejected without being burned.
- Wired exact `/pet-team/status`, `/pet-team/create` and `/pet-team/dissolve` routes through local Clawd and existing nonce-gated Secure Remote SSH ingress. Team membership adds no messaging/wake/session authority; teammates continue using `pet_send`.
- Enforced one active Team per member for the lite slice, caller-as-leader, 1–7 targets, strict request keys/body caps, sanitized projections and no raw session/pet IDs, tokens, paths or transcripts.
- Automated verification passed: root **256/256**; focused Clawd Team/peer/server/SSH/managed-extension/installer **125/125**; syntax and diff checks clean.
- Real Windows/Homelab smoke completed the full lifecycle: the leader Agent discovered sessions and created `Smoke Team` without user-copied handles; both members read sanitized membership; Homelab refreshed the leader handle from Team status and sent `TEAM-MEMBER-HANDLE-SMOKE` via `pet_send`; the leader received it, dissolved the Team, and both sessions subsequently reported no active Team.

## 2026-09-13 — M3b-lite Minimal Shared Board automated slice complete

- Added a neutral `createTeamBoardStore()` with one strict, atomic `board-<teamId>.json` record per Team, synthetic revision 0, whole-document OCC, monotonic timestamps, last-writer identity and an 8192-byte UTF-8 Markdown cap.
- Board reads require authoritative active Team membership and allow observers; writes reject observers and require exact `baseRevision`. Corrupt, oversized or mismatched persisted records fail closed.
- Added exact coordinator routes `POST /pet-team/board/read|write`, reusing caller capability authentication, active-Team resolution and Secure Remote SSH nonce gating. Responses expose only revision, Markdown, update time and sanitized last-writer attribution.
- Added default-off, current-session `/pet-board-write on|off|status`, read-only `pet_board_read()` and gated `pet_board_write(baseRevision, markdown)`. Session start/shutdown/reload reset write authorization.
- Board content is explicitly teammate-authored data rather than authenticated user instruction. Writes do not send peer messages, wake sessions or mutate Team membership.
- Automated verification passed: root **302/302**; focused Clawd Team/peer/server/SSH/managed-extension regression **162/162**. Cross-machine read/write/conflict remains the live smoke gate.

## 2026-09-09 — Secure Remote Pi inbox and terminal receipt visibility

### Coordinator and capability boundary

- Kept user enqueue local-only at Clawd `POST /pet-inbox`; Secure Remote SSH ingress still rejects remote enqueue and receipt queries.
- Added nonce-gated remote-consumer endpoints over the existing SSH reverse tunnel:
  - `POST /pet-inbox/claim`
  - `POST /pet-inbox/settle`
- Added an in-memory capability registry bound to trusted `profileId`, agent `pi`, and exact canonical raw session ID.
- The managed remote Pi extension generates a fresh 256-bit token per attach, advertises it only through authenticated `/state`, rotates it on a new attach/reload, and causes a real `SessionEnd` to revoke it.
- Capability lookup, pet identity derivation and ingress all fail closed; remote consumers cannot select a different profile, harness, raw session or pet ID.

### Managed remote Pi consumer

- Added remote-only polling to Clawd's managed `hooks/pi-extension-core.js`; local Pi processes do not start this second consumer.
- The consumer uses only the pinned `clawd-remote.json` port and routing nonce. It never scans fallback ports, validates the Clawd response identity header, caps requests at 16 KiB and responses at 64 KiB, and uses a 5-second transport timeout.
- Canonical identity is shared with `/state`: raw Pi IDs become `pi:<sessionId>` and already-prefixed IDs are not double-prefixed; empty/default IDs never poll.
- Claimed text is dispatched with the exact call `pi.sendUserMessage(text, { deliverAs: "followUp", expandPromptTemplates: false })` after TTL and claim-lease checks.
- Settle transport/5xx failures retry only the receipt while blocking further claims; they never call `sendUserMessage` twice. At the 60-second lease boundary the consumer abandons settlement and lets coordinator/runtime surface `failed` with delivery-unknown rather than replaying.
- Reload/shutdown stops and unrefs polling timers; attach-local state keeps multiple Pi processes isolated.

### Receipt UI and disconnect visibility

- Added runtime `getUserMessageReceipt(options)` with strict pet/command matching, pending expiration, stale-claim cleanup, terminal non-downgrade and I/O evidence preservation.
- Added local-only Clawd `POST /pet-inbox/receipt`; remote ingress cannot query arbitrary receipts.
- Tauri validates Clawd's server identity and response cap for receipt queries. The renderer polls for up to 125 seconds, preserves conservative `queued`/not-found/transient states, and uses generation guards so an older request cannot overwrite a newer send.
- UI wording treats `dispatched` only as a non-throwing handoff to Pi, never as task completion or agent reply.

### Verification and remaining evidence

- Root runtime/Pi-extension suites: **122/122 passed**.
- Clawd remote inbox route/ingress focused suite: **68/68 passed**.
- Clawd managed Pi extension, installer, remote deploy, state route, ingress and coordinator suites: **408/408 passed**.
- Renderer Rust tests: **83/83 passed**; renderer JavaScript tests: **46/46 passed**; JavaScript syntax checks passed.
- Clawd full suite reached **9,338 passed, 5 failed, 52 skipped**. The same five unrelated fork-baseline failures remain in recap source assertions and remote layout/path-isolation tests; no files implicated by those failures were changed here.
- Automated contract coverage is complete for the Milestone 1b implementation. Real live-Pi, Tauri GUI and SSH tunnel disconnect/reconnect smoke remain required before a release-level claim.

## 2026-09-09 — Local Pi own-session inbox vertical slice

### Runtime inbox architecture and contracts

- Added neutral inbox APIs to the runtime (`packages/runtime/inbox.js`, `packages/runtime/internal.js`, `packages/runtime/interaction.js`):
  - `enqueueUserMessage(options)`: ingests user input directed at a specific target session's pet identity.
  - `claimNextUserMessage(options)`: atomically leases the oldest pending message for a target pet.
  - `settleUserMessage(options)`: finalizes message status upon dispatch or failure with claim token validation.
- Per-pet inbox directory layout under data directory (`~/.pi-pet/`):
  - `inbox/<petId>/pending/<timestamp>-<commandId>.json`: pending messages ordered by millisecond timestamp, with command ID as the deterministic tie-breaker.
  - `inbox/<petId>/claimed/<commandId>.json`: active claims holding message payload and claim lease metadata.
  - `receipts/rcpt-user-<commandId>.json`: durable user-message receipts with 24-hour GC window.
- Strict wire schema, limits and validation:
  - Envelope payload limit <= 16 KiB; message text strictly between 1 and 2,000 characters.
  - Delivery mode fixed to `deliverAs: "followUp"`.
  - Configurable TTL (1s to 300s, default 60s); capacity capped at 32 items per pet inbox (rejects newest incoming messages when full).
  - Deduplication by `commandId` and `(petId, dedupKey)` against persisted `rcpt-user-*` receipts.
  - Active session verification: rejects messages targeting unknown, closed, or offline sessions by inspecting `status-<petId>.json`.
- Reliable claim lifecycle and crash safety:
  - Atomic rename directly moves messages from `pending` to `claimed/<commandId>.json`.
  - Re-checks message expiration at claim time and marks expired messages with an `expired` receipt.
  - Stale claim recovery (>60s) writes terminal `failed` receipt (delivery-unknown) and deletes the stale claim; stale messages are NEVER silently requeued to prevent duplicate agent execution.
  - Terminal statuses are strictly `dispatched`, `failed`, `expired`, or `rejected`; never reports `delivered` at the dispatch boundary, preserving truthful distinction between runtime dispatch and renderer playback.

### Pi extension inbox consumer

- Added inbox consumer loop to `packages/pi-extension/index.js` (`createInboxConsumer`, `attachInboxConsumer`):
  - Automatically starts on `session_start` and terminates on `session_shutdown` lifecycle events.
  - Multi-candidate session ID resolution matching active Pi runtime session handles.
  - Polling loop with immediate drain on pending messages and configurable idle polling intervals (default 500ms).
  - Re-evaluates expiration timestamp immediately prior to Pi host dispatch.
  - Invokes `pi.sendUserMessage(text, { deliverAs: "followUp", expandPromptTemplates: false })`.
  - Settles receipt status as `dispatched` after a non-throwing `sendUserMessage` invocation, `failed` on a synchronous invocation error or malformed claim, and `expired` when TTL elapses before dispatch.
  - All errors and unhandled exceptions in the polling/dispatch loop are caught to prevent crashing the host Pi process.

### Verification and status

- Root runtime/Pi-extension suites: **111/111 passed**.
- Clawd focused inbox/expression/remote-ingress suites: **40/40 passed**.
- Renderer Rust tests: **74/74 passed**; renderer JavaScript tests: **34/34 passed**; JavaScript syntax checks passed.
- Root and both nested repositories passed `git diff --check`.
- Scope at this checkpoint:
  - This original vertical slice implemented and verified local Pi own-session inbox delivery only.
  - Secure Remote SSH claim/settle, capability handshake and reconnect-visible terminal receipts were completed in the later entry above.
  - Manual GUI, real live Pi and real SSH tunnel smoke testing remain to be completed.

## 2026-09-09 — Phase A/B interaction and Pi expression delivery

### Runtime and Pi extension

- Added the neutral interaction runtime with validated expression envelopes, canonical pet identity, TTL, deduplication, atomic event/receipt writes and 24-hour receipt GC.
- Added the Pi `pet_express(text?, emotion?)` tool. The adapter binds its own session identity; the Agent cannot select a raw session or pet ID.
- Local Pi sessions write directly through the neutral runtime. Remote Pi sessions fall back only after a local identity/session rejection and reuse Clawd's existing Secure Remote SSH transport.
- Remote expression requests use the existing profile-bound routing nonce and ingress identity stamping; no new public port, tunnel, provider or daemon was introduced.

### Renderer and Clawd integration

- The renderer watches runtime-owned `event-<petId>.json` files, validates expiry/schema, deduplicates event IDs and preserves text when an optional reaction asset is missing.
- Clawd gained a bounded `/pet-expression` ingress route with nonce gating for remote profiles, strict shape/size validation and delivery receipts.
- A real loopback exercised extension → ingress → runtime → event/receipt, including bad-nonce rejection and local/remote directory isolation.

### Verification

- Root interaction/extension suites: **50/50 passed** at review time.
- Clawd focused expression/ingress suites: **31/31 passed**.
- Renderer JavaScript tests: **19/19 passed**; Rust tests: **54/54 passed**.
- Remaining manual evidence: real SSH-tunnel delivery and a real Windows Tauri bubble smoke were not replaced by loopback/unit coverage.

## 2026-09-09 — Root boundary extraction and public source release

### Architecture

- The presentation runtime was moved into the root repository:
  - `packages/runtime/runtime.js`: neutral, dependency-free `PetStatus` runtime.
  - `packages/runtime/adapters/clawd.js`: the only Clawd snapshot compatibility adapter.
  - `packages/runtime/contract.js` and `contract.d.ts`: version-1 machine-readable contract and declarations.
- `clawd-on-desk/src/pet-presentation-bridge.js` became a trusted-operator loader. With the bridge disabled it does not load the parent repository; with it enabled, an absolute `CLAWD_PET_RUNTIME_MODULE` is required and an incompatible/missing runtime fails explicitly.
- `clawd-on-desk/run_with_bridge.bat` remains a compatibility wrapper. Root-owned Windows and POSIX launchers derive paths from the checkout and support explicit overrides.
- Stable pet identity, status mapping, write deduplication, offline/session-end handling and renderer relaunch behavior were preserved.
- The renderer submodule was not functionally changed during the extraction. Reaction files remain renderer-local for now; the runtime does not emit them.

### Publication

- Published repositories:
  - https://github.com/MacroSony/pi-pet
  - https://github.com/MacroSony/pi-pet-clawd
  - https://github.com/MacroSony/pi-pet-status-pet
- All three repositories were changed to public.
- Fork default branches were set to `pi-pet-bridge` and `pi-pet-mvp`; the root remains on `main`.
- Root HTTPS submodule URLs, AGPL license, attribution notices, fork README notes and source-checkout launch instructions were added.
- Experimental race directories, prompts/workflows, generated character archives, local runtime state and credentials were excluded. Historical commits were not rewritten; old author attribution and historical local paths remain part of repository history.

### Verification

- Root tests: **19 passed**.
- Clawd loader and snapshot contract tests: **73 passed**.
- Renderer `cargo test --locked`: **50 passed**.
- Runtime TypeScript declarations: strict `tsc --noEmit` passed.
- Root GitHub Actions: Linux/Windows × Node 22/24, **4 jobs successful**.
- An anonymous, empty-credential HTTPS clone with recursive submodules succeeded, and the cloned root test suite passed **19/19**.
- Gitleaks 8.30.1 was checksum-verified and run against current local refs and staged publication content. No root or staged findings were present. Reviewed inherited upstream matches were test fixtures, content-hash Cargo cache keys in Action logs, and expired signed GitHub image URLs in old renderer README history.

### Known limitations recorded, not hidden

- The full Clawd suite still has 5 pre-existing failures (9,322 total: 9,265 passed, 5 failed, 52 skipped), reproduced against the pre-extraction Clawd commit. They concern recap source assertions and remote layout/path-isolation tests.
- Clawd's existing lockfile has four transitive npm audit findings (three high, one moderate); no dependency upgrade was smuggled into this refactor.
- Real Windows GUI and remote-session smoke testing remains a human check. The contract CI and anonymous clone do not replace it.

## 2026-09-04 — Desktop pet MVP behavior

- Per-session presentation bridge from Clawd snapshot fan-out to one Tauri pet window per session.
- Stable identity includes profile/remote identity, agent identity and raw session ID.
- Status mapping for idle, thinking, reading, searching, editing, running, delegating, waiting, error, offline and closed.
- Atomic status-file writes, presentation-aware deduplication and lifecycle-safe renderer launch/relaunch.
- Reaction channel with `reaction-<session>.json`, TTL and priority handling.
- Drag reaction and poke interaction.
- Sleep/exit watchdog with alert exemption and real-status heartbeat gating; hidden wake/respawn and duplicate-write bugs fixed.
- Missing assets fail quietly while the rest of the presentation path remains operational.

## 2026-09-04 — Remote Pi integration

- Remote Pi sessions use Clawd's existing secure Remote SSH transport, profile-bound ingress, identity and stale cleanup.
- Pi extension deployment reuses the existing remote identity and ownership transaction rather than introducing a second tunnel or session registry.
- Remote and local sessions use the same stable pet identity and presentation path.
- Scope remains `account-default`; profile-isolated remote Pi deployment is intentionally not claimed as complete.

## 2026-09-03 — Initial project and renderer foundation

- Root project established with Clawd and claude-status-pet as submodules.
- Tauri renderer provides transparent always-on-top windows, animation state handling, drag behavior and position persistence.
- Existing renderer reactions and watchdog behavior were integrated without putting session-state logic into the renderer.

## Related records

- [Implemented boundary contract](docs/BOUNDARY-CONTRACT.md)
- [Publication validation and limitations](docs/PUBLICATION.md)
- [Original architecture audit](ARCHITECTURE-AUDIT.md)
- [Remote Pi design](REMOTE-PI-DESIGN.md)
- [Animation asset plan](ANIMATION-ASSET-PLAN.md)
