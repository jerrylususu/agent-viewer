# Agent Viewer

基于 tmux 的多 Agent 看板。你可以在一个 Web 页面里创建、观察、交互和清理多个 CLI Agent 会话。

## 主要能力

- 多 Agent Profile：不再绑定 Claude，可切换 `claude/codex/opencode` 或自定义可执行路径。
- 自定义启动参数：支持附加参数、状态模式、状态文件路径。
- 初始化 Prompt 组合：支持 `systemInitPrompt + runtimeInitPrompt + prompt`。
- 状态多源判定：支持 `heuristic / file_sentinel / webhook / hybrid`。
- 全 API 密码保护：前端本地保存密码，后端统一校验；SSE 也受保护。
- 保留 tmux 可接管能力：随时 `tmux attach` 人工介入。

## 运行要求

- Node.js 18+
- tmux
- 至少一种 Agent CLI（如 `claude`、`codex`、`opencode`）

## 安装

```bash
npm install
```

## 启动

```bash
AGENT_VIEWER_PASSWORD='your-password' npm start
```

可选环境变量：

- `HOST`：默认 `0.0.0.0`
- `PORT`：默认 `4200`
- `AGENT_VIEWER_PASSWORD`：API 访问密码（建议强制设置）

## 配置文件

- Agent Profile: `config/agents.json`
- 运行时 registry: `.agent-registry.json`

详细说明见：

- `docs/AGENT_PROFILE.md`
- `docs/STATUS_HOOK.md`
- `docs/SECURITY.md`

## API 概览

- `GET /api/agent-profiles`：读取可用 Agent Profile
- `GET /api/agents`：查询全部 Agent
- `POST /api/agents`：创建 Agent
- `POST /api/agents/:name/send`：发送消息/重启后发送
- `POST /api/agents/:name/status-callback`：外部回调状态
- `GET /api/events`：SSE 实时更新

所有 `/api/*` 请求都必须提供密码：

- 普通请求：`X-Agent-Viewer-Password`
- SSE：`/api/events?password=...`

## 本地测试建议

推荐使用本机安装的 `codex` 或 `opencode` 做冒烟测试：

1. 创建 Agent（可自定义二进制与参数）
2. 发送消息并观察状态变化
3. 测试状态回调接口与文件哨兵
4. 测试密码错误时的 401 行为
