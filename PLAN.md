# Pi Pet Roadmap

> 当前路线图（2026-09-09）。已完成内容见 [FINISHED.md](FINISHED.md)；实现边界见 [BOUNDARY-CONTRACT.md](docs/BOUNDARY-CONTRACT.md)，公开发布验收和已知限制见 [PUBLICATION.md](docs/PUBLICATION.md)。旧的设计推演保留在 [ARCHITECTURE-AUDIT.md](ARCHITECTURE-AUDIT.md) 和 [REMOTE-PI-DESIGN.md](REMOTE-PI-DESIGN.md)。

## 1. 产品边界

Pi Pet 是 **agent session 的桌面表现层和交互层**：一只正在工作的 agent session 对应一只桌宠。

```text
harness hooks / extensions
          ↓
Clawd：session lifecycle、identity、Remote SSH、state normalization
          ↓ PetSnapshot / capability boundary
Pi Pet runtime：presentation、desktop interaction、delivery receipts
          ↓
Tauri renderer：window、animation、position、local input
```

职责必须保持清楚：

| 层 | 负责 | 不负责 |
|---|---|---|
| Harness adapter | 将某个 harness 接入生命周期和输入能力 | 桌宠窗口、动画、通用位置逻辑 |
| Clawd | 多 harness session、远程身份、连接与基础状态归一 | 每个桌宠的渲染实现、provider 调用 |
| `packages/runtime/` | 中立 `PetStatus`、桌宠身份、状态文件、supervisor、未来交互协议 | Clawd 私有 session 状态机、模型/provider |
| Tauri renderer | 窗口、动画、拖动、位置、用户交互 | 判断 agent 是否 working、调用模型 |

**不做第二个 Hitch。** Pi Pet 不拥有 agent runtime、provider 凭证、通用任务调度器或云端同步。

## 2. 当前实现基线

当前已实现并已验证：

- Clawd snapshot → Pi Pet runtime → 一 session 一状态文件/桌宠窗口。
- Pi 本地 session，以及通过 Clawd Remote SSH 回传的远程 Pi session。
- 稳定 session identity、状态映射、写盘去重、断线/offline、SessionEnd、renderer relaunch。
- Tauri 桌宠的动画状态机、reaction 文件、拖动、位置保存、idle/sleep watchdog。
- root-owned、无依赖 CommonJS runtime；Clawd 只通过版本化绝对路径 loader 接入。
- root / clawd adapter / renderer 三仓已经公开；精确状态和测试证据见 `FINISHED.md`。

这些是基线，不是本阶段的新开发目标。

## 3. 下一阶段：先把 agent→桌宠做成可靠闭环

### Phase A — Neutral interaction contract

把交互协议放进本仓 `packages/runtime/`，但先不实现 provider 调用：

- 定义 `PetCommand`、`PetEvent`、`DeliveryReceipt` 版本和 session/pet identity 规则。
- command 必须绑定一个明确的 `petId` / canonical session；不允许“当前活跃 session”这种隐式路由。
- 事件至少支持 `queued`、`accepted`、`rejected`、`expired`、`delivered`、`failed`。
- 消息有字节上限、TTL、唯一 command ID 和幂等规则；状态文件不携带 transcript、tool input、凭证。
- 先采用本机文件/IPC 作为实现边界；远程 agent 复用已有 Clawd secure SSH transport，不另造裸 HTTP 端口。

**验收：**没有 renderer 或 harness 也能离线验证 schema、拒绝非法 identity、重复 command 不重复执行、重启后不会误重放。

### Phase B — Agent → Pet 表达

第一条真实功能链：

```text
Pi extension tool / command
        ↓
PetCommand: notify / reaction
        ↓
Pi Pet runtime → renderer
```

提供小而固定的能力，而不是暴露窗口底层 API：

- `pet_notify(text, emotion?, speak?)`：文字和表情分开成功；缺少动画素材时文字不能丢。
- `pet_react(emotion, ttl?)`：复用现有 reaction 优先级和 TTL。
- `pet_get_context()`：先返回 pet/session identity、presentation state、位置和能力，不返回屏幕内容。

实现顺序：先气泡文字，再可选本地 TTS，最后把 reaction 文件从 renderer 私有路径迁到统一 runtime-owned command path。迁移期间保留兼容读取，不直接改变现有生产路径。

**验收：**Pi agent 能对自己的桌宠发文字/表情；重复发送可去重；过期事件不显示；busy/alert 状态优先级不被表达事件破坏；agent 进程退出不会留下无限期任务。

### Phase C — Pet → Pi session 输入

只先支持 Pi，因为当前 Pi Extension API 已提供运行中 session 的 `sendUserMessage()`，可选择 `followUp` 或 `steer`。

```text
Tauri input / poke
        ↓
PetCommand: user_message
        ↓
Pi adapter（绑定原 session）
        ↓
pi.sendUserMessage(text, { deliverAs })
```

必须具备：

- 输入框或明确的轻量交互入口；默认发送到这只宠物对应的原 Pi session。
- `followUp` / `steer` 明确区分；忙碌时默认排队，不用模拟键盘粘贴作为主路径。
- command receipt、重试幂等、session 已退出/断线/权限等待时的明确错误。
- renderer 只发用户意图，不能接触 provider 凭证或直接调用模型。
- 其他 harness 只有在拥有等价的运行中输入接口后才接入；“能显示状态”不等于“能收消息”。

**验收：**桌宠输入一句话只让目标 Pi session 收到一次；另一个 session 不受影响；Pi 忙时行为可见；进程重启和网络断开不会静默丢消息或重复执行。

### Phase D — 位置感知与主动移动

位置能力分成三层，避免把“知道坐标”误做成“看懂屏幕”：

1. `get_context`：当前窗口物理坐标、尺寸、显示器工作区、DPI/scale、观测时间。
2. `move_to`：语义目标（`point`、`work-area-corner`、`monitor`），由本地 renderer 做边界裁剪和平滑移动。
3. `roam`：本地规则驱动的闲逛，不唤醒模型；用户拖动、alert、输入时立即打断。

**不在本阶段做：**读取屏幕截图、识别其他窗口、自动避障、跨设备空间同步、让模型逐帧控制窗口。

**验收：**多显示器、负坐标、DPI 缩放下不出屏；用户拖动会取消自动移动；移动有最终 receipt；位置持久化不会高频写盘。

## 4. Harness capability model

每个 harness 明确声明能力，不用一个“全兼容”开关：

```text
observe_status       必选：状态 → PetStatus
emit_expression      可选：agent → pet notify/reaction
receive_user_message 可选：pet → 原 session 输入
query_pet_context    可选：读取位置/能力
control_pet_motion   可选：请求移动（本地能力，需额外授权）
```

第一批目标：

| Harness | 状态观察 | agent→pet | pet→agent | 备注 |
|---|---:|---:|---:|---|
| Pi | ✅ | Phase B | Phase C | 首个完整双向适配器 |
| Claude Code | 已有/按 Clawd 状态 | 后续 | 后续 | 先确认官方扩展/输入边界 |
| Codex | 已有/按 Clawd 状态 | 后续 | 后续 | 不以终端粘贴冒充原生输入 |
| 其他 Clawd harness | 按实际能力 | 后续 | 后续 | 显式 allowlist，默认不启用 |

## 5. 维护与更新策略

- **Pi Pet root**：协议、neutral runtime、renderer-facing command/event contract、跨实现测试。
- **Clawd fork**：尽量只保留 upstream 必需的 Pi adapter、snapshot observer 和 loader；新 harness 优先上游适配，避免把桌宠逻辑散进 connector。
- **Renderer fork**：窗口、动画、Tauri IPC、位置和本地输入；不复制 Clawd session registry。
- 上游更新先在各自 fork 分支同步，再跑 root contract、Clawd focused suite、renderer tests 和真实 smoke；不使用 `git submodule update --remote` 直接漂移生产版本。
- 破坏性协议改动必须升版本，并保留一个迁移期；状态文件和 command/event 文件不能靠“顺便改字段”升级。

## 6. 明确不做

- 重写 Clawd 的所有 connector、SSH、session state machine。
- 在 Pi Pet 内嵌模型/provider、保存 OAuth/API key、实现第二个 agent runtime。
- 用截图/视觉模型决定桌宠位置，或用模型控制每帧移动。
- 把 Telegram direct-send、终端 focus/paste 当作通用 session 输入协议。
- 默认自动打开所有 harness、所有 session 或所有移动能力。
- cloud sync、账号系统、Live2D/3D 重渲染、复杂养成系统。

## 7. 近期执行顺序

1. Phase A：交互 envelope、receipt、身份绑定、离线测试。
2. Phase B：Pi `pet_notify` + `pet_react`，先文字后 TTS，做一次真实本机/远程闭环。
3. Phase C：Pi 桌宠输入框和 `sendUserMessage`，完成队列/去重/断线验收。
4. Phase D：`pet_get_context`、`move_to`、本地 roam；最后再考虑其他 harness。
