# 鉴权说明

## 1. 后端密码

服务通过环境变量设置密码：

```bash
AGENT_VIEWER_PASSWORD='your-password' npm start
```

未设置时会使用默认值 `agent-viewer`，仅建议本地临时调试使用。

## 2. 前端行为

- 页面首次访问会弹出密码输入框。
- 密码存储在 `localStorage`（键名 `agent_viewer_password`）。
- 所有 `/api/*` 请求都会自动带 `X-Agent-Viewer-Password`。
- SSE 由于浏览器限制，使用 `?password=` query 参数。

## 3. 受保护范围

所有 `/api/*` 路由均强制校验密码，包括：

- Agent 列表与创建
- 发送消息、上传文件
- 输出查看、目录浏览
- SSE 实时事件
- 状态回调接口
