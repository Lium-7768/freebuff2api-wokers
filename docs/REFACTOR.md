# 逆向后的重构

本文件只记录有二进制、真实运行状态或公开源码证据支持的修改。

## 已完成

| 旧实现 | 当前实现 | 依据 |
|---|---|---|
| base3 agent 使用 base2 opening | 使用 `You are Buffy, the coding agent behind Codebuff.` 和已验证核心提示 | CLI 二进制 + `agents/base3.ts` |
| `client_id` 使用自定义格式 | `Math.random().toString(36).substring(2, 15)` | CLI 二进制内嵌代码 |
| 每个 HTTP 请求都创建新 trace | Responses 的 `previous_response_id` 复用 trace | 官方 `previousRun.traceSessionId` 行为 |
| metadata 缺少 step | 增加 `llm_step_number="1"` | CLI 二进制 + agent runtime 源码 |
| FINISH 固定 `totalSteps=0` | 记录真实 step ledger；Responses 工具续接时复用 run 并累计 `totalSteps` | 真实 run-state + FINISH schema |
| FINISH 没有 `steps` | 发送符合官方 schema 的 step ledger | `sdk/src/impl/database.ts` |
| session timeout 10 秒 | session/run timeout 20 秒 | 官方 CLI 行为 |
| 默认每 30 分钟自动触碰 `/usage` | 改为 `FREEBUFF_CLIENT_BEHAVIOR=cli` 显式启用，并按账号节流 | main 分支行为 + VPS 默认最小副作用 |
| 复用或删除未知 active session | 未知 session 不复用、不删除、不 takeover | 官方 owner 生命周期 |
| 进程退出不清理 | SIGINT/SIGTERM 释放本进程 session | 官方退出 DELETE 行为 |
| 非流式 Chat 丢失拆分工具调用 | 聚合 tool id/name/arguments 并返回 `message.tool_calls` | 官方 SSE 工具分片行为 |
| Responses 丢弃 `function_call` | 转成 assistant tool_calls，再接 tool result | Responses/Chat 结构要求 |
| 无效 SSE 被吞并返回 completed | 返回 protocol error，run 标记 failed | 官方严格流解析行为 |
| 最后一条 SSE 无换行会丢失 | flush decoder 和尾部 buffer | 动态复现 |
| 静态模型目录忽略 limited tier | 所有账号确认 limited 后只显示两个标准模型 | `freebuff-models.ts` |
| 活跃 session 导致账号粘连 | 严格 A→B→C 轮询，每账号独立复用 session | 用户的多账号需求 |
| `rate_limited` 被当成死账号 | token 保持有效，仅按模型冷却 | 上游状态语义 |

## 多账号是项目扩展，不是官方 CLI 行为

官方 CLI 使用单个 credentials/default 账号。本项目保留多账号池是明确的产品需求，不能称为“完全复刻官方 CLI”。

当前实现避免以下问题：

- 一次失败请求重复命中同一个账号。
- 某个 active session 永久抢占全部请求。
- 一个模型的限流错误冻结账号的所有模型。
- 账号冷却到期后仍永久退出账号池。
- 遇到请求结构错误时消耗全部账号。

## 没有实现的 CLI 功能

这些差异是明确保留的架构边界：

- 官方15个工具的本地执行器。
- 官方本地工具执行器；Responses 的客户端驱动 continuation 已实现，VPS 不执行工具本身。
- 完整 run-state/message history 磁盘持久化（当前只在内存保存 Responses continuation 映射）。
- CLI owner 文件、PID 检测和30秒 session polling。
- 浏览器登录、硬件指纹和 credentials 管理。
- 默认关闭的广告请求、展示、impression/click 闭环（`FREEBUFF_CLIENT_BEHAVIOR=cli` 时按 main 分支顺序启用 ads/usage）。

Codex 工具仍由 Codex 客户端执行；适配器只负责正确传递 tool call 和 tool result。

## 不能确认的服务端行为

- `0.0.149` 对应的 private 精确 commit。
- 生产环境是否启用了公开源码中的 foreign-client/CF Worker 检测。
- 账号级封禁和私有风控规则。

因此文档和代码都不声称能绕过账号限制，也不伪造没有证据的设备或广告行为。
