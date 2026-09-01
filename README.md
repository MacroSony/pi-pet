# Pi Pet

独立运行的 multi-agent desktop pet：把 Clawd 的 session infrastructure 投影为每个 agent session 一只独立 Tauri 桌宠。

## 当前原型

- Clawd 负责 Pi / multi-agent session 生命周期、Remote SSH、稳定身份和状态推导。
- `PetPresentationBridge` 将每个 live Pi session 写成独立 status JSON。
- claude-status-pet 以一 session 一 Tauri 窗口监听对应 status 文件。
- Bridge 默认关闭；详见 [`ARCHITECTURE-AUDIT.md`](ARCHITECTURE-AUDIT.md)。

## 仓库结构

- `clawd-on-desk/` — private mirror submodule，分支 `pi-pet-bridge`
- `claude-status-pet/` — upstream presentation renderer submodule
- `PLAN.md` — 产品计划
- `ARCHITECTURE-AUDIT.md` — 架构、接口与试运行配置

## License

上游 `clawd-on-desk` 与 `claude-status-pet` 都是 AGPL-3.0；其 license/notice 必须保留。该项目在分发前需完成完整的 license review。
