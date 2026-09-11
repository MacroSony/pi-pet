# Pi Pet Inbox Contract v1 (Local Own-Session Desktop Input)

> Scope: Local Pi own-session desktop-to-agent input (`v1`).
> Implementation: `packages/runtime/inbox.js`, `packages/pi-extension/index.js`, `clawd-on-desk/src/server-route-pet-inbox.js`, `claude-status-pet/pet-app/src-tauri/src/lib.rs`.
> Status: Local automated vertical slice implemented and verified; live Pi-process and GUI smoke tests remain.

---

## 1. Architecture & End-to-End Flow

Pi Pet Inbox v1 provides a local, desktop-to-agent message path allowing a user to send text instructions directly to the specific live Pi agent session represented by a desktop pet.

```text
[ Desktop Pet UI (Tauri Webview) ]
   │ sends { text, requestId } only (no petId, no timestamps)
   ▼
[ Tauri Native Backend (Rust) ]
   │ binds opaque petId from window state (Arc<Mutex<String>>)
   │ resolves local port from ~/.clawd/runtime.json
   ▼ POST http://127.0.0.1:<port>/pet-inbox (local loopback only)
[ Clawd HTTP Server (Local Main Route) ]
   │ validates schema, strict keys (rejects createdAtMs & remote ingress)
   ▼
[ Pi Pet Runtime (`packages/runtime/inbox.js`) ]
   │ verifies active session status in ~/.pi-pet/status/status-<petId>.json
   │ checks TTL (1s–300s, default 60s), queue capacity (max 32), dedup key
   │ writes pending message:  ~/.pi-pet/inbox/<petId>/pending/<timestamp>-<commandId>.json
   │ writes initial receipt: ~/.pi-pet/receipts/rcpt-user-<commandId>.json ("queued")
   ▲
   │ polls own-session inbox (~500ms idle / 0ms drain)
[ Pi Extension Inbox Consumer (`packages/pi-extension/index.js`) ]
   │ on "session_start", resolves rawSessionId -> derives matching petId
   │ atomic claim: moves pending/ to claimed/<commandId>.json (claimToken)
   │ dispatches: pi.sendUserMessage(text, { deliverAs: 'followUp', expandPromptTemplates: false })
   │ settles receipt: ~/.pi-pet/receipts/rcpt-user-<commandId>.json ("dispatched")
```

---

## 2. Component Boundaries & Responsibilities

### 2.1 Tauri Desktop UI (`app.js`)
- Captures human input from the pet context menu or message bubble text box.
- Enforces user message length: 1 to 2000 characters.
- Generates a safe request ID: `req_<safe_chars>` (`[A-Za-z0-9_-]{1,64}`).
- Calls Tauri command:
  ```js
  window.__TAURI__.core.invoke('send_session_message', {
    text: rawText,
    requestId: requestId,
  });
  ```
- **Renderer isolation**: The webview renderer passes **only** `text` and `requestId`. It does not supply `petId`, data directories, timestamps, or delivery options.

### 2.2 Tauri Rust Backend (`pet-app/src-tauri/src/lib.rs`)
- Command handler `send_session_message`:
  - Retrieves `pet_id` from native application state (`session_id_state: tauri::State<'_, Arc<Mutex<String>>>`), which is bound when the window is launched for a specific session.
  - Rejects unbound (`""`) or malformed `pet_id` before performing network operations.
  - Validates `pet_id` (`^[A-Za-z0-9_-]{1,128}$`), `request_id` (`^[A-Za-z0-9_-]{1,64}$`), and non-empty `text` (1..2000 characters).
  - Resolves Clawd local port from `~/.clawd/runtime.json` (or `CLAWD_RUNTIME_CONFIG`), ensuring `app == "clawd-on-desk"`.
  - Constructs public HTTP payload and executes a blocking HTTP POST to `http://127.0.0.1:<port>/pet-inbox` (5-second timeout, 64 KiB response cap).
  - Enforces `x-clawd-server: clawd-on-desk` header on response.

---

## 3. Wire Contract: `POST /pet-inbox`

### 3.1 Endpoint & Ingress Restrictions
- **Endpoint**: `POST http://127.0.0.1:<port>/pet-inbox`
- **Host**: Local loopback only (`127.0.0.1`).
- **Remote Ingress Rejected**:
  - Remote SSH ingress (`clawd-on-desk/src/remote-ssh-ingress.js`) strictly omits `/pet-inbox` from allowed routes, returning `404 Not Found` (fail-closed).
  - In addition, `handlePetInboxPost` in `server-route-pet-inbox.js` explicitly checks for `remoteProfile` and returns `403 Forbidden` (`{"status": "rejected", "reason": "remote inbox delivery is not allowed"}`).

### 3.2 Public Payload Schema & Field Constraints
- **Maximum Request Body Size**: 16 KiB (`16384` bytes). Payloads larger than 16 KiB return `HTTP 413 Payload Too Large`.
- **Allowed Keys**: Strict JSON object matching `ALLOWED_SCHEMA_KEYS`:
  - `schemaVersion`
  - `kind`
  - `petId`
  - `text`
  - `deliverAs`
  - `commandId`
  - `dedupKey`
  - `ttlMs`

| Field | Type | Required / Default | Constraints & Description |
|---|---|---|---|
| `schemaVersion` | `string` | Required | Must be exact `"1"`. |
| `kind` | `string` | Required | Must be exact `"user_message"`. |
| `petId` | `string` | Required | `1..128` chars, matching `^[A-Za-z0-9_-]{1,128}$`. Canonical pet identity. |
| `text` | `string` | Required | `1..2000` chars. Human user message text. |
| `deliverAs` | `string` | Optional (`"followUp"`) | If supplied, must be exact `"followUp"`. Any other value is rejected. |
| `commandId` | `string` | Optional (UUID) | `1..64` chars, matching `^[A-Za-z0-9_-]{1,64}$`. Unique command identifier. |
| `dedupKey` | `string` | Optional (`commandId`) | `1..64` chars, matching `^[A-Za-z0-9_-]{1,64}$`. Deduplication key. |
| `ttlMs` | `integer` | Optional (`60000`) | Integer between `1000` and `300000` (1s to 300s). Message time-to-live. |

### 3.3 Strict Key Validation & `createdAtMs` Rejection
- Any unknown property present in the request body is rejected with `HTTP 400 Bad Request` (`{"status": "rejected", "reason": "Unknown property: \"<key>\""}`).
- **`createdAtMs` is strictly forbidden in public requests**: `createdAtMs` is rejected as an unknown property. Creation timestamps are exclusively assigned by the coordinator/runtime at ingestion (`nowMs`).

---

## 4. Statuses & HTTP Mapping

### 4.1 Enqueue Response Statuses (HTTP Endpoint)
| Receipt `status` | HTTP Code | Condition |
|---|---|---|
| `"queued"` | `202 Accepted` | Message validated, active session confirmed, pending message file and initial receipt written. |
| `"dispatched"` | `200 OK` | Deduplication hit: an identical command was previously processed and dispatched. |
| `"rejected"` | `422 Unprocessable Entity` | Session offline/closed, target session unknown, queue capacity exceeded, or a runtime identity/command conflict. Public schema errors are rejected earlier with HTTP 400. |
| `"expired"` | `422 Unprocessable Entity` | Message TTL expired at ingestion before processing. |
| `"failed"` | `500 Internal Server Error` | Filesystem I/O failure writing pending message or receipt. |
| (Infrastructure) | `400 Bad Request` | Malformed JSON or unknown payload fields. |
| (Infrastructure) | `403 Forbidden` | Ingress attempt via remote SSH tunnel. |
| (Infrastructure) | `413 Payload Too Large` | Request body exceeds 16 KiB. |
| (Infrastructure) | `503 Service Unavailable` | Pet runtime module not configured in Clawd. |

### 4.2 Settle Statuses (`settleUserMessage`)
When the Pi consumer finishes dispatching a claimed message, it calls `settleUserMessage` with one of the allowed terminal statuses:
- `"dispatched"`: `pi.sendUserMessage(...)` was invoked successfully into the session.
- `"failed"`: Invocation threw an exception, or the message was malformed.
- `"expired"`: Message expired before dispatch could occur.
- **`"delivered"` is invalid**: Settle explicitly rejects `"delivered"`. In inbox semantics, the terminal state is `"dispatched"` (turn injected into agent harness), not `"delivered"` (which is reserved for pet presentation events).

### 4.3 Lifecycle State Transition
```text
(Client Enqueue)
      │
      ├── [Validation / Session / Capacity Error] ──► status: "rejected" (422)
      ├── [TTL Expired at Ingestion] ──────────────► status: "expired"  (422)
      ├── [I/O Failure] ───────────────────────────► status: "failed"   (500)
      │
      ▼
status: "queued" (202 Accepted)
      │
      │  (Consumer claim: atomic file rename)
      ▼
   [Claimed]
      │
      ├── [Expired in queue / before dispatch] ────► status: "expired"
      ├── [Invocation throw / claim timeout >60s] ─► status: "failed"
      └── [pi.sendUserMessage successful] ─────────► status: "dispatched"
```

---

## 5. Storage Layout & Filesystem Protocol

All runtime artifacts reside in `<dataDir>` (`~/.pi-pet` by default, or `PI_PET_DATA_DIR`):

```text
~/.pi-pet/
├── status/
│   └── status-<petId>.json                   # Active session status file (read to verify non-closed)
├── inbox/
│   └── <petId>/
│       ├── pending/
│       │   └── 0001757419200000-<commandId>.json  # Pending messages in FIFO order (16-digit timestamp)
│       └── claimed/
│           └── <commandId>.json              # Actively claimed messages with claimToken
└── receipts/
    ├── rcpt-user-<commandId>.json            # User message receipt (status: queued -> dispatched/failed/expired)
    └── rcpt-<commandId>.json                 # (Reserved for pet_express expression receipts)
```

### 5.1 Pending Message File (`<dataDir>/inbox/<petId>/pending/<timestamp>-<commandId>.json`)
```json
{
  "schemaVersion": "1",
  "kind": "user_message",
  "commandId": "req_01HZX8E9A2B4C5D6E7F8G9H0JK",
  "dedupKey": "req_01HZX8E9A2B4C5D6E7F8G9H0JK",
  "petId": "pet_0a1b2c3d4e5f678901234567",
  "text": "Please summarize our progress so far.",
  "deliverAs": "followUp",
  "createdAtMs": 1757419200000,
  "expiresAtMs": 1757419260000
}
```
*Note*: The filename uses `String(createdAtMs).padStart(16, "0") + "-" + commandId + ".json"` to ensure strict lexicographical FIFO sorting during directory scans.

### 5.2 Claimed Message File (`<dataDir>/inbox/<petId>/claimed/<commandId>.json`)
```json
{
  "schemaVersion": "1",
  "kind": "user_message",
  "commandId": "req_01HZX8E9A2B4C5D6E7F8G9H0JK",
  "dedupKey": "req_01HZX8E9A2B4C5D6E7F8G9H0JK",
  "petId": "pet_0a1b2c3d4e5f678901234567",
  "text": "Please summarize our progress so far.",
  "deliverAs": "followUp",
  "createdAtMs": 1757419200000,
  "expiresAtMs": 1757419260000,
  "claimToken": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "claimedAtMs": 1757419200500
}
```

### 5.3 User Message Receipt File (`<dataDir>/receipts/rcpt-user-<commandId>.json`)
```json
{
  "schemaVersion": "1",
  "kind": "user_message",
  "commandId": "req_01HZX8E9A2B4C5D6E7F8G9H0JK",
  "dedupKey": "req_01HZX8E9A2B4C5D6E7F8G9H0JK",
  "petId": "pet_0a1b2c3d4e5f678901234567",
  "status": "queued",
  "reason": null,
  "text": "Please summarize our progress so far.",
  "deliverAs": "followUp",
  "createdAtMs": 1757419200000,
  "updatedAtMs": 1757419200000,
  "expiresAtMs": 1757419260000,
  "payloadEcho": {
    "text": "Please summarize our progress so far.",
    "deliverAs": "followUp"
  }
}
```

---

## 6. Safety, TTL, Capacity & Concurrency Guarantees

### 6.1 Queue Order
`claimNextUserMessage` reads `<dataDir>/inbox/<petId>/pending/`, filters valid `.json` files, and sorts them lexicographically. Padded millisecond timestamps preserve creation-time order; messages created in the same millisecond use `commandId` as a deterministic tie-breaker, so v1 does not claim a strict insertion order for timestamp ties. Malformed or unsafe pending candidates are best-effort atomically renamed to a non-`.json` `.quarantine` filename: they are never dispatched and no longer consume the 32-message active capacity.

### 6.2 Queue Capacity Limit (`MAX_INBOX_QUEUE_CAPACITY = 32`)
- Total active messages per pet (`pending` + `claimed`) cannot exceed **32**.
- When `pendingCount + claimedCount >= 32`, new incoming messages are rejected immediately with `422 Unprocessable Entity` (`status: "rejected"`, `reason: "QueueCapacityExceeded: inbox queue capacity limit of 32 reached"`).
- Old messages are not dropped; new messages are rejected (fail-safe backpressure).

### 6.3 TTL Validation & Expiration
- **Default TTL**: 60,000 ms (60 seconds). Range: 1,000 ms to 300,000 ms (1s–300s).
- **Ingestion check**: If `createdAtMs + ttlMs < nowMs`, rejected immediately as `expired`.
- **Claim check**: When `claimNextUserMessage` encounters an item where `expiresAtMs <= nowMs`, it claims the item, immediately writes a terminal `expired` receipt, deletes the claim, and proceeds to the next item.
- **Pre-dispatch check**: The Pi consumer re-verifies `expiresAtMs <= nowMs` immediately before dispatching to Pi. If expired, it settles as `expired` without invoking `pi.sendUserMessage`.

### 6.4 Deduplication & Receipt Separation
- Deduplication is evaluated against persisted `rcpt-user-*.json` files.
- Expression receipts (`rcpt-*.json`) are explicitly ignored during user message deduplication.
- Opportunistic GC prunes receipts older than 24 hours (`GC_WINDOW_MS = 86,400,000 ms`).
- Re-submitting the same `commandId` or `(petId, dedupKey)` returns the existing receipt without re-enqueueing the message.
- If a submitted `commandId` already exists for a *different* `petId`, the request is rejected with `status: "rejected"` (`CommandIdConflict`).

### 6.5 Claim-Before-Dispatch (At-Most-Once Guarantee)
- Claiming atomically renames the pending file to `claimed/<commandId>.json` via `fs.renameSync`.
- If two workers or loops attempt to claim the same pending source file, only one rename can consume that source; the other attempt fails gracefully.
- A unique `claimToken` (UUID) is generated and stored in the claim record. Settlement requires providing the exact matching `claimToken`.
- **No Replay**: A claimed message is **never** moved back to `pending`. If the dispatch fails or times out, the message is settled as `failed` (terminal). This prevents duplicate execution of agent instructions.

### 6.6 Stale Claim Expiration (`CLAIM_TIMEOUT_MS = 60000`)
- If a consumer claims a message but crashes or hangs for more than 60 seconds, the next call to `claimNextUserMessage` or `settleUserMessage` cleans up the stale claim.
- If no terminal receipt exists, it writes a terminal receipt with `status: "failed"` (`reason: "Claim expired: stale claimed item older than 60s (delivery-unknown)"`) and deletes the claim file.

---

## 7. Pi Extension Consumer & Lifecycle

### 7.1 Lifecycle Binding (`session_start` / `session_shutdown`)
- The inbox consumer is attached via `attachInboxConsumer(pi)` in `packages/pi-extension/index.js`.
- It listens exclusively to standard Pi lifecycle events: `pi.on('session_start', ...)` and `pi.on('session_shutdown', ...)`. (Non-standard events like `reload` are not registered).
- On `session_start`:
  - Resolves session ID via `resolveSessionId(event, ctx, pi)`.
  - **Strict Session ID Validation**: If session ID is missing, empty, whitespace-only, or the fallback `"default"`, the consumer does **not** start.
  - Automatically stops any previously active consumer loop and starts a fresh consumer for the new session.
- On `session_shutdown`:
  - Stops polling and unrefs timers.

### 7.2 Own-Session Identity Derivation
The consumer calculates its canonical `petId` from its own process session coordinates:
```text
petId = "pet_" + SHA256(profileId + "\0" + agentId + "\0" + rawSessionId)[0..24]
```
- `profileId`: `PI_PET_PROFILE_ID` environment variable (default: `"local"`).
- `agentId`: `"pi"`.
- `rawSessionId`: Active Pi session ID.
- The consumer only claims from `<dataDir>/inbox/<petId>/pending/`. It cannot read, claim, or settle messages belonging to any other session.

### 7.3 Dispatch Semantics & Exact Options
When a valid message is claimed, the consumer invokes:
```js
pi.sendUserMessage(text, {
  deliverAs: "followUp",
  expandPromptTemplates: false,
});
```
- `text`: String from `claimed.text` (1..2000 characters).
- `deliverAs`: Fixed to `"followUp"` (appended as next user turn).
- `expandPromptTemplates`: `false`.
- **Dispatched semantics**: Settlement to `status: "dispatched"` records that the instruction was successfully handed over to the Pi agent harness. It does not represent agent task completion or playback ack.
- If `pi.sendUserMessage` throws synchronously, the consumer catches the error, settles the receipt to `status: "failed"`, and resumes scheduling without crashing the host Pi process.

### 7.4 Polling Interval & Draining
- Idle poll interval: `500 ms` (`DEFAULT_POLL_INTERVAL_MS`).
- Queue drain interval: `0 ms` (`DEFAULT_DRAIN_INTERVAL_MS`). When a message is successfully claimed and processed (`hasMore: true`), the consumer schedules an immediate next tick to drain backlogged messages rapidly.
- Timers are unref'd to prevent blocking process exit.
- Polling errors back off to `500 ms` and never crash Pi.

---

## 8. Security Boundaries & Current Limitations

### 8.1 Trust Model & Capability Tokens
- **Same-User Prototype Limitation**: Pi Pet assumes a single-operator workstation environment where Clawd, Pi, and the Tauri desktop renderer run under the same OS user account and share access to `~/.pi-pet`.
- **No Capability Tokens**: Inbox v1 does not use bearer tokens, signed macaroons, or capability delegation. Access is guarded by local loopback binding (`127.0.0.1`), active session verification in `status/status-<petId>.json`, and file permission boundaries.

### 8.2 Remote Support Deferred
- `POST /pet-inbox` is rejected on remote SSH ingress endpoints.
- Remote agent-to-agent (A2A) inbox messaging and remote client injection are deferred to future milestones.

### 8.3 UI Receipt Polling Deferred
- The current desktop UI sends the message via `send_session_message`, receives the initial HTTP response (`queued` / `dispatched`), and displays a transient notification bubble ("Message queued").
- The UI does not poll receipt status or display subsequent transition to `dispatched` / `failed` in the pet window.
