#!/usr/bin/env sh
set -eu

# Source-checkout launcher. Defaults are derived from this file and callers may
# override the bridge paths. Deliberately does not install dependencies.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PI_PET_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
CLAWD_DIR=${CLAWD_DIR:-"$PI_PET_ROOT/clawd-on-desk"}
CLAWD_PET_RUNTIME_MODULE=${CLAWD_PET_RUNTIME_MODULE:-"$PI_PET_ROOT/packages/runtime"}
CLAWD_PET_BRIDGE=1
CLAWD_PET_BRIDGE_HIDE_NATIVE_PET=1
CLAWD_PET_BRIDGE_AGENT_IDS=${CLAWD_PET_BRIDGE_AGENT_IDS:-pi}
CLAWD_PET_BRIDGE_STATUS_DIR=${CLAWD_PET_BRIDGE_STATUS_DIR:-"${HOME:-.}/.pi-pet/status"}
CLAWD_PET_BRIDGE_RENDERER_BIN=${CLAWD_PET_BRIDGE_RENDERER_BIN:-"$PI_PET_ROOT/claude-status-pet/pet-app/src-tauri/target/release/claude-status-pet"}
CLAWD_PET_BRIDGE_ASSETS_DIR=${CLAWD_PET_BRIDGE_ASSETS_DIR:-"${HOME:-.}/.claude/pet-data/assets"}
export CLAWD_PET_RUNTIME_MODULE CLAWD_PET_BRIDGE CLAWD_PET_BRIDGE_HIDE_NATIVE_PET
export CLAWD_PET_BRIDGE_AGENT_IDS CLAWD_PET_BRIDGE_STATUS_DIR
export CLAWD_PET_BRIDGE_RENDERER_BIN CLAWD_PET_BRIDGE_ASSETS_DIR

if [ ! -e "$CLAWD_PET_RUNTIME_MODULE" ] && [ ! -f "$CLAWD_PET_RUNTIME_MODULE/index.js" ]; then
  printf '%s\n' "ERROR: Pi Pet runtime module was not found: $CLAWD_PET_RUNTIME_MODULE" >&2
  printf '%s\n' "Set CLAWD_PET_RUNTIME_MODULE to the absolute packages/runtime directory." >&2
  exit 1
fi
if [ ! -x "$CLAWD_PET_BRIDGE_RENDERER_BIN" ]; then
  printf '%s\n' "ERROR: renderer binary was not found or is not executable: $CLAWD_PET_BRIDGE_RENDERER_BIN" >&2
  exit 1
fi
if [ ! -d "$CLAWD_DIR" ]; then
  printf '%s\n' "ERROR: Clawd directory was not found: $CLAWD_DIR" >&2
  exit 1
fi

cd "$CLAWD_DIR"
exec npm start -- "$@"
