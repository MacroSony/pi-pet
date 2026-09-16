# Gathering 睡前收尾报告

## 范围与结论

按用户批准，只做独立复审、已确认边界修复/补测、明天的 Windows 操作清单。**没有开启 FIFO/M3c.4，没有改 Windows 环境、Pi 权限或 hooks，也没有新增 GUI 功能。**

复审基线：root `f51436c`、Clawd `4bd58a3f`、renderer `733000d`。Terra 以 `NIGHT-GATHER-REVIEW-06` 做只读复审；父代理复现、修改并验收。本次未调用 DeepSeek。

## 一处已复现并修复的缓存淘汰边界

位置：`packages/runtime/gathering-scene.js` 的 `prune()` / `report()`。

- 几何报告超过 128 条时，原代码只删除最旧报告，没有像 TTL 淘汰那样取消该 pet 的当前 scene 参与资格。
- 复现：先让 p1/p2 集合，保持 p2 较新，再填入其他窗口报告使 p1 被容量淘汰。p1 随后重新报告，仍会拿到旧 scene，而不是等待下一次显式 Gather。
- 父代理先加回归测试，原代码下确实失败；再让容量淘汰也调用 `cancelParticipant`，并在当前插入调用内执行容量上限，不等下一次请求。
- 回归覆盖：被淘汰成员不能靠新报告重入；未淘汰成员继续保留；新的显式 Gather 才允许重新参与。

这是高数量报告缓存下的生命周期缺陷，不是本轮两到四只 GUI smoke 的失败。未增加新的调度、身份或权限机制。

## 另一处补测（没有发现对应生产缺陷）

新增全新 coordinator 实例测试：沿用同一 Team、native instance 和后续报告，也不会恢复旧 scene；End 返回无活动集合，显式 Start 才创建新的 scene ID。此前已有 native instance 替换测试和真实 coordinator 重启 smoke，这次补齐纯状态机回归。

独立复审未确认其他新的取消、重启或 settled persistence 缺陷；这不是 Windows 已通过或不存在剩余缺陷的保证。

## 验证

| 范围 | 本轮结果 |
|---|---|
| root 全量 | 420 / 420 |
| Clawd 全量 | 9,523 pass / 52 skip / 0 fail |
| renderer JS | 89 / 89 |
| renderer Rust | 128 / 128 |
| 两个 submodule | 未修改，继续锁定上述 commit |

本次没有重新跑 Linux GUI 或构建新 renderer；native source 未动，前一轮 production build/三窗口 smoke 证据保持原范围。新增生产变更是 coordinator 加载的 neutral runtime 小修。

开发机日志：`/tmp/pet-gather-night-red.log`（修前失败）、`/tmp/pet-gather-night-green.log`（修后通过）、`/tmp/pet-gather-night-{root,clawd,ui,rust}.log`。

## 明天从这里开始

[Windows 更新与分层验收清单](GATHERING-WINDOWS-ACCEPTANCE.md)：CMD 命令、匹配版本/构建、两只本地 → 四只/remote-backed → 混合 DPI、负坐标与视觉。

同步纠正了 README 中“Gathering 尚未实现”和“membership 尚待真机”的旧文字。Windows 手势/焦点/DPI 和长提示气泡仍明确待验，没有借本轮复审提前封板。
