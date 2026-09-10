# 审查包：pi-pet Phase B（agent→pet 表达，本地+远程）

> 2026-09-09 · 审查人：子涵 · 编制：咪咔
> 预期阅读时间：**~8 分钟**。只第 ③ 节是代码原文，其余是导航。

## ① 一句话意图

让 agent 通过 `pet_express(text?, emotion?)` 对自己的桌宠发文字/表情：本地直写 event 文件，远程走 clawd 既有 SSH 转发 ingress；renderer file-watch 播放。全部改动**未 commit**，零生产部署。

## ② 风险分级清单

图例：🔴 信任边界（必读） · 🟡 接线/触碰既有行为（选读） · ⚪ 自包含新模块或测试文档（有测试背书，可跳）

### root（pi-pet 主仓）

| 文件 | 级别 | 说明 |
|---|---|---|
| `packages/runtime/interaction.js`（新，415 行） | 🔴→只读路径安全部分 | 验证+petId+落盘+去重+GC。核心逻辑有 §8 八场景测试背书 |
| `packages/pi-extension/index.js`（新，388 行） | 🔴→只读分流/远程部分 | 工具注册无风险；风险在 fallback 条件与 HTTP POST |
| `packages/runtime/index.js` / `index.d.ts`（+92） | ⚪ | 纯导出 |
| `package.json`（+1 行） | ⚪ | 测试脚本加路径 |
| `packages/runtime/test/*`（新 ×2）、`pi-extension/test/*` | ⚪ | 测试本身 |
| `docs/drafts/*` | ⚪ | 契约草稿 + 本包 |

### claude-status-pet（renderer）

| 文件 | 级别 | 说明 |
|---|---|---|
| `pet-app/src-tauri/src/lib.rs`（+302/-…） | 🔴→只读 `resolve_event_path` | Rust 事件 watch；cargo 54/54 背书其余 |
| `pet-app/src/app.js`（+199/-…） | 🟡 | 播放接线，复用既有 reaction 语义；npm 19/19 背书 |
| `pet-app/src/pet-events.js`（新，~200 行） | ⚪ | 纯函数解析器，19 个单测直接背书 |
| `index.html` / `style.css` / `package.json` | ⚪ | +1 script 标签、bubble 样式放宽（见 ③-5）、测试脚本 |

### clawd-on-desk（上游 fork，patch 化敏感区）

| 文件 | 级别 | 说明 |
|---|---|---|
| `src/remote-ssh-ingress.js`（+4/-2） | 🔴 必读 ③-1 | nonce 门唯一改动 |
| `src/server.js`（+8） | 🔴 必读 ③-2 | dispatcher 唯一新分支 |
| `src/server-route-pet-expression.js`（新，205 行） | 🟡 选读 | 自包含 handler，13 个 focused 测试背书 |
| `test/pet-expression-route.test.js` | ⚪ | 测试本身 |

## ③ 必读 hunk（全部信任边界，共 ~40 行）

### ③-1 clawd nonce 门（`remote-ssh-ingress.js`）

```diff
-    const nonce = pathValue || queryValue || headerValue;
+    const isPetExpression = req.method === "POST" && req.url === "/pet-expression";
+    const nonce = isPetExpression ? headerValue : (pathValue || queryValue || headerValue);
     const allowedPath = (req.method === "GET" && req.url === "/state")
       || (req.method === "POST" && req.url === "/state")
-      || (req.method === "POST" && (req.url === "/permission" || !!pathValue || !!queryValue));
+      || (req.method === "POST" && (req.url === "/permission" || !!pathValue || !!queryValue))
+      || isPetExpression;
```

审查点：新路径只收 header nonce（path/query nonce 是 /permission 的 legacy）；带 query 的 URL 精确匹配失败 → 404 fail-closed。✅

### ③-2 clawd dispatcher 新分支（`server.js`）

```diff
+    } else if (req.method === "POST" && req.url === "/pet-expression") {
+      handlePetExpressionPost(req, res, { ctx, remoteProfile });
+    } else {
```

审查点：`remoteProfile` 由 ingress 传入（远程=SSH profile；本地 server=null→"local"）。⚠️ **知情点 F2**：本机主 HTTP server（127.0.0.1）上此路径无 nonce——与既有 `/state`、`/permission` 的 loopback 信任模型完全一致，但要你知情确认。

### ③-3 extension 分流条件（`pi-extension/index.js`）

```js
function isIdentityOrSessionRejection(receipt) {
  // 只有这三种 identity 拒绝才 fallback 远程；delivered/schema拒绝/expired/IO失败绝不 fallback
  return reason.startsWith("InvalidPetIdentity")
      || reason.startsWith("UnknownPetIdentity")
      || reason.startsWith("SessionClosed");
}
```

审查点：`expressExpression` 在写任何文件之前先查 session，所以"本地拒→远程发"不存在双投递。✅

### ③-4 runtime 路径安全（`interaction.js`）

```js
function isSafePetId(petId) {
  return typeof petId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(petId) && !petId.includes("..");
}
// expressExpression: isSafePetId 校验(232行) 先于一切 path.join(253行起)
```

审查点：petId 进文件名前必过白名单正则；写盘全部 tmp+rename。✅

### ③-5 renderer bubble 样式（`style.css`）

```diff
+  word-break: break-word;
+  overflow-wrap: break-word;
-  -webkit-line-clamp: 2;
+  -webkit-line-clamp: 4;
```

审查点：agent 文本最长 2000 字符，bubble 上限 4 行截断+断词。样式选择，你可否决。

## ④ 测试与行为证据（这些区域可以不读代码）

| 证据 | 覆盖 |
|---|---|
| root **50/50** | 契约 §8 全八场景、petId 与 adapter 逐字节 parity、extension 本地+远程 6 案例（含 F1 回归断言） |
| clawd focused **31/31** | nonce 拒绝/接受、schema 十连拒、stub 投递、503/413/500、runtime loader 既有行为不回归 |
| renderer npm **19/19** + cargo **54/54** | 事件解析/去重/legacy 兼容、Rust watch/路径解析 |
| **真 loopback**（咪咔亲跑） | extension→nonce 门→路由→runtime→event+receipt 全链；错 nonce 404；双机目录零污染 |
| **未覆盖**（需你 Windows 真机） | SSH 隧道真链路、Tauri 真窗口 bubble 渲染 |

## ⑤ 回滚方法

全部未 commit、无部署：`git checkout -- .`（三仓各自）+ 删除 untracked 清单（root: `packages/pi-extension/`、`packages/runtime/interaction.js`、`docs/drafts/`、两个测试文件；renderer: `pet-events.js`、`test/`；clawd: `server-route-pet-expression.js`、`test/pet-expression-route.test.js`）。30 秒回到原点。

## ⑥ 独立预审 findings

> 预审由咪咔亲自执行（reviewer profile 后端与 antigravity 不兼容、Luna 额度墙、gemini 自审回避原则）。

- **F1（低危，已修）**：远程 fallback 缺 `dedupKey`，POST 超时重试会重复播放。已修：extension 从 `toolCallId` 派生 `tc_*` dedupKey（两处 remoteBody + 测试断言，50/50 绿）。
- **F2（知情确认）**：本机 loopback server 上 `/pet-expression` 无 nonce，与既有 `/state` 一致。认可现状 or 加 nonce，你定。
- **F3（可接受）**：renderer `resolve_event_path` 信任 status 文件名里的 petId（launcher 侧 `assertSafeSessionId` 已消毒），低风险，知情即可。

** verdict：SHIP-WITH-FIXES → F1 已修完，现为 SHIP。**
