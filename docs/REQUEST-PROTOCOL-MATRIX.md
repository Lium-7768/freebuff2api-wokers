# Freebuff CLI 0.0.149 请求协议矩阵

本文只记录当前适配器已经按逆向证据落地的外部请求面。**官方 credentials JSON 不是新的上游协议**，而是唯一的账号池输入；适配器只从 `accounts` 容器读取 `authToken` 与 usage 专用 `fingerprintId`。

| 请求 | 方法 | 认证与 User-Agent | 允许的凭证相关字段 | 关键 body/header 边界 |
|---|---|---|---|---|
| `/api/v1/ads` | POST | `Authorization: Bearer`; `User-Agent: Freebuff-CLI/0.0.149` | 仅 Bearer 来自 `authToken` | body 使用 provider、过滤后的 user/assistant messages、持久 sessionId、运行时 device/userAgent；surface/placementId 可选 |
| `/api/v1/ads/impression` | POST | `Authorization: Bearer`; `User-Agent: Freebuff-CLI/0.0.149` | 仅 Bearer 来自 `authToken` | body 为 `impUrl` 与 agent mode；不携带 fingerprintId |
| `/api/v1/usage` | POST | `Authorization: Bearer` | body 使用账号 credentials 的 `fingerprintId`；缺失时使用观测到的 `cli-usage` fallback | `fingerprintId` 只在此 body 出现，不进入 chat、session 或 agent-runs |
| `/api/v1/freebuff/session` | GET/POST/DELETE | Bearer；session 请求使用 CLI session headers | 不使用 `id`、`name`、`email`、`fingerprintHash` 或 `fingerprintId` | GET 可按证据携带 instance/compact headers；POST 携带 session model；DELETE 为 Bearer-only，不带 instance header |
| `/api/v1/agent-runs` | POST | Bearer；运行请求使用 agent-runs headers | `x-freebuff-acting-user-id` 只在显式设置 `FREEBUFF_ACTING_USER_ID` 时出现 | START/FINISH 的 action、agent/session/run/step 数据按既有 schema 发送；不从 credentials.id 推导 acting user |
| `/api/v1/chat/completions` | POST | Bearer；`User-Agent: ai-sdk/openai-compatible/0.0.149/codebuff` | 不出现 `fingerprintId`、`fingerprintHash`、`name`、`email` 或 credentials.id | `x-freebuff-model`、`x-freebuff-instance-id`、provider data collection 与 CLI metadata 按模型/会话传递 |

## 账号输入映射

| 输入字段 | 运行时用途 | 禁止用途 |
|---|---|---|
| `authToken` | 所有上游请求的 Bearer token，并作为账号去重键 | 不复制到 JSON body 或自定义 fingerprint 字段 |
| `fingerprintId` | 仅 `/api/v1/usage` body | 不加入 header、chat/session/agent-runs body |
| `id` | 仅保留为账号元数据，当前不自动转换为 acting-user header | 不伪造 `x-freebuff-acting-user-id` |
| `name`、`email`、`fingerprintHash` | 当前适配器不使用 | 不加入任何上游请求 |

> 适配器的协议兼容不等于绕过 Freebuff 的账号限制或私有风控；未知服务端字段不会被推断或伪造。

## 参考

1. [协议对比与重构边界](./PROTOCOL-COMPARISON.md)
2. [部署与 secrets 边界](./DEPLOYMENT-CICD.md)
3. 逆向证据仓库：`freebuff_reverse_findings_2026-08-16.md`、`freebuff_reverse_audit_2026-08-16.md`、`freebuff_reverse_final_2026-08-16.md`。
