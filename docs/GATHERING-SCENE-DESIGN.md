# M3c.3 — Region-bounded Gathering

Status: activity-area configuration and explicit gathering are implemented and Linux-verified. Windows native input, mixed-DPI/multi-screen and visual acceptance remain pending. This replaces pre-gather position restoration in the earlier roadmap/draft.

## Product goal

Visible pets belonging to a real Team can gather inside a user-chosen area of the local presentation desktop. Ending the gathering releases formation control and leaves pets where they are. This is neither a new task orchestrator nor an autonomous roaming engine.

Remote Agent location is irrelevant to layout: Homelab sessions represented on a Windows desktop participate in that Windows scene. No remote screen/window control is introduced.

## Small first slice

- One user-defined rectangle on one monitor per presentation desktop, shared across pets/Teams. Not a per-session Pi permission or a per-pet WebView localStorage setting.
- A local user menu offers activity-area editing and Team gather/end actions. Editing uses a visible, movable/resizable area preview with Apply/Cancel; it is absent during normal operation. No permanent input-blocking overlay.
- Until a valid area is configured, automatic gathering is unavailable; existing manual placement still works. Removing the area disables automatic layout, not the pets.
- User-triggered gathering first, 2–4 visible members as the initial Windows gate. No movement caused merely by creating a Team, receiving a message, opening Board, heartbeat, or reconnect.
- Region bounds apply to the full native pet window, not only its center. Use the monitor's work area, including negative origins and DPI conversion. If the requested group does not fit, leave it unchanged and explain that the area must be enlarged. Do not overlap participating windows or move outsiders. The grid is not an obstacle/global-occupancy planner: choose a clear region; unrelated or already-ended Teams are not repacked.
- First entry from outside the area may use a direct placement rather than a long animation across the user's work. Short movement within the area can be smoothly animated. No general pathfinding or obstacle avoidance.
- A single active gathering scene per desktop in the first slice. A different Team requires the user to end the current scene first; no multi-Team packing engine.

## Ending a gathering and position persistence

UI should say **End gathering**, not promise a physical dispersal.

Ending a gathering stops formation control and cancels pending movement. It does not move pets, dissolve the Team, clear Board, change permissions, wake Agents, or emit a synthetic conversation.

There is no home-position/pre-gather-position stack. Keep existing last-position persistence for restart convenience; a user drag or completed automatic move may update it. The existing unconditional `WindowEvent::Moved -> write_window_position` behavior must become motion-aware/debounced: animation frames do not each write a position file. Persist settled positions, and distinguish cancellation from successful completion.

## User control always wins

- A user may manually drag a pet outside the activity area. The area constrains automation, not the user's mouse.
- Starting a drag cancels this pet's current motion and excludes it from the remainder of this scene. Late or retried movement for the cancelled scene cannot pull it back.
- Only a new explicit gather request includes that pet again. Ending the current gathering never undoes the user's drag.
- Chat input, active native dragging and blocking/alert UI prevent automatic relocation of that pet. Eligibility is rechecked before applying a move; unsupported combinations are reported/skipped, not forced.
- No automatic window focus, Board opening, or Chat relocation. Geometry-affecting scale/monitor changes invalidate unsafe pending targets.

## Team and lifecycle behavior

- Real coordinator membership determines candidates; only locally represented, online, visible windows with usable geometry participate.
- Fixed scene anchor and deterministic slots; no following a moving leader. Display-name changes, Board revisions and normal business-state updates do not reorder pets.
- Joining/reconnecting members do not automatically enter an existing scene in the first slice; the next explicit gather recomputes participants.
- Removal, disconnect, window closure or Team dissolution cancels affected movement. Remaining pets stay put. Coordinator/renderer restart does not replay an old scene.
- A missing monitor or invalid saved area disables new automatic movement until the user adjusts it; do not silently choose another screen or resurrect a stale target.

## Implementation boundaries

- Coordinator owns the canonical local activity-area setting and real Team-to-local-pet mapping. The setting is user-managed locally, not writable through Agent tools or remote SSH ingress.
- A small neutral runtime module computes deterministic target positions; it does not own windows/providers/PTYs or loop over animation frames.
- Tauri native code reports geometry and drag/cancellation state, applies bounded movement, and persists settled positions. Local execution must reject stale/cancelled work even before coordinator feedback arrives.
- WebView owns menu/preview/presentation only. Internal Team/pet/session identifiers, paths, routing tokens, and physical target routing do not enter Agent outputs or the human Team projection.
- Do not infer stable identity from Team names or member display names. Existing ID-free Team presentation and the display-derived Board lock key are not authoritative layout identities.
- Implement only enough request freshness and started/completed/cancelled feedback for this scene; no durable scene queue, distributed leader election, lease platform, or global priority scheduler.
- Keep the five public tools unchanged. No `pet_arrange`, coordinate arguments, new model turn, or fourth Pi session permission switch.

## Delivery order and gate

1. User area configuration + validated geometry, no autonomous movement.
2. Explicit Team gather/end with direct positioning; stable mapping and local drag cancellation.
3. Short in-area animation and settled-position persistence; Windows negative-origin/mixed-DPI tests.
4. Real local + remote-backed pets on the same Windows desktop: region containment, too-small-region rejection, end-in-place, drag override, stale command cancellation, membership/offline behavior, no focus stealing or permission changes.
5. Only after this gate: consider optional Team-event auto-gather and a bounded bubble FIFO before the collaboration video.

Continuous roaming, per-Team/per-pet regions, multiple rectangles/exclusion holes, route planning, automatic screen-content avoidance, complete multi-monitor choreography, and return-home animations are deferred. Busy owner/peer steering is a separate messaging concern and is not solved by gathering.

## M3c.3a implemented slice and operator smoke

- Pet context menu → Settings → Desktop activity area opens an async, frameless, temporary native editor. Drag its header, resize its edges, Apply to save, Cancel/Escape to discard, or Disable area to store a disabled setting. The editor closes after a successful change. Editing the setting itself does not move pets.
- Clawd is the only writer of `<PI_PET_DATA_DIR>/layout/activity-area.json` (default `~/.pi-pet/layout/activity-area.json`). A strict schema stores revision, physical rectangle and monitor work-area/scale snapshot, no Team/session/capability identity. Whole-setting OCC rejects stale editors. Missing file defaults disabled; malformed/unreadable files fail closed without being overwritten. Rename failure reports a save error, not a non-atomic overwrite.
- `/pet-activity-area/read|write` are local-native-only routes: exact bounded JSON, loopback only, browser-origin/fetch-site and remote nonce/profile rejection. They are deliberately absent from the SSH ingress allowlist. This uses the existing single-user local-process trust boundary, not a new authentication/ACL platform.
- Tauri derives geometry from its own window, never coordinates passed by WebView. The complete frame must fit exactly one current monitor work area. If saved monitor geometry/scale no longer matches, the editor shows a warning and a draft on the current monitor; only explicit Apply replaces the saved setting.
- Default preview is at most 600×300 logical pixels. This is merely an editable starting rectangle, not a claim that four pet windows fit; explicit gathering checks group capacity using complete native window sizes.
- Verification: root401/401, renderer JS88/88, Rust124/124, Clawd9521 pass/52 skip, production custom-protocol release build. Flash in-process read-only review found no blocker; parent aligned native/JS monitor-name validation and retained strict rename-error handling.
- Isolated Linux Xvfb production-binary smoke verified open/cancel, physical resize→save, reopen and process restart restore, out-of-work-area rejection, stale-editor conflict, Disable, and unchanged pet position. Xdotool supplied geometry changes in the WM-less harness; this is NOT evidence for Windows native resize/drag or mixed-DPI behavior.
- Windows gate: pull matching root/Clawd/renderer revisions, restart Clawd, rebuild renderer with `cargo build --release --features tauri/custom-protocol`, close old pets and launch the new binary. No Pi extension/hook update is needed. Check native drag/resize, apply/cancel/disable, two pets seeing the same saved area, stale editor conflict, monitor/work-area/DPI handling and no changes to Chat/Board/pet placement.


## Implemented gathering protocol and Linux evidence

- Coordinator routes `/pet-gathering/report|start|end` reuse the native-loopback guard and are absent from Remote SSH ingress. Reports are bounded to 16 KiB. They map real coordinator pet identity through the authoritative Team store and session directory, not display names. Geometry registrations expire after 3 seconds; at most 128 are retained, while a Team has at most eight members.
- One ephemeral scene, deterministic max-window-cell layout, atomic insufficient-capacity rejection. Only the caller's target is returned to native; no coordinate/scene routing is sent to WebView, model tools, or human Team projection. Normal reports/membership additions never create a scene or reflow its surviving members.
- Reports carry instance/sequence plus a control epoch. The epoch cancels even an assignment that has not been fetched yet when a complete drag happens between reports. Local response epochs also reject in-flight replies after interaction. Native cancels before starting OS drag; that cancellation does not wait for HTTP. Fresh explicit gather is the only re-entry path.
- Native polls serially at 250 ms, runs bounded main-thread animation ticks with at most one queued tick, and stops motion after 900 ms without a successful report. In-area travel is about 450 ms; outside entry is direct. Geometry, actual final outer bounds, topology, blocking status, focused Chat and area editor are rechecked. No focus/show call, Board action or model turn is involved.
- `Moved` records an in-memory pending position; completed/cancelled/manual movement saves after 200 ms settled, and normal destruction flushes. No home stack or frame-by-frame persistence. Restart checks the configured frameless startup size against current work areas; native live movement uses actual outer geometry. GTK's provisional pre-map size must not invalidate every saved position.
- Terra supplied the pure layout and initial coordinator/protocol code; the coordinator task timed out and was taken over, not treated as completed. Parent implemented native/UI and reviewed all changes, fixed property-order/TTL/old-feedback/control-epoch cases and a native UI/state-mutex lock inversion. Terra then did a read-only native review; actual final geometry and startup placement findings were addressed. The serial transport lock is not taken by the UI tick, so it does not share that state-lock inversion.
- Automated result: root **418/418**, renderer JS **89/89**, Rust **128/128**, Clawd **9,523 passed / 52 skipped / 0 failed**, production `cargo build --release --features tauri/custom-protocol` successful.
- Linux smoke uses three separate production Tauri processes in isolated Xvfb, real production HTTP handlers and runtime Team/area stores, with fixture session/status data (including a remote-profile identity). It is not a new real-SSH/Agent collaboration run. Verified native menu gather/end, bounded three-window seats, actual GDK drag takeover outside the area, no pull-back, explicit regather, unchanged input focus, and settled position files. A sampled mtime observer saw one change per moved pet, not every animation frame. The final smoke also passed capacity rejection without relocation, authoritative offline/reconnect behavior, real TeamStore remove/add, dissolution, and coordinator restart without replay; pet restart preserved settled placement. The harness assertion was corrected to the area store’s `status: "updated"` return shape before the final full rerun. Artifacts are retained at `/tmp/pi-pet-gather-live.WNwkjC` on the development host.
- Still pending: Windows 2–4 real local/remote-backed pets, native gesture/capture, mixed-DPI and negative-origin monitors, monitor removal, focus under Windows modal loops, and visual timing/spacing (including long hint bubble wrapping, visibly cramped in the Linux default window). Pull matching root/submodules, restart Clawd, rebuild the production renderer and replace old pet processes. No Pi/hook change or Deploy / Repair Hooks is required for this slice.
