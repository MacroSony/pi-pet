# Remote Pi Adapter — 复用设计拆解

> 目标：让远端 Linux 的 interactive Pi session 通过现有 Clawd Secure Remote SSH transport 回到 Windows Clawd，再由 PetPresentationBridge 映射为本地独立桌宠。
>
> 范围：Remote Pi MVP（一个 Remote SSH profile / Unix account，多 top-level Pi session，state-only）。

## 结论：不新建 tunnel，不新建 nonce，不新建 session registry

Clawd 已有完整的 secure remote path：

```text
Remote hook
  → 127.0.0.1:<remoteForwardPort>
  → SSH -R reverse tunnel
  → profile-bound local ingress
  → routing nonce verification
  → profile identity stamping
  → Clawd state.js session map
  → session snapshot fan-out
  → PetPresentationBridge
  → claude-status-pet × N
```

Remote Pi 只需成为其中一个 **remote hook adapter**。以下组件不应重写：

| 既有组件 | 复用方式 |
|---|---|
| `remote-ssh-runtime.js` | 现有 SSH / reverse tunnel、reconnect、port conflict、serialized transport |
| `remote-ssh-ingress.js` | 现有 per-profile local ingress、constant-time nonce 验证、profile stamping |
| `remote-ssh-identity.js` | 现有 install binding、nonce rotation、previous nonce grace window |
| `remote-ssh-profile.js` | 现有 profile validation、account ownership、identity transaction |
| `remote-ssh-deploy.js` | 现有 lease、fenced remote mutations、staging/SCP、hash verification、cleanup |
| `state.js` / `state-session-snapshot.js` | 现有 remote identity / stale cleanup / session aggregation |
| `PetPresentationBridge` | 已按 `profileId + agentId + rawSessionId` 生成 stable pet ID；无需 remote 特例 |

---

## 已发现的关键复用协议

### 1. 远端身份文件：已有，不另建 schema

Secure deploy 已写入：

```text
<remote Claude hooks dir>/clawd-remote.json
```

其 schema 由 `buildRemoteIdentityDocument()` 生成：

```json
{
  "version": 2,
  "layoutVersion": 1,
  "runtimeKey": "account-default",
  "profileId": "...",
  "installId": "...",
  "remotePort": 23333,
  "routingNonce": "32 hex chars",
  "deployedAt": 0
}
```

- `remotePort`：远端 127.0.0.1 上被 SSH `-R` 监听的端口。
- `routingNonce`：进入 profile-bound ingress 的 bearer credential。
- identity 文件通过远端 stdin + atomic rename 写入，权限 `0600`；nonce 不进入 ssh/scp argv。

### 2. 统一 secure HTTP transport：`hooks/server-config.js`

它已经提供：

```js
postStateToRunningServer(body, options, callback)
```

其行为已经符合 Pi remote 的全部要求：

- 发现 colocated `clawd-remote.json` 后进入 secure mode。
- secure mode 只使用 `remotePort`，不扫描 23333-23337。
- 自动添加 `x-clawd-routing-nonce` header。
- identity 无效时 fail closed。
- 用 remote timeout，并记录 rate-limited transport failure。

此文件仅依赖 Node 内置模块，因此可作为 Pi extension 的第三个 self-contained 文件部署；不必复制一套 port / nonce / header / timeout 实现。

---

## 为什么 Pi 仍需一个很小的适配层

现有 `hooks/pi-extension.ts` 自己实现了 HTTP POST，并只读取：

```text
~/.clawd/runtime.json → port
```

它不会：

- 读取 `clawd-remote.json`
- 加 routing nonce header
- 固定 remote port
- fail closed

此外，Pi extension 运行在：

```text
~/.pi/agent/extensions/clawd-on-desk/
```

而 Remote SSH identity 默认位于 Claude hooks dir。Pi 进程不会继承 Deploy 命令的 `CLAWD_REMOTE_*` 环境变量。

因此需要**复制同一个既有 identity 文件（不是创建新 schema）**到 extension 目录：

```text
~/.pi/agent/extensions/clawd-on-desk/
├── index.ts                    # pi-extension.ts
├── pi-extension-core.js
├── server-config.js             # reused, self-contained secure transport
├── clawd-remote.json            # exact copy, 0600
└── .clawd-managed.json          # ownership marker
```

Pi extension 将调用同目录 `server-config.js` 的 `postStateToRunningServer()`。

```text
没有 clawd-remote.json → 当前 local mode（runtime port + fallback scan）
有有效 clawd-remote.json → secure remote mode（fixed port + nonce）
identity 不可读/非法      → 不发送、不回退扫描
```

### 为什么 identity copy 是安全的

- 复制在现有 fenced remote lease 内完成。
- 来源是已完成 read-back 验证的 `layout.identityFile`；不要将 nonce 放入命令参数。
- 使用远端 `cp` + temporary file + `chmod 600` + atomic rename。
- nonce rotation 中 ingress 同时接受 transaction 的旧/新 nonce；Pi 读到旧或新 identity 都不会产生中断窗口。

---

## 最小改动面

### A. Pi extension transport（必做）

| 文件 | 改动 |
|---|---|
| `hooks/pi-extension.ts` | 删除自实现的 HTTP port probing；改用同目录 `server-config.js` 的 `postStateToRunningServer()` |
| `hooks/pi-install.js` | 安装/更新时复制 `server-config.js`；remote mode 下验证并原子复制 remote identity；写入 remote ownership marker |
| `hooks/pi-extension-core.js` | 无 remote protocol 改动；继续负责 Pi event → normalized payload |

### B. Remote layout / deploy（必做）

| 文件 | 改动 |
|---|---|
| `src/remote-ssh-layout.js` | 添加 `piAgentDir`、`piExtensionDir`、`piRemoteIdentityFile` 等受验证 POSIX paths |
| `src/remote-ssh-deploy.js` | 把 Pi extension source files 纳入 staging/hash；identity 完成后运行 remote Pi installer；read-back 验证 extension、identity 与 marker；Uninstall/Retire 时 ownership-fenced cleanup |
| `src/remote-ssh-profile.js` | 给 identity transaction 加 `installPi` step，处理旧 persisted transaction 的兼容迁移 |
| `src/remote-ssh-identity.js` | 无 nonce 逻辑改动；沿用现有 transaction / commit |

### C. UI / diagnostics（MVP 后半）

| 位置 | 改动 |
|---|---|
| Remote SSH Settings | 显示 `install-pi` step：installed / Pi not found / unmanaged extension / verification failed |
| Doctor | 远端不应混入 local Doctor；Remote profile deploy log 是权威状态 |
| i18n | 仅新增 Pi deployment 的 status/hint 文案 |

---

## Deployment transaction 如何复用

现有 `secureDeploy()` 已完成：

1. 远端 shell / Node 检测
2. runtime layout 解析
3. ownership preflight
4. fenced deployment lease
5. identity 写入 + read-back
6. secure marker 写入
7. source staging via SCP + hash verification
8. agent installers
9. transaction step verification / commit

Pi 应加入第 8 步，顺序为：

```text
identity → secure marker → hook files → install Claude/Codex/Copilot → install Pi → verify → commit
```

Pi installer的结果必须是三态：

| 结果 | transaction step |
|---|---|
| 远端存在 Pi，managed extension + identity hash read-back 成功 | `done` |
| Pi 尚未安装 / `~/.pi/agent` 不存在 | `not-applicable`，附带原因 |
| existing extension 非 Clawd managed 或 ownership 不匹配 | `failed`，不改用户文件 |

### 旧 profile / transaction 兼容

`REMOTE_IDENTITY_STEP_NAMES` 目前是 persisted schema。直接追加 `installPi` 会令旧的 committed transaction 因缺字段而失效。

兼容策略：

- 已 committed 的旧 txn 缺 `installPi`：sanitize 时补为
  `not-applicable: "pre-pi-remote-deploy"`。
- 进行中的旧 txn 缺 `installPi`：补为 `pending`，强制 Repair 走新 deploy/verify 路径。
- 新 txn：正常包含 `installPi: pending`。

---

## Ownership / cleanup 规则

现有 Pi marker 只有：

```json
{ "app": "clawd-on-desk", "integration": "pi", "managed": true }
```

Remote 部署必须扩展 marker（不含 nonce）：

```json
{
  "app": "clawd-on-desk",
  "integration": "pi",
  "managed": true,
  "remote": {
    "installId": "...",
    "profileId": "...",
    "runtimeKey": "...",
    "layoutVersion": 1
  }
}
```

规则：

- 非 managed extension：绝不覆盖、绝不删除。
- local managed 但无 remote owner：视作 legacy trace；沿用现有 migration confirmation 语义。
- remote owner 不匹配：终止 deployment / cleanup，不碰文件。
- `uninstallRemoteIntegrations()` 调用 Pi installer 的 remote-uninstall 分支；仅 marker 与 identity owner 同时匹配时删除 extension。

## Explicit MVP 限制

- **仅 `account-default` runtime mode**。Pi global extension 位于 `~/.pi`，同一 Unix account 不可同时安全服务多个 profile-isolated runtime。
- 一个 Unix account 只允许一个 active Remote Pi profile；这与现有 account ownership fence 一致。
- Pi 仍是 state-only：不接 Remote PermissionRequest、没有 remote approval bubble。
- existing Pi session 需要重启，才会加载刚部署的 extension。

---

## 测试矩阵

### Unit

1. Pi extension local mode：无 identity 时保持当前 local port discovery。
2. Pi extension remote mode：identity 存在时只请求 `remotePort`，含 nonce header。
3. invalid/missing identity：不扫描 fallback port，fail closed。
4. nonce rotation：old/new identity 均按 expected port/header 发送。
5. Pi installer：managed/unmanaged、identity copy `0600`、atomic write、remote marker owner。
6. profile schema：旧 committed / active txn migration。

### Remote deploy

1. 新 deploy：identity → Pi files → extension/identity hash verify → `installPi=done`。
2. Pi missing：`installPi=not-applicable`，其他 remote agents仍可部署。
3. unmanaged extension：不改文件，明确 deployment failure/diagnostic。
4. Repair：只更新同 owner 的 extension 和 identity。
5. Uninstall：只清理同 owner artifact。
6. profile-isolated：明确 `not-applicable`，不碰 `~/.pi`。

### Manual end-to-end

```text
Windows Clawd + Bridge
  → Remote SSH Deploy / Repair (Pi installed)
  → connect Linux profile
  → start two new remote Pi sessions
  → Dashboard shows host prefix + agent=Pi
  → two independent Windows status-pet windows
  → disconnect → stale/offline behavior
  → reconnect/resume → same stable pet IDs
```

---

## 实施顺序

1. 为 Pi extension 复用 `server-config.js`，先用单测证明 local/remote transport selection。
2. 扩展 Pi installer 的 remote identity/ownership行为。
3. 扩展 layout + profile transaction migration。
4. 将 Pi deploy/verify/cleanup 接入 `secureDeploy()`。
5. 加 Settings progress/i18n。
6. 在当前 Linux host 做真实 Remote SSH 验收。
