# Pi Pet

One desktop pet per agent session. Clawd supplies session infrastructure; Pi Pet owns the presentation runtime; Tauri renders each pet.

一个 agent session 一只桌宠。当前优先验证 Pi（本地 / SSH 远程），其他 harness 可显式启用，但不代表双向聊天已经支持。

```text
Harness hooks / extensions → Clawd sessions + Remote SSH
                                      ↓ thin loader
                  packages/runtime/adapters/clawd.js
                                      ↓ PetStatus
                         packages/runtime/runtime.js
                                      ↓ status files
                            Tauri desktop pets × N
```

## What works

- Stable per-session identities, including remote profiles.
- Tool/activity display, independent windows, animation transitions and local reactions.
- Presentation-write deduplication, disconnect/reconnect handling and renderer relaunch rules.
- A versioned, dependency-free CommonJS runtime and TypeScript contracts in **this repository**.
- Clawd keeps its hooks, session state machine and SSH transport; its Pi Pet bridge is only a trusted-operator loader.

**Not implemented here:** agent notification tools, message bubbles/TTS, desktop-to-agent input, position-query or movement tools. The renderer has a local reaction CLI; its `message` and `speak` fields remain reserved. See [the exact boundary contract](docs/BOUNDARY-CONTRACT.md).

## Source checkout

```sh
git clone --recurse-submodules https://github.com/MacroSony/pi-pet.git
cd pi-pet
npm test
```

Node.js 22.12+ is required. Root tests have no npm dependencies, but require the pinned Clawd submodule checkout. Build/run additionally requires Rust, the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/), and dependencies in each submodule:

```sh
npm ci --prefix clawd-on-desk
npm ci --prefix claude-status-pet/pet-app
cd claude-status-pet/pet-app
npm run build
```

Then, from the root checkout:

```powershell
# Windows
.\scripts\run-with-bridge.bat
```

```sh
# Linux / macOS source-checkout launcher (GUI environment required)
./scripts/run-with-bridge.sh
```

The old `clawd-on-desk/run_with_bridge.bat` forwards to the root launcher. Launchers do not install dependencies or rebuild the renderer. Default assets/settings remain under `~/.claude/pet-data`; use your existing local character assets or the renderer's documented character setup. This repository does not distribute the experimental generated character packs.

Optional environment overrides:

| Variable | Default / meaning |
|---|---|
| `CLAWD_PET_BRIDGE_AGENT_IDS` | `pi`; comma-separated explicit harness allowlist |
| `CLAWD_PET_BRIDGE_STATUS_DIR` | `~/.pi-pet/status` |
| `CLAWD_PET_BRIDGE_RENDERER_BIN` | renderer's local release build |
| `CLAWD_PET_BRIDGE_ASSETS_DIR` | `~/.claude/pet-data/assets` |
| `CLAWD_PET_RUNTIME_MODULE` | absolute `packages/runtime` directory, set by launcher |

Manual Clawd launches must explicitly set `CLAWD_PET_BRIDGE=1` and `CLAWD_PET_RUNTIME_MODULE`. With the bridge disabled, Clawd does not load or require the parent runtime. With it enabled, a missing/incompatible runtime is an explicit startup error—not a silent fallback.

## Updating

```sh
git pull --ff-only
git submodule update --init --recursive
```

Use the **pinned submodule commits**, not `git submodule update --remote`. Re-run submodule dependency installation when lockfiles change; rebuild the renderer when its source changes. Do not use upstream binary/plugin updaters to replace this fork's renderer.

## Repository boundaries

| Location | Owner / purpose |
|---|---|
| `packages/runtime/` | Pi Pet core, Clawd compatibility mapping and versioned contracts |
| `scripts/` | Pi Pet source-checkout launchers |
| `clawd-on-desk/` | [Clawd integration fork](https://github.com/MacroSony/pi-pet-clawd), branch `pi-pet-bridge` |
| `claude-status-pet/` | [Renderer fork](https://github.com/MacroSony/pi-pet-status-pet), branch `pi-pet-mvp` |
| `docs/BOUNDARY-CONTRACT.md` | Implemented interface and migration details |
| `docs/PUBLICATION.md` | Validation scope, publication checks and known limitations |

The package's `private: true` prevents accidental **npm publication**; it does not make this GitHub repository private.

Historical design notes: [plan](PLAN.md), [architecture audit](ARCHITECTURE-AUDIT.md), [remote Pi design](REMOTE-PI-DESIGN.md), [animation experiments](ANIMATION-ASSET-PLAN.md). They are not a statement that every planned feature is implemented.

## License and attribution

Source code is **AGPL-3.0-only**, including the extracted bridge derived from the Clawd integration fork. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md). Upstream licenses and asset notices remain in both submodules. Character artwork, externally downloaded assets and model weights have their own terms; the code license does not grant rights to them.
