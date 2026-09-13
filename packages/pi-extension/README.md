# pi-pet Pi extension

Registers `pet_express`, `pet_list_sessions`, and `pet_send`; attaches the local user/peer inbox consumer; and exposes the receiver-local Lean PoC command `/pet-peer-wake`.

Contracts:
- Agent Expressions: [`docs/drafts/phase-a-interaction-contract.md`](../../docs/drafts/phase-a-interaction-contract.md)
- User Inbox v1: [`docs/PI-INBOX-CONTRACT.md`](../../docs/PI-INBOX-CONTRACT.md)
- Peer Messaging v1: [`docs/PEER-MESSAGING-CONTRACT.md`](../../docs/PEER-MESSAGING-CONTRACT.md)

The agent never supplies petId/commandId/TTL/timestamps — this extension attaches them
from its own session context (`ctx.sessionManager.getSessionId()`), and the neutral
runtime (`packages/runtime/interaction.js`) validates, dedups, TTL-checks and persists
the PetEvent + DeliveryReceipt under `~/.pi-pet/`.

## Setup

1. Make the extension discoverable by Pi, e.g.:

   ```sh
   mkdir -p ~/.pi/agent/extensions
   ln -s /path/to/pi-pet/packages/pi-extension ~/.pi/agent/extensions/pi-pet
   ```

2. Point it at the runtime module (trusted absolute path, same pattern as
   `CLAWD_PET_RUNTIME_MODULE`):

   ```sh
   export PI_PET_RUNTIME_MODULE=/path/to/pi-pet/packages/runtime/interaction.js
   ```

   Optional: `PI_PET_DATA_DIR` (default `~/.pi-pet`), `PI_PET_PROFILE_ID` (default `local`).

3. The local pet for this session must exist (status file written by the Clawd →
   pi-pet bridge), otherwise `pet_express` returns `rejected (UnknownPetIdentity)` (or falls back to remote mode if configured).

## Tool surface

| Parameter | Type | Constraint |
|---|---|---|
| `text` | string, optional | 1–2000 chars, bubble text |
| `emotion` | enum, optional | `happy` \| `shy` \| `shocked` \| `sad` \| `celebrate` |

At least one required. Returns `{ status, reason? }` — `delivered` means the event and
receipt were atomically persisted (write-ack; renderer playback confirmation is deferred).
Missing animation assets are skipped by the renderer, but text always displays.

## Remote Delivery Mode

When Pi runs on a remote host (e.g., inside an SSH session or container) and the desktop pet
is displayed on a Windows/macOS client running Clawd, `pet_express` delivers expressions via
HTTP POST to Clawd's remote-SSH ingress endpoint.

### Remote Configuration

Remote configuration is loaded from a JSON file:
- **Environment override**: `PI_PET_CLAWD_REMOTE_CONFIG` (must be an absolute path).
- **Default path**: `~/.pi/agent/extensions/clawd-on-desk/clawd-remote.json`.

The config JSON must contain:
- `remotePort` (integer, `1`–`65535`): Local port forwarded to Clawd remote ingress.
- `routingNonce` (string, `/^[a-f0-9]{32}$/`): 32-character hex authentication nonce.
- `profileId` (string, non-empty): Remote profile identifier.

If the config file is missing or invalid, remote delivery is unavailable and any fallback attempt fails closed.

### Wire Contract

Expressions are POSTed over HTTP via `node:http`:
- **Endpoint**: `POST http://127.0.0.1:<remotePort>/pet-expression`
- **Headers**:
  - `Content-Type: application/json`
  - `x-clawd-routing-nonce: <routingNonce>`
  - `Content-Length: <byteLength>`
- **Request Body JSON** (≤ 16 KiB):
  ```json
  {
    "schemaVersion": "1",
    "kind": "pet_expression",
    "rawSessionId": "session-id",
    "agentId": "pi",
    "text": "Task completed!",
    "emotion": "celebrate",
    "createdAtMs": 1757419200000
  }
  ```
- **Response JSON** (read capped at 64 KiB):
  ```json
  {
    "status": "delivered",
    "reason": null,
    "commandId": "cmd_01HZX8E9A2B4C5D6E7F8G9H0JK"
  }
  ```
- **Timeout**: 2500ms. Network errors, timeouts, or unparseable responses return `{ status: "failed", reason: string }` with `isError: true`.

### Routing Rules

1. **Local-First Delivery**: When `PI_PET_RUNTIME_MODULE` is configured, `execute()` invokes `interaction.expressExpression` locally first.
2. **Selective Fallback**: Fallback to remote POST occurs **only** when the local receipt is a rejection caused by identity or session lookup (`InvalidPetIdentity`, `UnknownPetIdentity`, `SessionClosed`) AND remote configuration is available.
3. **No Double Delivery**: Any other local outcome (`delivered`, `SchemaValidationError`, `expired`, or `IO failure`) is returned immediately as-is.
4. **Missing Remote Config**: If local rejection occurs and remote configuration is missing or invalid, the original local rejection receipt is returned with its reason annotated: `"<reason> (remote fallback unavailable)"`.
5. **Standalone Remote Mode**: If `PI_PET_RUNTIME_MODULE` is not configured but valid remote configuration exists, the extension validates parameters inline and dispatches directly to the remote endpoint.

## Local Inbox Consumption (Desktop → Pi)

The extension automatically attaches an inbox consumer loop when Pi initializes (`session_start`). It continuously polls the local session inbox for pending user messages sent from the desktop pet UI.

### Setup & Environment
- Requires `PI_PET_RUNTIME_MODULE` pointing to `packages/runtime/interaction.js` or `packages/runtime/index.js` (which exports `claimNextUserMessage` and `settleUserMessage`).
- Optional environment overrides:
  - `PI_PET_PROFILE_ID` (default: `"local"`): Profile identity component used to derive `petId`.
  - `PI_PET_DATA_DIR` (default: `~/.pi-pet`): Root directory for inbox queues and receipts.

### Consumer Behavior
1. **Lifecycle Binding**:
   - `session_start`: Resolves active `rawSessionId` from event/context. Derives canonical `petId` (`"pet_" + SHA256(profileId + "\0pi\0" + rawSessionId)[0..24]`). Stops any previous consumer loop and begins polling. Rejects missing, empty, or `"default"` session IDs.
   - `session_shutdown`: Stops active polling loop and unrefs timers cleanly.
2. **Ordered Polling & Draining**:
   - Poll interval: `500ms` when idle.
   - Drain interval: `0ms` (immediate next tick) when a message is claimed and processed (`hasMore: true`), draining backlogged items rapidly.
3. **At-Most-Once Dispatch**:
   - Claims pending message atomically into `claimed/<commandId>.json` with a generated `claimToken`.
   - Re-checks expiration immediately before dispatch.
   - Injects the message into the active Pi session via:
     ```js
     pi.sendUserMessage(text, {
       deliverAs: "followUp",
       expandPromptTemplates: false,
     });
     ```
   - On successful invocation, settles receipt to `status: "dispatched"`.
   - On synchronous exception, catches error, settles receipt to `status: "failed"`, and resumes loop without crashing the Pi process.
   - Claimed messages are never requeued (at-most-once delivery). Stale claims older than 60s are swept to terminal `failed` (`delivery-unknown`).

## Peer Messaging and Lean Wake PoC

`pet_list_sessions` returns sanitized, opaque short-lived handles. `pet_send` sends an explicitly attributed custom peer note; it never impersonates user input. User inbox claims remain higher priority than peer claims.

Peer delivery is passive by default:

```js
pi.sendMessage(peerNote, { deliverAs: "followUp", triggerTurn: false });
```

For the current product-value PoC, the receiver may explicitly opt its current attach into automatic peer turns:

```text
/pet-peer-wake on
/pet-peer-wake off
/pet-peer-wake status
```

Opt-in is memory-only, defaults to off, and resets on session shutdown, extension reload, or a new session start. When enabled, valid peer notes use `triggerTurn:true`. Existing M2 TTL, dedup, rate limit, provenance, user-first ordering and `maxHops=1` remain unchanged: hop 0 may include one supplied reply handle; hop 1 has no reply handle and tells the model to stop. This PoC does not add Team ACL, coordinator wake budgets, persistence, or a hard turn lease.

The root extension and Clawd's managed extension share only the existing process-private peer capability slot. The command adds a `wakeMode` flag while preserving the capability token; the remote consumer validates the same token and reads the flag at dispatch time. Nothing is advertised over the wire and no new endpoint is opened.

## Autonomous Team PoC

Team mutation is disabled by default. The user may grant the current attach standing authorization:

```text
/pet-team-autonomy on
/pet-team-autonomy off
/pet-team-autonomy status
```

With autonomy enabled, the Agent may discover active sessions and form one Team:

```text
pet_list_sessions()
pet_team_create(name, targets)
pet_team_status()
pet_team_dissolve()
```

`targets` are 1–7 existing `psh_` catalog handles returned by `pet_list_sessions`; they are machine-facing values passed verbatim by the Agent, not IDs for the user to type. Creation consumes the handles, resolves them to internal pet identities, and stores no `psh_` value. Team status returns names, roles, availability and fresh short-lived handles for active teammates; messaging continues through `pet_send`.

Autonomy is session/attach-local, defaults off, and resets on session start, shutdown or extension reload. Team membership itself grants no new messaging, wake, Board or session authority. The lite slice intentionally has no invite flow, role editing, `pth_` namespace, Team-specific send tool, wake budget or UI.

## Secure Remote SSH Inbox Consumption

Remote Pi sessions use Clawd's separately managed extension (`clawd-on-desk/hooks/pi-extension-core.js`), not the local filesystem consumer in this package. The desktop still enqueues through local Clawd; the remote extension advertises an attach-scoped capability over authenticated `/state`, then claim/settle polls through the existing SSH reverse tunnel. User settle retries never re-invoke `pi.sendUserMessage`; peer settle retries never re-invoke `pi.sendMessage`. See the inbox and peer contracts for the exact trust and receipt semantics.
