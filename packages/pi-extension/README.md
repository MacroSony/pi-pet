# pi-pet Pi extension (Phase B)

Registers the `pet_express(text?, emotion?)` tool so a Pi agent can express through its
desktop pet: text bubble and/or emotion animation. Contract:
[`docs/drafts/phase-a-interaction-contract.md`](../../docs/drafts/phase-a-interaction-contract.md).

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
