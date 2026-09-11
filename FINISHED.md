# Pi Pet Finished Work

> 已完成事项归档。当前待办和下一步路线见 [PLAN.md](PLAN.md)。本文件记录“已经做过并验收过”的内容，不代表所有历史计划都实现了。

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
- Scope limitations and remaining verification:
  - This vertical slice implements and verifies local Pi own-session inbox delivery only.
  - Clawd Remote SSH ingress transport for remote Pi inboxes, capability token handshake, and reconnect-visible terminal receipts remain in progress for Milestone 1 release hardening.
  - Manual GUI smoke testing and real live Pi process verification remain to be completed.

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
