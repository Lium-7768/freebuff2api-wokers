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
| 普通请求默认执行报告确认的 ads/usage；可通过 `FREEBUFF_CLIENT_BEHAVIOR=off` 关闭 | Freebuff 默认 `adsEnabled:true` + usage 请求边界 |
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

官方 CLI 使用单个账号；本项目统一使用 `accounts` 容器承载一个或多个账号。多账号轮询是明确的产品扩展，不能称为“完全复刻官方 CLI”。

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
- 浏览器登录、硬件指纹生成和完整 credentials 生命周期管理；适配器只接收显式提供的官方 credentials JSON，并按已确认字段映射到运行时请求。
- 默认启用报告确认的广告副作用；`FREEBUFF_CLIENT_BEHAVIOR=off` 时关闭，`FREEBUFF_CLIENT_BEHAVIOR=cli` 时按报告发送 ads fetch、逐条 impression、creditsGranted 回写、ZeroClick impression 旁路和可调用的 click helper。

Codex 工具仍由 Codex 客户端执行；适配器只负责正确传递 tool call 和 tool result。

## 不能确认的服务端行为

- `0.0.149` 对应的 private 精确 commit。
- 生产环境是否启用了公开源码中的 foreign-client/CF Worker 检测。
- 账号级封禁和私有风控规则。

因此文档和代码都不声称能绕过账号限制，也不伪造没有证据的设备或广告行为。

## 本轮协议对比交付（Freebuff CLI 0.0.149）

本轮对照逆向审计补齐了三项可直接由证据支持的差异。第一，将 CLI User-Agent、`x-freebuff-model`、`x-freebuff-instance-id` 和 chat Authorization/Content-Type 组装集中到协议 helper，避免 session、chat、ads/usage 请求之间发生 header 漂移；fingerprintId 仍不加入普通 chat/session/agent-runs 请求。第二，usage 只使用 `accounts.<key>.fingerprintId`，不再提供缺失字段的 fallback。第三，session admission 的 `waiting_room_queued` 进入正式状态表，已确认 gate 现在按 HTTP 状态和 JSON status 原样返回，带 `Retry-After` 时向下游保留，并且不会错误 fan-out 到其他账号。

本轮新增规范 credentials JSON 映射：每个 `accounts.<key>` 只保留 `authToken` 与 `fingerprintId`；`authToken` 进入 Bearer，`fingerprintId` 仅进入 `/api/v1/usage` body。官方 CLI 的 `id`、`name`、`email`、`fingerprintHash` 不需要复制到 VPS 配置。适配器不再接受传统 `FREEBUFF_TOKEN` 或全局 `FREEBUFF_FINGERPRINT_ID` 配置，避免账号字段脱钩。
报告确认的可选 `x-freebuff-acting-user-id` 只在显式配置 `FREEBUFF_ACTING_USER_ID` 时发送到 agent-runs START/FINISH；adapter 不从 token、fingerprint 或随机值推导 userId。未配置时不会发送该 header。

新增回归覆盖了精确 chat/session headers、usage `cli-usage` fallback、显式 acting-user、以及双账号场景下 session gate 的 terminal 语义。当前仍明确不实现 `/api/v1/token-count`（bundle 只有设计注释，没有可执行 fetch），不移植官方本地工具执行器，也不伪造 credits 或风控字段。

### 主动深度审计补充

本轮主动对照报告再次修复了三个此前未完全落地的事实。第一，session GET 支持报告确认的可选 `x-freebuff-compact-session: 1`，但只有显式设置 `FREEBUFF_COMPACT_SESSION=true` 才发送；默认请求不添加该 header。第二，广告请求的 `sessionId` 现在按 token 在进程内持久复用，或由 `FREEBUFF_CHAT_SESSION_ID` 显式固定，不再每次 prompt 随机生成。第三，广告触发器不再沿用普通 30 分钟 behavior timer，而是按报告的 activity/轮询窗口控制：首个有效 user activity 允许 fetch，后续至少间隔 60 秒且 activity 仍在 30 秒窗口内，同一 activity 最多三次 fetch。

这些字段只影响报告已有证据支持的客户端请求面；没有把服务端 credits、风控或封禁结果推断为已知，也没有增加 `/api/v1/token-count` 请求。
