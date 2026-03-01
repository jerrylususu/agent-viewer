# 状态源与回调约定

## 状态模式

每个 Agent 可配置 `status.mode`：

- `heuristic`: 仅使用 tmux 输出启发式判定。
- `file_sentinel`: 优先读取状态文件，失败时回退启发式。
- `webhook`: 优先使用回调状态，未收到回调时回退启发式。
- `hybrid`: 优先级为 `webhook > file_sentinel > heuristic`。

## 文件哨兵格式

### 1) JSON（推荐）

```json
{
  "state": "running",
  "message": "step 2/4",
  "progress": 50,
  "updatedAt": 1772361000000
}
```

`state` 支持：`running`、`idle`、`completed`、`failed`。

### 2) 文本

文本中包含以下关键词时会被识别：

- `failed` / `error` -> `failed`
- `done` / `completed` / `success` -> `completed`
- `idle` / `waiting` -> `idle`
- `running` / `working` / `processing` -> `running`

## 回调接口

- 方法: `POST /api/agents/:name/status-callback`
- Header:
  - `X-Agent-Viewer-Password: <密码>`
  - `X-Agent-Callback-Secret: <callbackSecret>`

请求体示例：

```json
{
  "state": "completed",
  "message": "all done",
  "artifact": "/repo/result.json",
  "updatedAt": 1772361000000
}
```

说明：

- `callbackSecret` 由 `POST /api/agents` 返回。
- 回调状态会写入 registry，并在 SSE 推送中体现在 `statusSource=HOOK`。
- 当状态模式为 `hybrid` 或 `webhook` 时，回调状态优先级最高。
