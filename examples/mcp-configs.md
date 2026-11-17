# MCP & WorkBuddy 通道配置示例

> 将下面示例中的 `<USER_HOME>` 替换为你本机的用户目录路径（例如 Windows 为 `C:/Users/你的用户名`，macOS/Linux 为 `/Users/你的用户名`）。

## 1. Claude Code（`~/.claude.json`）

在 `mcpServers` 下加入：

```json
{
  "mcpServers": {
    "workbuddy-claw": {
      "command": "node",
      "args": ["<USER_HOME>/.workbuddy/claw-bridge/mcp.mjs"]
    }
  }
}
```

## 2. Antigravity（`~/.gemini/config/mcp_config.json`）

```json
{
  "mcpServers": {
    "workbuddy-claw": {
      "command": "node",
      "args": ["<USER_HOME>/.workbuddy/claw-bridge/mcp.mjs"]
    }
  }
}
```

## 3. Gemini CLI（`~/.gemini/settings.json`）

```json
{
  "mcpServers": {
    "workbuddy-claw": {
      "command": "node",
      "args": ["<USER_HOME>/.workbuddy/claw-bridge/mcp.mjs"]
    }
  }
}
```

## 4. Codex CLI（`~/.codex/config.toml`）

```toml
[mcp_servers.workbuddy-claw]
command = "node"
args = ["<USER_HOME>/.workbuddy/claw-bridge/mcp.mjs"]
```

## 5. WorkBuddy 本地频道连接（`~/.workbuddy/settings.json`）

在 WorkBuddy「助理」通道设置或 `~/.workbuddy/settings.json` 当前用户的 `channels.wecomaibot` 下启用本地 WebSocket 模式：

```json
"wecomaibot": {
  "enabled": true,
  "connectionMode": "websocket",
  "botId": "local-claw-bridge",
  "botSecret": "local-claw-bridge-secret",
  "customWsUrl": "ws://127.0.0.1:18999"
}
```

> 默认 `botId` 与 `botSecret` 分别为 `local-claw-bridge` 和 `local-claw-bridge-secret`；如自定义，可通过环境变量 `WB_CLAW_BOT_ID` 与 `WB_CLAW_BOT_SECRET` 传给 `server.mjs`。

## 6. WorkBuddy 执行前红线钩子（`~/.workbuddy/settings.json` -> `hooks.PreToolUse`）

```json
"hooks": {
  "PreToolUse": [
    {
      "matcher": "Bash",
      "hooks": [
        {
          "type": "command",
          "command": "python <USER_HOME>/.workbuddy/hooks/redline-guard.py",
          "timeout": 10
        }
      ]
    },
    {
      "matcher": "Write|Edit|MultiEdit",
      "hooks": [
        {
          "type": "command",
          "command": "python <USER_HOME>/.workbuddy/hooks/redline-guard.py",
          "timeout": 10
        }
      ]
    }
  ]
}
```
