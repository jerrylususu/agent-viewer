# Agent Profile 配置说明

`agent-viewer` 通过 `config/agents.json` 管理可用 Agent。

## 文件结构

```json
{
  "profiles": [
    {
      "id": "codex",
      "displayName": "OpenAI Codex CLI",
      "command": "codex",
      "defaultArgs": [],
      "detect": {
        "processRegex": "(?:^|/)codex(?:\\s|$)"
      },
      "readiness": {
        "type": "prompt_regex",
        "pattern": "^>\\s*$|^❯\\s*$|^❯\\s+\\S",
        "timeoutMs": 30000
      },
      "status": {
        "mode": "heuristic",
        "filePathTemplate": "${projectPath}/.agent-status.json"
      },
      "systemInitPrompt": ""
    }
  ]
}
```

## 字段说明

- `id`: Profile 唯一标识（小写英文推荐）。
- `displayName`: 前端展示名称。
- `command`: 启动命令，可为 PATH 命令或绝对路径。
- `defaultArgs`: 默认参数数组。
- `detect.processRegex`: 自动发现 tmux 会话时用于识别进程命令行。
- `readiness.type`: 当前支持 `prompt_regex`。
- `readiness.pattern`: 就绪判定正则，命中后才发送初始化 Prompt。
- `readiness.timeoutMs`: 就绪等待超时时间。
- `status.mode`: 支持 `heuristic`、`file_sentinel`、`webhook`、`hybrid`。
- `status.filePathTemplate`: 状态文件路径模板，支持 `${projectPath}`。
- `systemInitPrompt`: Profile 级初始化 Prompt 模板。

## 启动参数覆盖规则

前端或 API 请求可覆盖以下字段：

- `agentBinaryPath`: 覆盖 `command`。
- `agentArgs`: 追加（默认）或替换默认参数。
- `systemInitPrompt`: 覆盖 Profile 默认系统 Prompt。
- `runtimeInitPrompt`: 本次运行附加初始化 Prompt。

最终发送给 Agent 的首条消息顺序：

1. `systemInitPrompt`
2. `runtimeInitPrompt`
3. `prompt`（或 `taskPrompt`）

三段按空行拼接。
