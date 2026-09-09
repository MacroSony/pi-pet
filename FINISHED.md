# Pi Pet Finished Work

> 已完成事项归档。当前待办和下一步路线见 [PLAN.md](PLAN.md)。本文件记录“已经做过并验收过”的内容，不代表所有历史计划都实现了。

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
