# M3c.3 — Windows 更新与验收清单

状态：**待 Windows 实机验收**。Linux 自动化/三窗口 smoke 已通过，不代表 Windows 原生交互、混合 DPI 或视觉已通过。

本次只验活动区域和显式 Gathering；不加 FIFO、自动漫游、Team 权限或模型编排。完整边界见 [Gathering design](GATHERING-SCENE-DESIGN.md)。

## 1. 更新前：确认 checkout、停止旧展示进程

使用 **cmd.exe**，工作目录：

D:\Programming\pi-pet-m2

```bat
cd /d D:\Programming\pi-pet-m2
git branch --show-current
git status --short
git -C clawd-on-desk status --short
git -C claude-status-pet status --short
```

- Root 应为 `milestone3`。有未知修改/本地提交就先停下来核实；不要 reset、stash、clean 或强推。
- Windows 曾出现 CRLF 导致的假 dirty；先看实际 diff，不能直接覆盖。
- 从托盘退出 **staging Clawd**，再关闭其遗留桌宠，包括 remote-backed pet。必要时在任务管理器确认 executable 路径，仅结束本 checkout 的旧 renderer；不要按进程名批量杀其他环境。
- 保留 Pi/tmux 会话；本次无需重开 Pi，也无需安装 extension 或 Remote SSH **Deploy / Repair Hooks**。

## 2. 拉取匹配版本，测试并构建

确认上一步没有未知改动后：

```bat
git pull --ff-only && git submodule update --init --recursive
git log -1 --oneline
git submodule status
```

使用 root **锁定的** submodule commit，不能用 `git submodule update --remote`。本轮预期 Clawd 为 `4bd58a3f`、renderer 为 `733000d`；root 包含 `f51436c` 及后续夜间收尾修复。submodule status 不应有 `+` 或 `-` 前缀。

下面各段分开执行；任一段失败先保留日志、停止，不把旧 executable 当新版本启动。

```bat
npm test
```

```bat
cd /d D:\Programming\pi-pet-m2\clawd-on-desk
npm test
```

```bat
cd /d D:\Programming\pi-pet-m2\claude-status-pet\pet-app
npm test
```

```bat
cd /d D:\Programming\pi-pet-m2\claude-status-pet\pet-app\src-tauri
cargo test --lib && cargo build --release --features tauri/custom-protocol
```

必须包含 `tauri/custom-protocol`；不拿依赖 dev server 的构建验收。现有依赖已安装时不必重装；仅缺依赖或 lockfile 变化时，在相应 submodule 目录执行 `npm ci`。

新 executable：

D:\Programming\pi-pet-m2\claude-status-pet\pet-app\src-tauri\target\release\claude-status-pet.exe

## 3. 启动：避免旧环境变量指向另一份 renderer

```bat
cd /d D:\Programming\pi-pet-m2
set "CLAWD_PET_RUNTIME_MODULE=D:\Programming\pi-pet-m2\packages\runtime"
set "CLAWD_PET_BRIDGE_RENDERER_BIN=D:\Programming\pi-pet-m2\claude-status-pet\pet-app\src-tauri\target\release\claude-status-pet.exe"
call scripts\run-with-bridge.bat
```

若此前用过 `CLAWD_RUNTIME_CONFIG`、`PI_PET_DATA_DIR` 或 status-dir override，确认它们仍是本次测试的预期位置，不要混用已删除的 smoke 目录。启动后核实展示窗口来自新 executable；不要同时开两份 coordinator。

## 4. 第一轮：单屏、同 DPI、两只本地 pet

用一个真实 active Team；先两只，稳定后再到四只。留一块没有其他 pet/窗口的空区域：首版不做障碍避让或跨 Team 空间分配。

- [ ] 设置：pet 右键 → **Settings → Desktop activity area**。窗口非白屏，标题拖动/边缘 resize 正常；取消或 Escape 不保存，也不改变 pet 位置。
- [ ] Apply：区域完整落在单屏 work area 内，不能覆盖任务栏外界；另一只 pet 打开设置看到同一保存值。编辑器关闭后没有透明窗口挡住鼠标。
- [ ] OCC：A、B 同时打开编辑器；A Apply 后，B 的旧草案 Apply 应报冲突，不能静默覆盖。B 重新打开后再编辑。
- [ ] 容量：先保存一个明显放不下两只的区域，点击 **Gather Team in activity area**；应提示扩大，所有 pet 不动。再扩大至能容纳完整窗口。
- [ ] 集合：两只、再四只，显式 Gather 才入场。座位固定、参与窗口不重叠；边界按完整 native window，不只看宠物图案。区外首次入场可直接定位，区内是短动画。
- [ ] 停止：点击 **End gathering (stay here)** 后保持当前位置，不回集合前位置；Team/Board/三个权限开关不变，无新增模型 turn。也测一次运动中 End，不要求先走完原目标。
- [ ] 拖动：反复从不同区内位置开始集合，尽快按住另一只正在移动的 pet；能够接管。拖出区域、停顿再松手，等待后不被拉回。已到位的 pet 也测一次；只有下一次显式 Gather 才重新入场。
- [ ] 焦点：由 A 发起集合，B/C 的移动不能激活它们、打开 Board 或挪动 Chat。B 的 Chat 输入框聚焦时，A Gather 不应搬动 B、抢走 B 的输入焦点；Chat 失焦后也不自动补入当前队形。
- [ ] 阻塞：native drag、区域编辑器、waiting/error 提示期间对应 pet 不被强搬。短暂取消后不能因旧回包重新动起来。
- [ ] Disable：关闭活动区域后不再接受新集合；手动拖动仍可用，Team/Board 不变。重新配置只恢复可用性，不自动集合。

## 5. 第二轮：生命周期与同桌面的 remote-backed pet

从两只本地扩为 2–4 只，至少一只是 Homelab session 在 Windows 上的展示窗口。只控制 Windows 展示桌面，不操作远端屏幕。

- [ ] 远端展示窗口能参与同一 Team 的显式集合；不需要修改 SSH 路由或额外公网端口。
- [ ] 集合期间让一个测试成员离线/关闭 pet/从 Team remove：受影响成员不继续接受运动，其他成员不重排。结束的是测试展示或成员资格，不误杀 Pi session。
- [ ] 重连/add 回来不自动加入当前 scene；下一次显式 Gather 才纳入。用现有授权做 Team 变更，Gather 不自行授权。
- [ ] 解散测试 Team 后无持续移动/重放；Board 的既有保留策略不变。
- [ ] 重启 coordinator：旧 scene 不恢复，无旧目标补发；目录恢复后可重新显式集合。
- [ ] 正常关闭并重新启动一个 pet：恢复最后停止/手动放下的位置，但不恢复旧 scene。运动中关闭也不能令其他 pet 回位。
- [ ] 位置保存不是动画每帧写盘。默认目录在下面；只观察该 pet 的位置文件，不删除/修改它，也不对正常拖动期间的变化要求逐帧存储。

C:\Users\bruhw\.claude\pet-data\positions

## 6. 第三轮：负原点、混合 DPI 与视觉

- [ ] 将副屏放在主屏左侧/上侧；在其 work area 内设区域，再显式集合。不要把负坐标判成越界。
- [ ] 实测不同缩放，例如 100% ↔ 150%，两个方向都测。窗口跨屏后复查真实 outer rectangle 是否完整在区域内，不以 art 是否可见代替。
- [ ] 改屏幕布局/DPI/工作区或移除保存区域所在屏幕：旧目标失效，不能偷偷换屏继续排队；编辑器提示失效，需要用户 Apply 新草案。
- [ ] 重启时旧位置已离屏，pet 仍可找回；不同 character/自定义缩放下也检查有无截断。
- [ ] Windows native drag/capture 不把 pointercancel 当松手；长按拖动、松手、双击 Chat 互不干扰。
- [ ] 无焦点抢占；动画不明显抖动，间距合适，区域编辑器不留幽灵窗口。
- [ ] 长提示气泡完整可读，不把宠物/标签挤出窗口。Linux 默认窗口已有长提示偏挤的证据，属于待调视觉项，尚未修复。

难以目测的完整窗口边界或 DPI 转换先记 **未验证**，再采样原生几何；截图只是辅助。没有相应显示器条件的项目记 **未测**，不能勾通过。

## 7. 留结果，不扩大修复范围

每条记 `PASS / FAIL / 未测`，附 root/submodule revision、Windows 版本、屏幕布局/缩放、操作顺序与实际现象。出现取消后拉回、越界、焦点抢占或错误成员被移动，先停止重复集合并保留复现。

只截图必要窗口，避免包含聊天、密钥和无关桌面内容；不要整包发送 status、session、runtime config 或 credential 文件。失败时不删状态、不重装 hooks、不强制 reset；按失败点做最小修复，再重测相邻用例。

通过这一关后，才讨论气泡 FIFO、协作动画和视频任务。今晚收尾不替代这张 Windows 清单。
