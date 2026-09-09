@echo off
setlocal EnableExtensions

REM Root launcher. Every default path is derived from this file, not the caller's cwd.
for %%I in ("%~dp0..") do set "PI_PET_ROOT=%%~fI"
set "CLAWD_DIR=%PI_PET_ROOT%\clawd-on-desk"
if not defined CLAWD_PET_RUNTIME_MODULE set "CLAWD_PET_RUNTIME_MODULE=%PI_PET_ROOT%\packages\runtime"

set "CLAWD_PET_BRIDGE=1"
set "CLAWD_PET_BRIDGE_HIDE_NATIVE_PET=1"
if not defined CLAWD_PET_BRIDGE_AGENT_IDS set "CLAWD_PET_BRIDGE_AGENT_IDS=pi"
if not defined CLAWD_PET_BRIDGE_STATUS_DIR set "CLAWD_PET_BRIDGE_STATUS_DIR=%USERPROFILE%\.pi-pet\status"
if not defined CLAWD_PET_BRIDGE_RENDERER_BIN set "CLAWD_PET_BRIDGE_RENDERER_BIN=%PI_PET_ROOT%\claude-status-pet\pet-app\src-tauri\target\release\claude-status-pet.exe"
if not defined CLAWD_PET_BRIDGE_ASSETS_DIR set "CLAWD_PET_BRIDGE_ASSETS_DIR=%USERPROFILE%\.claude\pet-data\assets"

if not exist "%CLAWD_PET_RUNTIME_MODULE%" if not exist "%CLAWD_PET_RUNTIME_MODULE%\index.js" (
  echo ERROR: Pi Pet runtime module was not found:
  echo %CLAWD_PET_RUNTIME_MODULE%
  echo Set CLAWD_PET_RUNTIME_MODULE to the absolute packages\runtime directory.
  exit /b 1
)
if not exist "%CLAWD_PET_BRIDGE_RENDERER_BIN%" (
  echo ERROR: claude-status-pet.exe was not found:
  echo %CLAWD_PET_BRIDGE_RENDERER_BIN%
  echo Build it first from claude-status-pet\pet-app with: npm run build
  exit /b 1
)

pushd "%CLAWD_DIR%"
if errorlevel 1 (
  echo ERROR: Clawd directory was not found: %CLAWD_DIR%
  exit /b 1
)

call npm start -- %*
set "EXIT_CODE=%ERRORLEVEL%"
popd
exit /b %EXIT_CODE%
