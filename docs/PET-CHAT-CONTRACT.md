# Pet Chat Contract v1 (M3c.2)

Pet Chat is a bounded presentation of messages initiated from a desktop pet. It is not a transcript viewer and does not grant access to terminal, peer, Team, or tool history.

## Canonical ownership

Clawd is the single canonical writer for local and Secure Remote SSH chat history. One file is stored per pet:

```text
<dataDir>/chat/chat-<petId>.json
```

The neutral runtime assumes one coordinator writer per data directory and persists changes with the existing atomic JSON helper. A missing file projects as revision `0`; a corrupt, oversized, or schema-invalid file fails closed and is never treated as empty history.

Each persisted turn contains exactly:

```text
commandId, userText, assistantText, createdAtMs, completedAtMs
```

The store retains at most 20 turns and a serialized file of at most 48 KiB. User text is limited to 2000 Unicode code points. Assistant text is stripped of disallowed C0/C1 controls and safely bounded to 8192 UTF-8 bytes.

## What enters history

A user turn is recorded best-effort when local `POST /pet-inbox` accepts the pet-originated message as `queued` or `dispatched`. A chat logging failure must not alter inbox delivery or its receipt.

The local Pi Pet extension and Clawd's managed remote Pi extension correlate completion independently:

1. Register the claimed command before invoking `pi.sendUserMessage()`, because the Pi extension API returns `void` and may emit `input` before that invocation returns.
2. Only an exact `input` event with `source === "extension"` may mark that registered command as observed. Interactive and RPC input cannot do so; peer notes use `pi.sendMessage()` and are not user candidates.
3. Do not activate correlation on claim, dispatch, or `input`. Activate only when Pi emits the real user `message_end`, with exact text, compatible session identity, preserved queue order, and a message timestamp no earlier than dispatch.
4. While a turn is active, only assistant blocks with `type === "text"` are considered. Thinking, tool calls, tool results, custom messages, and other blocks are ignored.
5. A later user `message_end` finalizes the previous clean assistant text before matching the next queued pet turn. Thus a busy follow-up cannot absorb the current response.
6. A clean `agent_end` finalizes the active turn. Assistant or lifecycle error/abort signals discard partial text.
7. Session start, shutdown, and extension reload clear ephemeral correlation state.

Observed inputs are not aged out merely because a preceding tool runs longer than the unobserved-dispatch timeout.

## Coordinator endpoints

```text
POST /pet-chat/read
POST /pet-chat/clear
POST /pet-chat/complete
```

- `read` and `clear` are local-desktop-only. Secure Remote SSH ingress does not expose them.
- `complete` accepts local or nonce-gated Remote SSH traffic, but requires the existing attach-scoped Pi peer capability bound to exact profile, agent, and raw session identity.
- The caller cannot choose the destination pet for completion. Clawd derives it from the authenticated profile/session.
- Completion failure never changes or retries the inbox dispatch receipt and never re-invokes `pi.sendUserMessage()`.
- Clear removes only bounded chat history. It does not close or mutate the Pi session, Team, Board, or pet process.

## Human projection

The desktop projection contains only:

```text
revision, messages[{role,text,createdAtMs}], pending
```

Roles are restricted to `user` and `assistant`. It contains no command ID, pet ID, raw session ID, cwd, transcript, routing nonce, capability token, Team ID, handle, path, thinking, or tool payload.

Double-clicking a pet opens a separate async-created `Pi Pet Chat` window. The title is generic. Message content is rendered only with `textContent`; no HTML or Markdown is interpreted. The chat window has a dedicated least-privilege Tauri capability, and closing or moving it cannot affect the main pet window lifecycle or saved pet position.
