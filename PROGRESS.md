# CodeNomad - Development Progress

## Version: 0.15.27 (dev branch)

## Completed (0.15.11 - 0.15.27)

- [x] **0.15.11** Fork + npm publish + CI workflows
- [x] **0.15.12** Fix: 消息消失（禁用过度 eviction）
- [x] **0.15.13** Fix: tab 拖拽敏感度（自定义传感器 500ms/20px）
- [x] **0.15.14** Fix: 模型选择器移动端适配（fitViewport + min-width）
- [x] **0.15.15** Fix: 禁用启动时自动恢复 workspace
- [x] **0.15.16** Fix: tab 指示灯状态不更新（compacting guard + SSE 重连刷新）
- [x] **0.15.17** Fix: workspace resume 后 SDK 客户端重建 + idle 30 分钟
- [x] **0.15.18** Fix: loadMessages 自动恢复 session
- [x] **0.15.19** Fix: SSE 事件流中断 + client null + resume 错误提示 + fetchSessions 恢复
- [x] **0.15.20** Fix: SSE 重连去重 + hydrate 去重 + session.deleted + batch() + resume 回滚 + SSE 流竞态
- [x] **0.15.21** Test: 84 个单元测试 + CI 集成测试修复 + test script
- [x] **0.15.22** Test: 新增 auth/connection/event 单元测试（123 个） + CI 集成测试扩展
- [x] **0.15.23** Fix: 全局 error handler + 异步 IO + 空 catch 日志 + /api/health
- [x] **0.15.24** Fix: workspace 未就绪时代理等待（waitForInstanceReady）
- [x] **0.15.25** Fix: ECONNREFUSED 自动恢复（suspend + resume）
- [x] **0.15.26** Fix: 所有 socket 错误（UndiciSocketError 等）都触发恢复
- [x] **0.15.27** Feat: Auto-Continue 自动续跑（服务端监听 + 5 秒确认 + prompt_async）

## In Progress

- [ ] Auto-Continue 测试补充
- [ ] 跨会话通信测试

## Recently Completed

- [x] **0.15.28** Feat: 跨会话通信（Cross-Session Messaging）
  - [x] Server 端: `packages/server/src/plugins/cross-session.ts` — 跨 workspace 查找 + prompt_async 转发
  - [x] Plugin 端: `packages/opencode-config/plugin/lib/cross-session.ts` — list_sessions + send_message 工具
  - [x] 注册工具到插件 + 注册路由到 HTTP server
- [x] **0.15.29** Refactor: 简化跨会话消息格式，减少 token
- [x] **0.15.30** Enhance: 增强跨会话通信
  - [x] list_sessions 返回项目名 + 主会话 + 描述（过滤子任务，每项目限5条）
  - [x] 通信记录追踪（谁→谁、话题、时间，最近100条）
  - [x] chat.message hook 自动注入通信历史到 AI 上下文
  - [x] get_communication_history 工具供 AI 主动查询
  - [x] GET /cross-session/history API 端点

## Backlog

- [ ] Dockerfile + docker-compose
- [ ] E2E tests (Playwright)
- [ ] 超大文件拆分（6 个 >1000 行）

## CI Status

- **test-fixed-port**: 启动 + 登录 + Auth lifecycle + Workspace API + SSE
- **test-port-fallback**: 端口回退 + 登录
- **build-test**: Build + TypeCheck + 123 个单元测试
- **report**: 汇总 + 自动创建 Issue

## Test Stats

- Server: 105 tests (27 suites)
- UI: 18 tests (7 suites)
- Total: 123 tests, 0 failures

## KB References

- [需求：跨会话通信](kb_read:r9t4svnlvt)
- [需求：自动续跑](kb_read:v2ni4a4quu)
