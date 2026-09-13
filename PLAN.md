# Pi Pet Roadmap

> 当前主路线（2026-09）。已完成内容见 [FINISHED.md](FINISHED.md)；已实现边界见 [BOUNDARY-CONTRACT.md](docs/BOUNDARY-CONTRACT.md)；Team / Board 详细设计见 [team-collaboration-design.md](docs/drafts/team-collaboration-design.md)。历史推演保留在 [ARCHITECTURE-AUDIT.md](ARCHITECTURE-AUDIT.md)、[REMOTE-PI-DESIGN.md](REMOTE-PI-DESIGN.md) 和 `docs/drafts/`，不再作为当前待办清单。

## 1. 产品定位

Pi Pet 让 agent 团队不再只是后台进程，而会在桌面上集合、交流、工作、争论和庆祝。

一只桌宠对应一个真实、正在运行的 agent session。Pi Pet 是 session 的**桌面表现、受限交互和团队 presence 层**，不是新的 agent runtime 或任务编排器。

```text
Pi / OpenCode / DSH extensions
          ↕ lifecycle + bounded capabilities
Clawd coordinator
  - session directory / identity / Remote SSH / message routing
          ↕ neutral contracts
Pi Pet runtime
  - presentation / inbox receipts / team semantics / board / layout intents
          ↕ local files + Tauri IPC
Desktop pets + team board
```

### 必须保持的职责边界

| 层 | 负责 | 不负责 |
|---|---|---|
| Harness adapter | 生命周期映射、原 session 输入、agent-facing tools | 通用窗口逻辑、provider、跨 harness 编排 |
| Clawd | session directory、远程身份、Secure Remote SSH、消息路由 | 桌宠渲染、Team 产品语义、模型调用 |
| Pi Pet runtime | 中立 contract、桌宠身份、事件/receipt、Team/Board、语义布局意图 | PTY、spawn、worktree、provider 凭证 |
| Tauri renderer | 窗口、动画、气泡、拖动、位置、Board UI | session 状态判断、agent 调度、精确路由 |

**不做第二个 Hitch / Herdr / Pi Forge。** Pi Pet 不拥有 provider、PTY、终端、agent spawn、worktree 或通用任务编排。外部系统可以成为可选的 session/activity 信号来源，但不能定义 Pi Pet 的 Team 语义或强迫 renderer 使用来源专属角色/动画。

## 2. 已完成基线

以下已经实现，不再列为待办：

- Clawd snapshot → neutral runtime → 一 session 一状态文件 / 一桌宠窗口。
- Pi 本地 session，以及经 Clawd Remote SSH 回传的远程 Pi session。
- 稳定 pet identity、状态映射、写盘去重、offline / SessionEnd、renderer relaunch。
- Tauri 动画、气泡、reaction、拖动、位置保存、idle/sleep watchdog。
- Phase A interaction envelope、TTL、dedup、receipt 和原子文件写入。
- Pi `pet_express(text?, emotion?)`，包含本地和 Remote SSH expression delivery。
- Local 与 Secure Remote SSH Pi own-session inbox 垂直切片（本地 enqueue、runtime claim/settle、capability-scoped 远端 consumer、`pi.sendUserMessage` 与终态 receipt UI 闭环）。
- root / Clawd adapter / renderer 三仓公开和 CI / focused tests。

精确实现证据和仍未完成的真机 smoke 见 [FINISHED.md](FINISHED.md)。

## 3. 核心产品模型

后续功能统一围绕六个对象，不再继续堆彼此无关的小工具：

```text
Session        真实、可持续寻址的 harness 会话
Pet            Session 的桌面形态
Inbox          送回目标 live session 的受限入站邮箱
Team           一组 Session/Pet 的持久协作关系
Board          Team 的共享计划、任务、记录与决定
ChildActivity  某 Session 内短命的一次性子任务表现，不是 Session/TeamMember
```

三个概念必须分开：

> **Team 是持久关系，Huddle 是临时站位，Board 是共享记忆。**

- Team 成员散开工作后，Team 和 Board 仍然存在。
- Huddle / Pair / Celebrate / Disagree 只是临时桌面布局和表现意图。
- Board 不依附某个 leader 窗口；leader session 退出不会销毁团队资料。

## 4. 当前关键路径

### Milestone 1 — Pi own-session inbox（完成；自动化与 Windows/SSH 真机验收通过）

先完成“用户通过桌宠给原 Pi session 发消息”的可靠闭环：

```text
Tauri input
  → Clawd-owned per-session mailbox / runtime inbox
  → target Pi extension poll / long-poll
  → pi.sendUserMessage(text, { deliverAs: 'followUp' })
```

#### Milestone 1a — Local Pi own-session inbox（已实现 / 已测试）

本地单机已实现完整双向收发闭环：

- **Runtime inbox APIs**：`enqueueUserMessage`、`claimNextUserMessage`、`settleUserMessage`。
- **目录结构与有序队列**：`inbox/<petId>/pending/<timestamp>-<commandId>.json` 按毫秒时间排序，同毫秒以 commandId 确定性打破平局，再原子 claim 至 `claimed/<commandId>.json`。
- **严格安全边界与校验**：Envelope <= 16 KiB、text 1..2000 字符、`deliverAs` 锁定 `followUp`、TTL 1s..300s（默认 60s）、队列容量上限 32 条（满载时拒绝新消息）。
- **去重与状态校验**：基于 `commandId` 与 `(petId, dedupKey)` 幂等去重；Session 未知、closed 或 offline 时明确拒绝入队。
- **Claim 与崩溃恢复**：原子重命名认领；消息超时自动标记 `expired`；Stale Claim（>60s）转为 `failed` 终态（delivery-unknown）并清理租约，**绝不静默重新入队**以防 Agent 重复执行。
- **真实终态定义**：终态严格为 `dispatched` / `failed` / `expired` / `rejected`，不在 runtime/extension 派发层伪称 `delivered`。
- **Pi extension 消费循环**：`attachInboxConsumer` 监听 `session_start` / `session_shutdown`；连续消息快速 drain 紧接着按间隔轮询；派发前重检 TTL；通过 `pi.sendUserMessage(text, { deliverAs: 'followUp', expandPromptTemplates: false })` 送入；异常全捕获不导致 Pi 主进程崩溃。

#### Milestone 1b — Remote Pi inbox、capability 握手与断线/终态可见 receipts（已实现 / 自动测试通过）

已完成：

- **Remote Pi inbox 路由**：用户仍向本机 Clawd `POST /pet-inbox` 入队；远端 Pi extension 通过既有 Secure Remote SSH reverse tunnel 主动调用受限 `/pet-inbox/claim` 与 `/pet-inbox/settle`，不开放公网端口，也不允许远端直接伪造用户入队。
- **Capability token 握手与轮换**：每次 remote extension attach 生成独立 256-bit token，通过 authenticated `/state` 注册，并绑定 trusted profile、`pi` 和 exact canonical raw session ID；reload/新 attach 轮换，真实 `SessionEnd` 撤销。
- **断线与 at-most-once**：claim-before-dispatch；settle 传输失败只重试回执而不重派用户消息；超过 60 秒 claim lease 后由 coordinator/runtime 终结为 `failed`（delivery-unknown），绝不静默重放。
- **Receipt 可见性**：Tauri 只从本机 `/pet-inbox/receipt` 查询，renderer 最长轮询 125 秒；明确区分 `queued`、Pi API 非抛错调用后的 `dispatched`、`failed/expired/rejected` 与保守 timeout，不把派发误报为 Agent 已完成任务。
- **身份统一**：Clawd state、local consumer 与 remote consumer 使用同一个 canonical `pi:<sessionId>` raw identity，已带 `pi:` 时不重复添加。

真机验收已覆盖 Windows live Pi、Tauri GUI、真实 Secure Remote SSH tunnel、Disconnect fail-closed、Clawd restart/heartbeat capability 重注册、token/handle 轮换与无重复派发。M1 发布级主链已完成；其他发布平台 GUI 仍属于跨平台发布工作，不阻塞当前 PoC 结论。

### Milestone 2 — Session catalog 与有限 peer messaging（完成；自动化与本地/SSH 真机验收通过）

在 own-session inbox 稳定后，扩展为受控 session-to-session 留言：

- `pet_list_sessions(state?, host?)` 返回短期 opaque handle、显示名、host、state、capabilities 和 `canMessage`；不返回 raw session ID、绝对 cwd、transcript。
- `pet_send(target, text)` 只允许向已授权且具备 `receive_peer_message` 的 session 发送。
- peer message 使用带明确来源的 custom message + `pi.sendMessage()`；不得伪装成用户。
- 默认 `followUp`，带 TTL、dedup、receipt、限流、最大 hops、thread budget 和防循环字段。
- 用户输入优先级永远高于 peer；Agent 不能自行把消息标记为 urgent。
- renderer 显示一次性发送者气泡、接收反应和可选短暂视觉关联；不展示 transcript。

**验收已完成：**两个本地 Pi session 与真实 Homelab Pi session 已完成双向一次性留言；来源、untrusted 边界、user-first、exactly-once、hop 预算、Clawd restart、SSH Disconnect/reconnect、stale handle 清理和原进程 heartbeat 恢复均通过。冻结契约见 [PEER-MESSAGING-CONTRACT.md](docs/PEER-MESSAGING-CONTRACT.md)。

### Milestone 3 — Active Collaboration 与 Autonomous Team（进行中）

Lean peer wake decision gate 已通过真实 Windows → Homelab → Windows 两次自动 turn：receiver opt-in、`triggerTurn:true`、single-use hop 0 reply handle、hop 1 无 reply budget和 user-first 主链均成立。当前继续 M3a.2-lite，不恢复旧版完整 Team ACL 平台。

#### M3a.2-lite — Agent 自主拉群（当前）

- `/pet-team-autonomy on|off|status` 是当前 attach 的用户 standing authorization；默认 off，不持久化，session start/shutdown/reload 清零。
- Agent 用 `pet_list_sessions()` 自己发现成员，再调用 `pet_team_create(name, targets)`；`targets` 只接受 caller-scoped `psh_` catalog handles，创建时消费并解析，绝不持久化或展示给用户。
- caller 自动成为 leader；targets 成为 member；每个 session 暂限一个 active Team。
- `pet_team_status()` 返回脱敏 Team/member projection，并为 active teammates 生成新鲜 `psh_` handles；通信继续复用 `pet_send`。
- `pet_team_dissolve()` 仅 leader 且 autonomy enabled 时可用。
- Lite Team 只是持久分组与发现信息，不授予新的 send/wake/Board/session 权限，因此暂不做 target invite/accept。
- 不新增 `pth_`、`pet_team_send`、角色编辑、Team UI、wake budget、hard lease 或 Board。

M3a.1 neutral Team store 已由提交 `5eed86b` 提供持久 schema/revision 基础。完整产品化边界仍记录在 [TEAM-WAKE-CONTRACT.md](docs/TEAM-WAKE-CONTRACT.md)，但继续保持 parked，只有真实失败证明需要时才解冻。

#### Parked：完整 Team ACL 与 Shared Board

M3a.2-lite 真机可玩验证后，再决定是否实现 Board。Board v1 候选包含：

```text
Goal
Tasks: todo / doing / blocked / done
Notes
Decisions
Blockers
Artifacts (references only)
```

原则：

- Team / Board schema 和 ACL 属于 Pi Pet；Clawd 只托管 coordinator 和跨机路由。
- canonical Board 位于 coordinator，不依赖跨机共享文件系统，也不复制 repo 文件。
- 用户可在独立 Board 窗口中直接查看和编辑；用户修改同样带 revision 和审计来源。
- Agent 通过 `pet_board_read()` 和带 `baseRevision` 的受限 patch 操作修改；禁止全文覆盖共享 Markdown。
- 所有条目记录作者、时间和 revision；冲突返回最新 revision，不能 last-write-wins 静默覆盖。
- Board mutation 本身不自动唤醒全队；真正需要另一 Agent 处理时再通过 `pet_send` 通知。
- 用户拥有最高权限。Leader 是 Team ACL 角色，不是 provider 或进程 owner。
- leader 可按 policy 管理成员和计划；踢人只退出 Team，不能结束 session。

详细数据模型、工具和权限见 [team-collaboration-design.md](docs/drafts/team-collaboration-design.md)。

**未来验收（当前不实施）：**用户可把 2–4 个 Pi sessions 组成 Team、指定 leader；成员并发更新任务不会互相覆盖；成员退出/离线后 Board 仍可读；用户可撤销任何 leader 操作。

### Milestone 4 — 空间协调与语义移动（待 M3 真机价值验证后重审）

早期 proximity Huddle 已因真机误触发、退出手感差和关系语义虚假而完整删除，不得回归。M4 若继续，只实现由真实 Team/讨论事件或用户明确请求触发的语义动作；位置永远不产生 Team、Board 或消息权限。

候选实现仍是先建立本地空间协调器，再做团队动作：

1. renderer 回报窗口物理坐标、尺寸、monitor、work area、scale 和观测时间；
2. runtime 根据语义意图计算安全位置；
3. renderer 平滑移动并回报完成/取消；
4. 用户拖动永远抢占自动移动；
5. 多显示器、负坐标、DPI、窗口边界和散会复位必须正确。

Agent / Team 只允许请求语义意图：

```text
huddle | pair | dismiss | celebrate | disagree
```

不允许 Agent 操作精确屏幕坐标或逐帧控制窗口。拖近、pair 或 huddle 也不能隐式授予 Team/Board 权限；空间关系只是表现，成员关系必须显式授权。低优先级 `roam` 由本地规则驱动，不唤醒模型。

**验收：**Team 可 huddle 后再 dismiss 回原位；用户拖动立即取消；不同 DPI / 多屏下不出屏、不高频写位置文件。

### Optional Track — Session 内 ChildActivity 可视化（不阻塞主线）

一次性 foreground subagent 与长期 live session 不是同一种对象。Pi Forge 当前 child 是由 parent tool call 启动的独立、干净、一次性 Pi 进程；parent model 等待 tool result 后再继续，child 没有稳定 Inbox、Team 身份或第三方 extension。

因此只定义中立的 `ChildActivity` presentation：

- 每个 active child 由 `(parentPetId, source, toolCallId)` 去重和跟踪；
- renderer 在 parent pet 窗口内显示一只 Q 版小猫，多个并发调用显示多只；超过视觉上限时折叠为 `+N`；
- 最小生命周期为 `started → completed | failed | cancelled | timed_out`；只有来源提供可靠进度时才显示更细阶段；
- child 依附发起它的 parent pet，不自动加入 parent 的 Team，也不生成独立桌宠窗口；
- child 没有 Inbox、用户输入、成员管理或 Board tool；结果先回 parent，由 parent/用户决定是否更新 Board；
- parent 属于某 Team 时，child 可以继承颜色/徽记等纯视觉关联，但不继承 Team 权限；
- `forge_subagent` 只是首个可选 source adapter。未来其他 harness 的 subtask 可映射到同一 contract；不硬编码 Forge profile、leader/worker/reviewer 或特殊剧情动画。

Pi 的 tool events 已提供唯一 `toolCallId`，同一 turn 的多个 parallel calls 可以可靠计数；本地原型不需要等待 Forge 增加完整 lifecycle API。若要区分 approval/pending 与真正 running，则以后使用公开、稳定的 progress seam，不能猜测私有 details。

**验收：**同一 parent 并发启动 N 个已识别 subagent tool calls 时出现 N 个临时 child sprites；每个按自己的 tool result 消失/收尾；Team 成员和 Board ACL 始终不变。

## 5. Harness capability model 与优先级

统一 capability contract，不强迫所有 harness 使用同一种 transport：

```text
observe_status
emit_expression
receive_user_message
receive_peer_message
query_pet_context
control_semantic_layout
read_team_board
write_team_board
native_team_metadata
```

| Harness | 当前优先级 | 目标 | 约束 |
|---|---:|---|---|
| **Pi** | P0 | 第一套完整双向、Team、Board reference adapter | 当前主线；优先满足实际自用；ChildActivity 是可选表现能力 |
| **OpenCode** | P1 | 状态、表达、原 session 输入、Board | 复用现有 in-process `ctx.client` 与 authenticated reverse bridge；不公开额外 server |
| **DeepSeek Harness** | P2 / experimental | 先状态与 Board；有公开 session submit seam 后再 inbox | 当前 plugin 只验证了 session events / approval；不读私有 projection storage |
| Claude Code | Deferred | 将来复用原生 messaging / Agent Teams | 不自建重复 inbox |
| Codex | Deferred | managed app-server 模式再评估 | 普通 TUI 无可附加 live control handle；不以终端粘贴冒充原生支持 |
| 其他 harness | Deferred | capability-by-capability | 能显示状态不等于能接收消息 |

原则是：**先设计中立 contract，只实现 Pi adapter；不要先造“通用 coding-agent 协议”。**

## 6. 一个晚上可做的纵切片（Prototype，不等于发布完成）

为了快速验证产品感觉，可以把第一版严格限制为：

- 同一台机器上的 2–3 个 Pi sessions；
- 本地 mailbox，短轮询或简单 watcher；
- 用户手动创建 Team 和指定 leader；
- 一个 revisioned JSON Board，支持 read / add task / update status / append note；
- `pet_send` 一次性留言；
- 简单 snap-to huddle，无动画、无碰撞系统；
- 气泡显示来源，完成后一起 `celebrate`。

Prototype 明确不承诺：远端、崩溃恢复、自由讨论、自动成员管理、OpenCode/DSH、完整 ACL、跨版本迁移和发布级多屏行为。协议字段仍应预留 identity、revision、TTL 和 receipt，避免原型成功后推倒重来。

## 7. 发布硬化与延后项

核心纵切片可用后再补：

- renderer playback ACK（把 write-ack `delivered` 拆成 dispatched / played）。
- 本地 TTS、Board 语音播报。
- Team Board 历史、撤销、导出 Markdown。
- session/team crash recovery、队列 backpressure、审计和 GC。
- 多屏/DPI/休眠恢复的真实 Windows/macOS/Linux GUI smoke。
- Pi Pet 与 Herdr / 其他 hooks 同时安装的冲突测试。
- 可选 ChildActivity 小猫、social/performance mode 和受预算限制的多轮争论。

## 8. 明确不做

- provider、OAuth/API key、模型路由或新的 agent runtime。
- terminal multiplexer、PTY、terminal read/send-keys、spawn、worktree。
- Agent 自由执行精确窗口坐标、读取截图或控制每一帧移动。
- 把 Team Board 变成 repo 文件同步、云盘或完整项目管理 SaaS。
- 默认无限 Agent 对话、无限自动邀请、自动 urgent 或未经授权的跨 session 注入。
- 为了“兼容”普通 TUI 而模拟键盘粘贴。
- 把一次性 foreground subagent 自动升级成 Team member，或让它继承 parent 的 Board/Inbox 权限。
- 第一版自由画布、复杂连线编辑、账号系统、云同步、Live2D/3D 重渲染。

## 9. 当前执行顺序

1. Milestone 1 own-session inbox。（完成；自动化与 Windows/SSH 真机通过）
2. Milestone 2 catalog + bounded passive peer messaging。（完成；本地/远程/restart/disconnect/reconnect 真机通过）
3. Lean peer wake：session-local opt-in、复用 M2 `maxHops=1`、真实 Windows↔Homelab 两-turn E2E。（完成；decision gate 通过）
4. M3a.2-lite autonomous Team：session-local autonomy opt-in、Agent discovery/create/status/dissolve、复用 `psh_` + `pet_send`。（当前）
5. 真实 local/SSH Agent 自主拉群 smoke；根据体验决定是否需要 invite/accept 或完整 Team ACL。
6. 若 Team 仍有价值，再做 structured Board：revisioned patch、审计、并发冲突和独立 Board UI。
7. 录制真实协作 PoC，并执行 standalone / 渐进抽离 / Herdr optional adapter decision gate。
8. 根据 M3 真机价值重新决定 Milestone 4 的语义动作；禁止 proximity 推断关系。
9. 实现 OpenCode adapter。
10. 探索 DSH 公开 plugin seam；不满足边界则维持部分 capability。
11. 空闲时做中立 ChildActivity 小猫；`forge_subagent` 仅作为第一个可选映射源。
12. 最后再考虑 Claude、Codex、复杂社交和自由白板。
