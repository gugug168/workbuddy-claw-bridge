# Windows 一键部署脚本：将 workbuddy-claw-bridge 装入 %USERPROFILE%\.workbuddy\
# 说明：
# 1. 仅复制桥接脚本与红线钩子，不自动覆盖你现有的 ~/.workbuddy/settings.json（防破坏现有配置）。
# 2. 可选注册 Windows 计划任务 WorkBuddy-Claw-Bridge，保证对话关闭后本地桥不断连。

param(
  [switch]$RegisterTask
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$WbDir = Join-Path $env:USERPROFILE ".workbuddy"
$BridgeDst = Join-Path $WbDir "claw-bridge"
$HooksDst = Join-Path $WbDir "hooks"

New-Item -ItemType Directory -Force -Path $BridgeDst, $HooksDst | Out-Null

Copy-Item (Join-Path $RepoRoot "claw-bridge\server.mjs") $BridgeDst -Force
Copy-Item (Join-Path $RepoRoot "claw-bridge\mcp.mjs") $BridgeDst -Force
Copy-Item (Join-Path $RepoRoot "claw-bridge\wbctl.mjs") $BridgeDst -Force
Copy-Item (Join-Path $RepoRoot "claw-bridge\start-hidden.vbs") $BridgeDst -Force
Copy-Item (Join-Path $RepoRoot "hooks\redline-guard.py") $HooksDst -Force

Write-Host "[OK] Files copied to:" -ForegroundColor Green
Write-Host "  - $BridgeDst"
Write-Host "  - $HooksDst"

if ($RegisterTask) {
  $NodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $NodeCmd) {
    throw "Node.js not found in PATH. Install Node 18+ first."
  }
  $NodeExe = $NodeCmd.Source
  $ServerPath = Join-Path $BridgeDst "server.mjs"
  $VbsPath = Join-Path $BridgeDst "start-hidden.vbs"

  $Action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$VbsPath`""
  $Trigger = New-ScheduledTaskTrigger -AtLogOn
  $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName "WorkBuddy-Claw-Bridge" -Action $Action -Trigger $Trigger -Settings $Settings -Force | Out-Null
  Start-ScheduledTask -TaskName "WorkBuddy-Claw-Bridge"
  Write-Host "[OK] Registered and started Scheduled Task: WorkBuddy-Claw-Bridge (Node: $NodeExe)" -ForegroundColor Green
}

Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Enable 'wecomaibot' & 'PreToolUse' hook in $WbDir\settings.json (see examples/mcp-configs.md)."
Write-Host "  2. Register 'workbuddy-claw' MCP in Claude Code / Antigravity / Codex (see examples/mcp-configs.md)."
Write-Host "  3. Test CLI: node `"$BridgeDst\wbctl.mjs`" status"
