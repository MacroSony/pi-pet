# Phase-1 boundary contract

This document describes the implemented phase-1 extraction only. It is not a
provider, daemon, network protocol, or reaction feature.

## Ownership

- `packages/runtime/` owns the dependency-free CommonJS runtime, neutral
  `PetStatus` contract, status-file writes, deduplication, lifecycle handling,
  and renderer spawn/relaunch policy.
- `packages/runtime/adapters/clawd.js` is the only Clawd compatibility adapter.
  It maps Clawd's session snapshot shape and applies the explicit agent
  allowlist. It is not part of the neutral runtime core.
- `clawd-on-desk/src/pet-presentation-bridge.js` is a trusted-operator loader
  shim. It loads only the absolute module named by
  `CLAWD_PET_RUNTIME_MODULE` when `CLAWD_PET_BRIDGE` is enabled. With the
  bridge disabled it does not load or probe the parent repository.
- `claude-status-pet/` is not changed by this extraction.

The exported `API_CONTRACT_VERSION` is `"1"`. The root package is private and
is not an npm dependency or publication artifact.

## Neutral PetStatus

`PetStatus` has these required fields:

```text
state: idle | thinking | reading | editing | searching | running |
       delegating | waiting | error | closed | offline
detail: string
tool: string
event: string
sessionId: portable basename matching [A-Za-z0-9_-]{1,128}
sessionName: string
timestamp: ISO-8601 string
```

The file projection keeps the existing renderer spelling and shape:

```text
<statusDir>/status-<session_id>.json
{
  "state", "detail", "tool", "event", "session_id", "session_name", "timestamp"
}
```

The default status directory remains `~/.pi-pet/status` (using `HOME` or
`USERPROFILE`), and the launcher may override it with
`CLAWD_PET_BRIDGE_STATUS_DIR`. The Rust renderer reads `state`, `detail`,
`tool`, `event`, `session_id`, and `session_name` from this file; `timestamp`
is retained by the runtime projection for watcher/dedup diagnostics and is
ignored by the current Rust status payload.

Enabled installations must set the absolute `CLAWD_PET_RUNTIME_MODULE` path.
This is intentional: old environment setups that used Clawd's in-tree bridge
must migrate by setting that variable (the root launchers set the checkout
default automatically).

## Current behavior

- A session identity is `pet_` plus the first 24 hex characters of SHA-256 of
  `profileId`, `agentId`, and `rawSessionId` separated by NUL bytes. This is
  intentionally the identity/hash behavior of the former Clawd implementation.
- Only presentation fields (`state`, `detail`, `tool`, `event`, `sessionId`,
  `sessionName`) trigger a rewrite. Timestamp-only rebroadcasts do not.
- A real event still rewrites when state and tool are unchanged.
- An explicit `SessionEnd` writes `closed`; a missing session in a later
  snapshot writes `offline`/`SessionMissing`. Missing snapshots are not treated
  as authoritative session ends.
- A live, changed status launches the configured renderer with `run`,
  `--status-file`, `--session-id`, and optionally `--assets-dir`.
  Offline/closed statuses do not launch. A clean renderer exit is not relaunched
  by identical heartbeats; a later genuine presentation change can relaunch it.
- The Clawd adapter defaults to `pi`. `CLAWD_PET_BRIDGE_AGENT_IDS` is a
  comma-separated explicit allowlist; it does not enable all agents implicitly.

## Reactions and reserved fields

The renderer implements a renderer-local reaction file named
`reaction-<session_id>.json` under its default `~/.claude/pet-data` directory.
Its Rust payload fields are `id`, `emotion`, `message`, `speak`, `ts`, and
`ttl_ms`. This location is separate from the bridge status directory and is
not relocated by this phase.

Phase 1 does **not** emit or consume reaction files. In the descriptive contract,
`runtimeImplemented` is false, `rendererImplemented` is true, and
`emittedByRuntime` is false. `message` and `speak` are reserved
renderer reaction fields, not runtime API capabilities. There is no runtime
reaction, speech, provider-call, daemon, or network seam implemented here.
