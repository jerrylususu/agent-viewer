
参考文档
/home/jerrylu/code/260301-agent-kanban-compare/agent-viewer-plan.md

对这个项目做改造

（你可以阅读另一个文件夹下的一些其他md来获得更多背景信息）

自己拆阶段一个个完成（可能需要多agent避免上下文过载？）
可以自己拆到 task.md （大阶段+具体任务）
每完成一个事情，更新进展到 progress.md（简要，一句话，仅追加）
一个阶段完成之后，测试，完成后提交到分支（不要动主分支）
所有文档都用中文

测试的时候，可以用当前已安装的 opencode / codex 来做测试





# 改造任务分解（执行中）

参考文档：`/home/jerrylu/code/260301-agent-kanban-compare/agent-viewer-plan.md`

## 阶段 1：基础框架改造（后端）
- [x] 新增 Agent Profile 配置文件，支持多 Agent 定义与读取。
- [x] `POST /api/agents` 扩展参数：`agentId`、`agentBinaryPath`、`agentArgs`、初始化 Prompt 字段。
- [x] 启动流程从写死 `claude` 改为“profile + 请求覆盖”解析。
- [x] 发现机制从 `hasClaudeDescendant` 改为通用 `hasAgentDescendant`。
- [x] 引入命令参数化执行（减少 shell 拼接），并保留现有功能兼容。

## 阶段 2：状态源插件化
- [x] 在 registry 中增加 `statusMode/statusSource/statusFilePath/callbackSecret` 等字段。
- [x] 支持 `heuristic/file_sentinel/webhook/hybrid` 状态模式。
- [x] 新增 `POST /api/agents/:name/status-callback` 接口。
- [x] 将状态判定优先级改为 `webhook > file > heuristic`。
- [x] API 返回中补充状态来源和状态细节字段。

## 阶段 3：密码校验与前端接入
- [x] 后端新增统一密码校验中间件，覆盖全部 `/api/*`（含 SSE）。
- [x] 前端增加密码输入弹窗与 `localStorage` 持久化。
- [x] 所有请求统一走带密码的封装；SSE 改为 query 参数鉴权。
- [x] Spawn 弹窗增加 Agent 配置字段与高级初始化 Prompt 字段。
- [x] 卡片增加状态来源标识，支持 `failed` 状态呈现。

## 阶段 4：文档、测试与提交
- [ ] 补充中文文档（Profile、状态回调/文件约定、配置说明）。
- [ ] 完成端到端冒烟测试与关键 API 自测（含鉴权与状态回调）。
- [ ] 按阶段提交到当前功能分支，不改动主分支。

