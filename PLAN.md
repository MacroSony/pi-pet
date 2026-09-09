# Pi Pet / Multi-Agent Desktop Pets — 初步计划

> Historical design record. The extracted implementation now lives in the root `packages/runtime/`; see [current boundary contract](docs/BOUNDARY-CONTRACT.md) and [validation/known limitations](docs/PUBLICATION.md). Earlier in-tree bridge paths and proposed features below describe their original phase.

> 规划文档。目标：一个独立运行的 Multi-Agent Desktop Pet 应用。

## 1. 项目目标

每个正在运行的 agent session 对应一只独立桌宠。

- 同时运行多个 Pi session 时，桌面上同时显示多只宠物。
- 每只宠物独立反映对应 session 当前状态（Idle / Thinking / Reading / Searching / Editing / Running / Waiting for user / Error / Done-Sleeping）。
- 桌宠显示 session 名称、项目名称、当前 tool/activity 等简单信息。
- 支持本地 session，也支持通过 SSH 连接的远程机器上的 session。
- 架构不绑定 Pi，未来可连接 Claude Code、Codex、OpenCode 等其他 agent harness。
- 后续支持 subagent：主 agent 使用完整桌宠，subagent 使用附属 mini pet。

```
🐱 pi-forge           Editing state.ts
🐶 pi-subagent-runtime Running tests
🐰 homelab / Pi       Waiting for input
```

本质链路：

```
Agent/session infrastructure
        ↓
   Unified session state
        ↓
 Desktop pet presentation
```

而不是把桌宠逻辑直接写进 Pi runtime。

## 2. 初步技术路线

第一版优先复用两个现有项目：

**Clawd on Desk**（backend / session infrastructure）

- 多 agent connector
- Pi integration
- session tracking
- session lifecycle
- process liveness
- remote SSH
- remote identity
- terminal/session metadata
- permission/event infrastructure

尽量避免修改其成熟的 agent connector 和 SSH 部分。

**claude-status-pet**（frontend / presentation）

- Tauri desktop window
- 一 session 一窗口
- transparent always-on-top pet
- animation
- character assets
- drag/movement
- speech/status display
- pet window lifecycle

不使用其 Claude hook/session backend，只复用桌宠显示层。

## 3. 初步架构

```
Pi / Claude / Codex / ...
        │
        ▼
   Clawd connectors
        │
        ▼
    Session Registry
        │
        ▼
 Pet Presentation Bridge
        │
  ┌─────┼─────┐
  ▼     ▼     ▼
A      B     C
│      │     │
▼      ▼     ▼
🐱     🐶    🐰

Remote session:
Remote Pi
   │
   ▼
Clawd remote hook
   │
 SSH tunnel
   │
   ▼
Local Clawd
   │
Session Registry
   │
   ▼
Pet renderer
   │
   ▼
🐉

桌宠 renderer 不需要知道 session 是本地还是远程。
```

## 4. Session 与 Pet 的基本模型

稳定 identity：`host/profile + agent + sessionId`

```
local:pi:abc123
homelab:pi:def456
server1:claude:xyz789
```

第一版：`1 top-level session = 1 pet`

未来：

- 1 top-level agent = full pet
- subagent = mini pet
- headless session = dashboard only

## 5. Pet 状态设计

不要让 LLM 主动调用 tool 来维护基础状态。基础状态由 agent lifecycle / tool events 自动推导：

```
agent_start        → thinking
read               → reading
grep/search        → searching
edit/write         → editing
bash               → running
permission/UI prompt → waiting
error              → error
agent_end          → done / idle
```

（可选）额外 agent tool：`pet_react(...)`，仅用于表情/情绪/台词/特殊动画。

```
runtime owns state
agent optionally owns expression
```

## 6. Phase 1 — Local Pi Prototype

证明核心体验。

1. Fork / 提取 Clawd session backend。
2. 获取 Pi session lifecycle。
3. 增加 "PetPresentationBridge"。
4. 每个 Pi session 输出独立状态。
5. 为每个 session 启动一个 claude-status-pet renderer。
6. 实现基础状态映射。
7. session 创建时出现桌宠。
8. session 结束后进入 done/sleep 状态并最终关闭。
9. 支持桌宠拖动及位置保存。

**验收：**

- 启动三个 Pi → 桌面出现三只宠物
- Pi A edit → Pet A editing
- Pi B bash → Pet B running
- Pi C 等用户输入 → Pet C waiting
- 其他两只宠物状态不受影响

## 7. Phase 2 — Generic Multi-Agent

Pi-specific prototype 泛化为统一 session presentation。支持 Pi、Claude Code、Codex 及 Clawd 支持的其他 agent。

统一结构 `PetSessionSnapshot`：

```
session id
agent type
host
project/cwd
alias
state
tool
activity
last update
```

重点：Claude + Pi + Codex 可同时对应独立桌宠。

## 8. Phase 3 — Remote / SSH

复用 Clawd Remote SSH infrastructure：

- Remote Pi extension deployment
- remote Pi session discovery
- remote profile identity
- disconnect/reconnect handling

```
Laptop
 ├─ local Pi       🐱
 ├─ local Pi       🐶
 └─ homelab Pi     🐉
```

remote pet 与 local pet 行为一致。

## 9. Phase 4 — Product Polish

- per-session character/skin
- session alias
- project label
- host indicator
- better animations
- notifications
- pet sleep/wake/retire animation
- session resume 恢复原 pet
- tray/session manager
- crash recovery
- renderer supervisor
- multi-monitor position persistence

## 10. Phase 5 — Subagent Visualization

Agent hierarchy：

```
        🐱 Pi main
       /   |   \
     🐭   🐭   🐭
   search test review
```

- top-level session → full pet
- child/subagent → mini pet
- headless worker → no independent pet

避免大量 subagent 生成大量独立 desktop windows。

## 11. 第一版明确不做（MVP 范围控制）

- 自己重新实现 SSH
- 自己重新实现所有 agent connectors
- Live2D / 3D renderer
- WebGL / PixiJS 重型渲染
- 复杂宠物养成系统
- cloud account / sync
- agent 主动控制基础 runtime state
- subagent visualization
- permission bubble 跟随宠物移动

**第一阶段重点：可靠地把多个独立 agent session 映射成多个独立桌宠。**

## 12. 第一阶段成功标准

Multi-Pi MVP：

- Windows desktop app
- 3+ concurrent Pi sessions
- one session → one pet
- independent state
- project/session label
- drag + position persistence
- session start/end lifecycle
- no interference between sessions

---

### 策略

> 先复用 Clawd 的 session infrastructure 和 claude-status-pet 的 presentation infrastructure，只开发两者之间缺失的 multi-agent presentation bridge。
