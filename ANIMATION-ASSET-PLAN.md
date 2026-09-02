# Pi Pet 动画素材方案：status-pet vs. Clawd vs. MiniMax H3

## 1. 结论

当前 status-pet 足以承载 Multi-Pi MVP 的 **10 个语义状态循环动画**，但还不能仅靠换素材达到 Clawd 的完整表现力。

建议分两步：

1. **H3 MVP pack**：生成 10 个统一角色的短循环，转换为透明 animated WebP，直接接入现有 `character.json`。
2. **Renderer v2**：验证画面质量后，再扩展 one-shot transition、idle variation、click/drag reaction 和 animation timing；这些才是接近 Clawd 体验的关键。

## 2. 状态能力对比

### status-pet 当前角色包协议

可直接映射 10 个可视状态：

| 状态 | 用途 |
|---|---|
| `idle` | 等待输入 |
| `thinking` | 模型思考 |
| `reading` | 读文件/网页 |
| `editing` | 编辑/写文件 |
| `searching` | grep/glob/search |
| `running` | shell/其他工具 |
| `delegating` | agent/subagent/task |
| `waiting` | 等待授权/用户 |
| `error` | 工具或 agent 错误 |
| `offline` | 连接中断/休眠 |

`closed` 是窗口关闭控制状态，不是角色包动画。

角色包支持每个状态配置多个素材并随机选择。我们的 fork 支持：

- animated WebP（推荐）
- GIF
- PNG/APNG
- SVG
- `--assets-dir` 外部素材目录
- `character.json` 自定义包

当前局限：

- 每次状态更新只随机选一个素材；没有 idle animation scheduler。
- 没有 transition/one-shot 完成回调与 min-display/auto-return timing。
- 没有 click/drag reaction、eye tracking、工作数量 tier、mini mode。
- character 选择和颜色配置仍是 WebView localStorage 级别，不是完整的 per-session skin 管理器。

### Clawd 自带表现能力

当前 Clawd 主题包含约 48 个 active SVG 素材，协议层包括：

- 16 个 base states。
- 3 个 working tiers、2 个 juggling tiers。
- 3 个 idle variations。
- 5 类 click/drag reactions。
- 9 个 mini-mode states。
- yawn → doze → collapse → wake 睡眠序列。
- per-state min display / auto return。
- eye tracking、hit boxes、accessories、sound。

因此，**10 个 H3 循环可以超过 Ferris 当前静态感，但不会自动等于 Clawd 的交互丰富度**。

## 3. MiniMax H3 适配性

MiniMax 官方 API 文档说明 `MiniMax-H3` 支持：

- text/image/first-last-frame/reference-to-video。
- 768P 或 2K。
- 4–15 秒整数时长。
- 1:1 等常用比例。
- first/last frame 与最多 9 张 reference image。
- 输出 URL 示例为 MP4。

官方文档没有声明透明 alpha 视频输出；MP4 输出也不适合作为透明桌宠素材。因此必须设计后处理流程。

官方参考：

- https://platform.minimax.io/docs/api-reference/api-overview
- https://platform.minimax.io/docs/api-reference/video-generation-v2-create
- https://platform.minimax.io/docs/guides/video-generation

## 4. 推荐生成工作流

### 4.1 角色基准

先制作一张 1:1 character bible：

- 正面或 3/4 视角、全身。
- 角色占画布约 65–75%。
- 固定轮廓、颜色、服装和道具。
- 固定机位、无景深、无镜头运动。
- 使用纯色 chroma 背景，颜色不得出现在角色主体中。
- 四周至少保留 10% 安全边距。

优先使用 H3 reference generation 或 image-to-video；不要分别 text-to-video 生成十次，否则角色一致性会明显下降。

### 4.2 每个状态的动作目标

| 状态 | H3 动作建议 |
|---|---|
| idle | 呼吸、眨眼、轻微摆尾；首尾姿势一致 |
| thinking | 歪头思考、短暂问号/微光，然后回到初始姿势 |
| reading | 看小书/文件，眼睛左右扫动 |
| editing | 在小键盘/笔记本上循环打字 |
| searching | 拿放大镜左右扫描，然后回中 |
| running | 操作终端/拉动控制杆，节奏稍快 |
| delegating | 指挥两个小光点/mini worker 后回中 |
| waiting | 举爪/提示牌，保持警觉但不焦躁 |
| error | 短暂震惊/冒烟，随后维持沮丧姿态 |
| offline | 趴下睡觉，缓慢呼吸和 Z 字循环 |

建议时长：idle/offline 6–8 秒，其余 4–6 秒；24 fps 生成，最终降到 12–18 fps。

### 4.3 通用 prompt 骨架

```text
Use the supplied character reference exactly. A small desktop companion,
full body, centered, fixed orthographic camera, square composition, consistent
silhouette, colors, face, clothing and proportions. Pure #00FF00 flat background,
no gradient, no floor, no cast shadow, no camera movement, no zoom, no crop,
no text, no new objects except the explicitly requested prop.

ACTION: <state-specific action>.
Create a clean seamless loop. The final pose and framing must match the first
frame exactly. Motion stays inside the safe area and remains readable at 140 px.
```

如果角色包含绿色，改用纯洋红 `#FF00FF` 或其他角色未使用的 chroma 色。

可将同一基准图同时作为 first frame 和 last frame，提高循环闭合概率；先以 768P/1:1 快速迭代，最终再选择性生成 2K。

## 5. MP4 → 透明 animated WebP

H3 输出先做 chroma key，再缩放。示例：

```bash
ffmpeg -i h3-idle.mp4 -an \
  -vf "fps=15,colorkey=0x00FF00:0.16:0.06,format=rgba,scale=280:280:flags=lanczos" \
  -c:v libwebp_anim -loop 0 -q:v 82 -compression_level 6 idle.webp
```

需要逐个检查：

- 首尾跳帧。
- 角色轮廓漂移、肢体数量变化。
- chroma spill 和半透明边缘。
- 小尺寸下动作是否仍可读。
- 单文件尽量控制在 2 MB 左右。

若绿幕边缘不稳定，应采用分割/rotoscope，而不是继续增大 `colorkey` 阈值损坏角色边缘。

## 6. 角色包结构

```text
~/.claude/pet-data/characters/h3-companion/
├── character.json
├── idle.webp
├── thinking.webp
├── reading.webp
├── editing.webp
├── searching.webp
├── running.webp
├── delegating.webp
├── waiting.webp
├── error.webp
└── offline.webp
```

```json
{
  "name": "H3 Companion",
  "type": "webp",
  "states": {
    "idle": ["h3-companion/idle.webp"],
    "thinking": ["h3-companion/thinking.webp"],
    "reading": ["h3-companion/reading.webp"],
    "editing": ["h3-companion/editing.webp"],
    "searching": ["h3-companion/searching.webp"],
    "running": ["h3-companion/running.webp"],
    "delegating": ["h3-companion/delegating.webp"],
    "waiting": ["h3-companion/waiting.webp"],
    "error": ["h3-companion/error.webp"],
    "offline": ["h3-companion/offline.webp"],
    "unknown": ["h3-companion/idle.webp"]
  }
}
```

## 7. 验收门槛

第一轮先只生成 `idle`、`thinking`、`editing`、`error`、`offline` 五个动作。满足以下条件再扩成十状态：

- 五段角色身份一致。
- 140 px 下轮廓和动作清楚。
- 循环接缝不明显。
- 透明边缘在浅色和深色桌面都可接受。
- 280×280 animated WebP 平均不超过约 2 MB。
- 同时显示 3–5 只 pet 时 CPU/GPU/内存可接受。

若五状态测试失败，优先改 reference、动作幅度和后处理，不要直接批量生成全部状态。
