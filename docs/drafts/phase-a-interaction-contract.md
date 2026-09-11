# Phase A Neutral Interaction Contract (Draft)

> Version: `1.1.0-draft` | Target: `packages/runtime/` | Baseline: Phase-1 Extraction
>
> Status: the Phase A contract and Phase B `pet_express` path are implemented;
> this file remains the detailed expression design record. Local Pi own-session
> input is documented separately in [PI-INBOX-CONTRACT.md](../PI-INBOX-CONTRACT.md);
> remote input, Team and movement work follow [PLAN.md](../../PLAN.md).
>
> Changelog 2026-09-09: owner decisions incorporated — file-watch transport confirmed;
> `delivered` = write-ack for v1 (renderer playback ack deferred); receipts GC 24h;
> single agent-facing action tool; `$schema` URI ceremony removed; agent never handles
> petId/commandId/timestamps; persisted artifacts reduced to event file + receipt file.

This document defines the neutral interaction contract for Pi Pet (Phase A). It specifies the agent-facing tool surface, the persisted envelope schemas, identity binding rules, lifecycle, storage layout, security boundaries, and the offline verification plan.

---

## 1. Architectural Boundaries

Pi Pet serves as the desktop presentation and interaction layer for agent sessions. Under PLAN.md:
- **Local file/IPC boundary only**: No new HTTP/WebSocket ports. Remote agent communication exclusively reuses Clawd's existing SSH transport.
- **No provider calls or second runtime**: Pi Pet does not embed LLM providers, credentials, or task orchestration logic.
- **Explicit identity on the wire, implicit convenience at the tool surface**: every persisted envelope binds a canonical `petId`; the agent itself never sees or supplies it (see §3).

```text
[Pi Extension / Harness Adapter]
          │  PetCommand (logical request, validated in-process by runtime lib)
          ▼
 [Pi Pet Runtime (`packages/runtime/`, library — not a daemon)]
   - Validates schema, identity, limits, TTL
   - Writes PetEvent file (renderer-facing)        →  ~/.pi-pet/events/
   - Writes DeliveryReceipt (dedup + audit)        →  ~/.pi-pet/receipts/
          │  (renderer watches event file)
          ▼
 [Tauri Renderer (`claude-status-pet`)]
   - Presents animations / bubbles; local poke/drag/input
```

---

## 2. Agent-Facing Tool Surface

The contract has **two views**. The agent only ever sees this one.

### 2.1 `pet_express(text?, emotion?)` — the single action tool (Phase B)

| Parameter | Type | Constraint |
|---|---|---|
| `text` | string, optional | 1–2000 chars; plain human-readable text for the bubble |
| `emotion` | enum, optional | `happy` \| `shy` \| `shocked` \| `sad` \| `celebrate` |

- At least one parameter is required. Both may be sent together (coordinated bubble + reaction).
- **Nothing else exists on the tool surface**: no petId, no commandId, no TTL, no timestamps, no UUIDs/hashes of any kind.
- `emotion` is a **closed enum**, never free text. Values map to `reaction_<emotion>.webp` assets. `drag` is excluded (user-driven hold loop, not an agent expression). Business states (`working`, `idle`, …) are NOT emotions and are never set by this tool.
- Missing animation asset: the reaction is skipped silently per existing renderer philosophy, but **text must never be dropped** — bubble shows regardless.
- Tool returns a minimal result: `{ "status": "delivered" | "rejected" | "expired" | "failed", "reason"?: string }`.

### 2.2 Future tools (not in Phase B)

- Semantic layout actions (`huddle`, `pair`, `dismiss`, `celebrate`, `disagree`) are deferred until the local spatial coordinator exists. Agents will not receive exact-coordinate or per-frame window control. Whether the final surface is a separate `pet_arrange` tool or a bounded action field is decided with that implementation; no callable-but-inert field is declared early.
- `pet_get_context()`: separate **query** tool in the spatial milestone. Queries and actions have different semantics (idempotency, receipts) and are not merged.

---

## 3. Identity Binding & Addressing

### 3.1 Canonical `petId` Derivation

The canonical `petId` is computed deterministically **by the adapter**, never by the agent:

```text
petId = "pet_" + SHA256(profileId + "\0" + agentId + "\0" + rawSessionId)[0..24]
```

- `profileId`: Remote SSH profile or `"local"` (normalized, max 256 chars).
- `agentId`: Harness identifier, e.g. `"pi"` (normalized lowercase, max 256 chars).
- `rawSessionId`: Harness session ID (max 4096 chars).
- NUL separator prevents collision across component boundaries.

### 3.2 Routing & Validation Rules

1. **Explicit on the wire**: every persisted envelope carries `petId`; envelopes without a valid `petId` are rejected.
2. **Automatic at the tool surface**: the Pi extension runs inside the session process and attaches its own session coordinates. The agent cannot route to another session's pet — and cannot accidentally misroute.
3. **Active session verification**: the target `petId` must be an active (non-closed) session in runtime memory; otherwise `rejected (SessionNotFound | SessionClosed)`.
4. Path-traversal or malformed `petId` values are rejected before any filesystem access.

---

## 4. Persisted Envelope Schemas

All persisted envelopes use `schemaVersion: "1"`. No `$schema` URI field — `schemaVersion` is the only versioning mechanism.

### 4.1 PetCommand (logical, not persisted in v1)

A command is the validated in-process request at the adapter boundary:

```json
{
  "schemaVersion": "1",
  "commandId": "cmd_01HZX8E9A2B4C5D6E7F8G9H0JK",
  "dedupKey": "notify_turn_42",
  "petId": "pet_a1b2c3d4e5f60718293a4b5c",
  "kind": "notify",
  "payload": { "text": "Done.", "emotion": "happy", "speak": false },
  "createdAtMs": 1757419200000,
  "ttlMs": 30000
}
```

- `commandId` (adapter-generated, ULID/UUIDv4, ≤64 chars), `dedupKey` (defaults to `commandId`), `createdAtMs`, `ttlMs` (default 30000, min 1000, max 300000) are all adapter-side. The agent never supplies them.
- `kind`: `"notify"` | `"react"` in Phase B. Future input/query/layout commands receive their own reviewed contracts rather than inheriting this expression schema.
- In v1 the command has no file of its own; its durable artifacts are the PetEvent (§4.2) and the DeliveryReceipt (§4.3).

### 4.2 PetEvent (persisted; renderer-consumed)

One current event file per pet, written atomically by the runtime:

```json
{
  "schemaVersion": "1",
  "eventId": "cmd_01HZX8E9A2B4C5D6E7F8G9H0JK",
  "petId": "pet_a1b2c3d4e5f60718293a4b5c",
  "kind": "expression",
  "payload": {
    "text": "Done.",
    "emotion": "happy",
    "speak": false,
    "priority": 3,
    "durationMs": 2500
  },
  "createdAtMs": 1757419200000,
  "expiresAtMs": 1757419230000
}
```

- `eventId` equals the originating `commandId` (one identifier, two artifacts).
- Renderer dedups by `eventId` watermark and ignores events with `now > expiresAtMs`.
- Priority mapping aligns with renderer hierarchy: `ALERT (4) > REACTION (3) > TRANSITION (2) > VARIATION (1) > LOOP (0)`.

### 4.3 DeliveryReceipt (persisted; dedup + audit)

```json
{
  "schemaVersion": "1",
  "commandId": "cmd_01HZX8E9A2B4C5D6E7F8G9H0JK",
  "dedupKey": "notify_turn_42",
  "petId": "pet_a1b2c3d4e5f60718293a4b5c",
  "status": "delivered",
  "reason": null,
  "payloadEcho": { "text": "Done.", "emotion": "happy" },
  "createdAtMs": 1757419200000,
  "updatedAtMs": 1757419200120
}
```

- Terminal states are immutable; resubmitted `(petId, dedupKey)` within the retention window returns the persisted receipt without re-emitting an event.
- Receipts older than **24 hours are pruned** on runtime startup and snapshot cycles (owner decision 2026-09-09).

### 4.4 Limits

- Envelope size: max **16 KiB**.
- `payload.text`: max **2,000 chars**. `payload.emotion`: closed enum (§2.1). `commandId`/`dedupKey`: max **64 chars**.
- TTL: `expiresAtMs = createdAtMs + ttlMs`; if exceeded at ingestion, dispatch, or render time, the command is `expired` and nothing displays.

---

## 5. Command & Event Lifecycle

v1 transitions (owner decision: `delivered` = write-ack, renderer playback confirmation deferred):

```text
validated ──► event file written + receipt written ──► delivered  (terminal)
invalid ────► rejected (terminal, receipt with reason)
stale ──────► expired  (terminal; no event emitted)
IO failure ─► failed   (terminal, receipt with reason)
```

- `delivered` in v1 means: the event file and receipt were atomically persisted. It does NOT mean the renderer has played the animation.
- **Deferred (owner want, not v1)**: renderer writes back a playback-confirmation receipt after the animation/bubble actually displays. When implemented, `delivered` splits into `dispatched` (write-ack) and `delivered` (play-ack). Schema version bump at that time.

---

## 6. Storage Layout & Migration

Runtime owns all interaction files under `~/.pi-pet/` (configurable via `PI_PET_DATA_DIR` / existing bridge env).

### 6.1 Directory Layout

```text
~/.pi-pet/
├── status/
│   └── status-<petId>.json             # Presentation status (PetStatus v1)
├── events/
│   └── event-<petId>.json              # Current presentation event for renderer
└── receipts/
    └── rcpt-<commandId>.json           # Delivery receipts (24h GC)
```

### 6.2 Atomic Write Protocol

1. Write payload to `<targetPath>.<pid>.<uuid>.tmp` in the same directory.
2. Flush and close.
3. Rename to `<targetPath>`. Windows sharing-collision fallback: direct atomic overwrite with cleanup.

### 6.3 Compatibility Strategy for `reaction-<session>.json`

1. **Runtime-owned primary**: new expressions write to `~/.pi-pet/events/` + `~/.pi-pet/receipts/`.
2. **Dual-emission fallback (Phase B bridge)**: if backward compatibility with unmigrated renderers is enabled, runtime also projects an ephemeral legacy `reaction-<petId>.json` copy to `~/.claude/pet-data/`.
3. **Renderer read migration**: renderer watches `~/.pi-pet/events/event-<petId>.json` first; falls back to legacy `reaction-<sessionId>.json` if absent.
4. **Dedup parity**: both paths share the renderer's in-memory consumed-ID set to prevent double playback.

### 6.4 Remote Expression Transport (implemented 2026-09-09)

When Pi runs on a remote host (pet renderer on the clawd host), `pet_express` delivers over the existing Clawd Remote SSH ingress instead of local files. No new ports, no new daemons.

- **Routing (extension side)**: local-first — if the local `expressExpression` fails with an identity rejection (`InvalidPetIdentity`/`UnknownPetIdentity`/`SessionClosed`) AND a remote config exists, fall back to remote POST. Any other outcome never falls back (no double delivery).
- **Config**: `PI_PET_CLAWD_REMOTE_CONFIG` (absolute path) or default `~/.pi/agent/extensions/clawd-on-desk/clawd-remote.json` (`remotePort`, `routingNonce` (`^[a-f0-9]{32}$`), `profileId`).
- **Request**: `POST http://127.0.0.1:<remotePort>/pet-expression`, header `x-clawd-routing-nonce`, body ≤16KiB:

```json
{
  "schemaVersion": "1",
  "kind": "pet_expression",
  "rawSessionId": "...",
  "agentId": "pi",
  "text": "...",
  "emotion": "happy",
  "dedupKey": "...",
  "ttlMs": 30000,
  "createdAtMs": 1757419200000
}
```

- **Ingress (clawd side)**: nonce-gated (timing-safe, header only for this path), 16KiB body cap, strict key whitelist, same text/emotion validation. `profileId` comes from the ingress's own `remoteProfile` — the agent never supplies it.
- **Response**: receipt JSON; 200 delivered / 400 schema-rejected / 422 rejected-or-expired / 413 oversized / 503 runtime unconfigured / 500 unexpected.
- Verified by loopback test (real extension → real ingress gate → real route → real runtime): `/tmp/pi-pet-remote-loopback.js`.

---

## 7. Security, Privacy & Forbidden State

State, event, and receipt files are plain local files. Strictly forbidden in any contract payload:

1. **No conversation transcripts**: prompts, completions, context windows, chat histories.
2. **No tool input/output payloads**: bash commands, script bodies, diffs, file contents. Only brief human-readable summaries (`"Editing app.js"`).
3. **No secrets**: API keys, OAuth tokens, SSH keys, env dumps.
4. **No raw frame/screen buffers**.

---

## 8. Offline Verification Plan

100% testable in CI without Tauri, display servers, or live harnesses.

| # | Scenario | Expected |
|---|---|---|
| 1 | Malformed JSON, missing fields, bad enum emotion, negative TTL, >16KiB payload | `rejected (SchemaValidationError)` |
| 2 | Path-traversal/malformed/unknown/closed `petId` | `rejected (InvalidPetIdentity \| UnknownPetIdentity \| SessionClosed)`; no FS access before validation |
| 3 | Same `(petId, dedupKey)` twice | First: event + receipt; second: persisted receipt returned, no second event |
| 4 | `createdAtMs + ttlMs < now` at ingestion | `expired`; no event file |
| 5 | Persist receipts, restart runtime, resubmit same commandId | Receipt cache loaded from disk; no re-execution |
| 6 | Concurrent writes | No partial JSON reads, no corrupt files, tmp cleanup |
| 7 | Emotion enum violation (`"super_excited"`) | `rejected (SchemaValidationError)` |
| 8 | Missing reaction asset for valid emotion | Event still written; text preserved; renderer skips animation silently |

---

## 9. Owner Decisions & Deferred Items

### Decided (2026-09-09)

1. **Transport**: file-watch on `~/.pi-pet/events/event-<petId>.json`. Stay lightweight; no sockets/pipes without proven need.
2. **`delivered` semantics**: write-ack for v1 (§5).
3. **Receipt GC**: prune >24h on startup and snapshot cycles.
4. **Tool shape**: single action tool `pet_express(text?, emotion?)` (§2.1).

### Deferred

1. **Renderer playback confirmation** (owner wants eventually): play-ack receipt written by renderer; splits `delivered` into `dispatched`/`delivered` with schema version bump.
2. **Semantic layout intents**: implemented only with the spatial coordinator; no Agent-controlled exact coordinates.
3. **`pet_get_context()` query tool**: implemented with the spatial milestone and limited to sanitized pet/window capabilities.
4. **TTS (`speak: true`)**: after bubble text is proven; field reserved in payload, always `false` in Phase B.

### Implemented since v1.1

- ~~Remote agents~~: remote expression transport added 2026-09-09 (§6.4).
