# Freebuff CLI 0.0.149 与当前适配器协议对比

## 结论

当前适配器的 Freebuff DeepSeek 核心链路已经按照逆向报告完成第一轮逐项对齐。当前交付重点不是复制完整 CLI，而是确保 VPS adapter 的 session、agent run、prompt transport、SSE 和错误状态与官方可观察 wire contract 一致。

| 协议项 | 官方 CLI 证据 | 当前实现 | 状态 |
|---|---|---|---|
| Chat User-Agent | `ai-sdk/openai-compatible/0.0.149/codebuff` | 集中常量并用于 chat/兼容行为 | 已对齐 |
| Chat instance | `x-freebuff-instance-id` | chat、session GET/DELETE 使用统一 helper | 已对齐 |
| Session model | POST 使用 `x-freebuff-model`，空 body | 已保持空 body | 已对齐 |
| Fingerprint | 不属于普通 chat/session/agent-runs header | 不加入普通 prompt 请求 | 已对齐 |
| Usage fallback | body 中 fingerprint 默认 `cli-usage` | 显式值优先，否则 `cli-usage` | 已修复 |
| Agent START/FINISH | Bearer；可选 `x-freebuff-acting-user-id` | 仅显式 `FREEBUFF_ACTING_USER_ID` 时发送 | 已对齐 |
| Session gates | 需同时匹配 HTTP status 与 JSON status | 包含 `waiting_room_queued`，terminal 原样返回 | 已修复 |
| Retry-After | 公开的 retryAfterMs 可用于等待提示 | 429 gate 向下游发送秒级 `Retry-After` | 已对齐 |
| Payload metadata | instance、trace、run、client、cost、step | 已发送 | 已对齐 |
| SSE | tool-call、usage、DONE、invalid JSON、top-level error | 已严格解析并测试 | 已对齐 |
| token-count | 只有 bundle 设计注释，未发现可执行 fetch | 不伪造请求 | 有意不实现 |
| 官方本地工具 | CLI 本地执行，不是 VPS 上游 prompt 必需链路 | adapter 只传递 tool call/tool result | 架构边界 |

## 已修复的关键差异

当前重构集中化了协议 header 构造，避免 session、chat、ads/usage 的 header 漂移；修复了 usage 默认 fingerprint；补齐了 `waiting_room_queued` admission state；并阻止已确认的 session gate 在多账号池中错误 fan-out。可选 acting-user 只接受显式部署配置，不从 token、fingerprint 或随机值推导。

## 明确不做的推断

当前代码不自行添加 fingerprint 到普通 chat；不生成硬件指纹；不伪造 credits；不实现没有可执行证据的 token-count 请求；不把官方 CLI 的本地工具执行器搬进 VPS；不将本地 mock 结果解释为真实账号风控或封禁保证。

## 回归结果

本轮代码应通过 `npm test`、`npm run test:e2e`、`npm run audit:protocol`、`node --check worker.js` 和 `git diff --check`。真实账号和 VPS 验证必须在代码审查、提交和用户明确确认后单独进行。

## 广告模块补全（本轮）

广告模块保持显式 opt-in：只有 `FREEBUFF_CLIENT_BEHAVIOR=cli` 才触发，以避免 VPS 默认请求改变账号行为。启用后，适配器发送 `/api/v1/ads`，使用 `provider`、消息历史、持久进程内 `sessionId`、Linux device、静态 Chrome 124 `userAgent` 和 `Freebuff-CLI/0.0.149` header；消息仅保留 user/assistant 的非空 text，并排除 `INSTRUCTIONS_PROMPT`。

响应处理现在会回填缺失的 provider，逐条发送 `/api/v1/ads/impression`，使用 `mode`，并将服务端 `creditsGranted` 写回对应广告对象。对于 `zeroclick` 且存在 `impressionIds` 的响应，额外发送无 Authorization 的 `https://zeroclick.dev/api/v2/impressions`。`trackAdClick` 按报告使用 `/api/v1/ads/click`，仅提交 `impUrl` 和可选 `surface`，失败只返回 false 并在 debug 模式记录，不阻断对话。

仍未伪造 inline slot telemetry 或广告创意字段完整 schema：当前 VPS adapter 没有官方 TUI 的 AI 顶层消息、parentId 和 `metadata.allowInlineAds` UI 状态，也没有客户端广告展示界面；报告将这些字段标为 CLI UI 行为，不是普通 DeepSeek prompt 必需请求。

## 主动深度审计补充（本轮）

对照报告重新扫描调用点后，确认并修复：`x-freebuff-compact-session` 只作为 session GET 的显式 opt-in header；agent-runs START/FINISH 的 `x-freebuff-acting-user-id` 只接受 `FREEBUFF_ACTING_USER_ID`；ads sessionId 按 token 持久化；ads activity/轮询不再复用普通 behavior timer。测试 mock 同步记录全部请求 headers，新增 acting-user 回归断言。

## 逐请求字段复核（追加）

本轮按报告逐项校验后修复了四项参数差异：无 model 请求的 `selectedModel` 默认改为 `deepseek/deepseek-v4-pro`；session GET 在已有本进程 instanceId 时发送 `x-freebuff-instance-id`，并可与 `x-freebuff-compact-session: 1` 合并；ads device 的 locale/timezone 改为运行时 `Intl` 值；ads body 支持报告中的可选 `surface` 与 `placementId`。同时将 ads/usage 的默认行为从适配器自定义关闭改为 Freebuff 默认启用，显式 `off` 才停止这些请求。
