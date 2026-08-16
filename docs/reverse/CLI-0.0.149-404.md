# Freebuff CLI 0.0.149：`404 No endpoints found` 补充逆向报告

## 执行摘要

本补充报告回答的问题是：官方 Freebuff CLI 0.0.149 遇到 `HTTP 404` 与 `No endpoints found` 时，是否把它视为正常的 Freebuff 协议状态、是否进行专门恢复，以及适配器应否模仿该行为。

**结论：现有证据不支持把 `404 No endpoints found` 视为官方已定义的正常 session gate。**它不在已经验证的 Freebuff gate 集合中；精确二进制样本也不包含该错误文本。与二进制最接近的公开快照则显示：chat 请求的通用 HTTP 失败会被作为错误消息和状态码向上返回，公开代码的可重试 HTTP 状态集合不含 404。因此，最稳妥的“官方答案”是：**它是普通上游 chat 失败，而不是 CLI 协议的成功或受控 admission 状态；公开实现没有为该错误文本定义专用恢复分支。**

先前 VPS 上同一模型从 404 转为 200 的观察，支持它可能是暂时的上游端点可用性/路由分配问题；但该观察来自适配器，不是官方 CLI 对该错误分支的动态运行证据，不能用来声称官方 CLI 会重试或切换模型。

## 范围与样本

| 项目 | 证据 | 说明 |
|---|---|---|
| 精确 CLI 样本 | `/Users/meiyu/.config/manicode/freebuff` | Mach-O 64-bit arm64，SHA-256 为 `fecf6ec876666cc0f60578d0ebcf4bb320e090335fbadc0bec0aebd0780e5a85`。 |
| 原始逆向索引 | `artifacts/reverse/freebuff-cli-0.0.149/{metadata,binary-offsets,runtime-observation}.json` | 与上项 SHA-256 一致。 |
| 公共源码交叉验证 | `CodebuffAI/freebuff` 提交 `d46862b4b2ebf69a1b37e5c5daf9aa37052a61a0` | 该提交在 NPM 0.0.149 之后约 31 小时，**不是**二进制的精确私有源码，只能作为交叉证据。 |
| 底层依赖交叉验证 | `@ai-sdk/provider-utils@3.0.32` | 与公共快照 lockfile 对应；仅用于解释公共代码所调用的失败响应处理器。 |

## 方法

本次仅执行了可逆、最小范围的操作：对精确二进制进行 SHA-256、文件类型和字节级字面量搜索；在固定公开快照中静态定位模型、session、错误分类和重试代码；对已部署适配器进行一次最小请求验证；并尝试在隔离 HOME 与本地 mock 上启动官方 CLI。后者因官方 CLI 检测到已有 live owner 而显示“Freebuff is already running”，随即退出，**没有**执行 Take over，也没有中断或修改用户原有 CLI 会话。

## 已验证事实

| ID | 证据 | 解释 | 置信度 |
|---|---|---|---|
| F-01 | 精确样本 SHA-256 与既有逆向索引一致 | 本次静态检查的本机 `freebuff` 与报告中的 0.0.149 样本是同一二进制。 | 高 |
| F-02 | 二进制偏移 `69288334` 包含 `base3-free-deepseek-flash`；字节搜索命中多个 `deepseek-v4-flash` | 0.0.149 样本明确支持 flash 模型及其 base3 agent。 | 高 |
| F-03 | 精确二进制中未找到字面量 `No endpoints found`、`No endpoint found` 或 `/api/v1/chat/completions` | 该错误文本不是已打包在客户端内的专用文案；不能据此证明它有本地专用处理。 | 高 |
| F-04 | 既有二进制索引与摘要列出的 chat gate 仅包括 428、410、409、429 的具名状态 | `No endpoints found` / HTTP 404 不属于已验证的 Freebuff session gate 协议。 | 高 |
| F-05 | 固定公开快照的 `common/src/constants/free-agents.ts` 将 flash 映射为 `base3-free-deepseek-flash` | 当前适配器的 agentId 与公共快照一致。 | 中 |
| F-06 | 固定公开快照的 `cli/src/utils/freebuff-session-api.ts`：仅将 **session API** 的 404 解释为 `{status: 'none'}` | 该特殊 404 语义仅适用于 `/api/v1/freebuff/session`，不能外推到 chat/completions。 | 中 |
| F-07 | 固定公开快照的 `common/src/types/freebuff-session.ts`：gate 表中无 404；`sdk/src/run.ts` 会把普通 provider 错误的 message/statusCode 返回为 error output | chat 层的未知 404 走通用错误传播，而非具名 gate 恢复。 | 中 |
| F-08 | 固定公开快照的 `sdk/src/error-utils.ts`：`RETRYABLE_STATUS_CODES = {408,429,500,502,503,504}` | 公共 SDK 的 HTTP 重试策略不将 404 标为可重试。 | 中 |
| F-09 | 固定公开快照的 `sdk/src/impl/model-provider.ts`：只把暂时性网络连接异常包装为 `isRetryable: true`；注释说明 `streamText` 仅自动重试可重试 API 调用错误 | 公共代码没有把普通 HTTP 404 重新分类为网络重试。 | 中 |
| F-10 | VPS 适配器的同模型最小请求随后返回 200，且上游 session 为 active、模型为 flash | 这证明当前 token/模型映射/部署路径可用；不是官方 CLI 404 分支的直接证据。 | 高（适配器事实） |

## 官方行为模型

### 1. 模型与 session

官方 0.0.149 样本已确认存在 `base3-free-deepseek-flash`。公共快照也将 `deepseek/deepseek-v4-flash` 映射到同一 agent。对于 **session API**，公共 CLI 在 `GET /api/v1/freebuff/session` 收到 404 时，将其归类为“无 session”（`status: 'none'`）；这是 session 生命周期的专用语义。

### 2. chat/completions 的 404

现有精确二进制证据没有显示 `No endpoints found` 的专用字符串或具名处理分支。公共快照的 `sdk/src/run.ts` 在 provider 调用失败时提取错误消息和状态码，并产生普通 `error` output；它没有将 404 转换为 `waiting_room_*`、`session_*` 或模型 fallback 状态。

因此，**不能把 session endpoint 的 404→none 规则套用到 `/api/v1/chat/completions`**。这两个 endpoint 的 404 语义不同。

### 3. 重试

公共快照把 408、429、500、502、503、504 视为可重试 HTTP 状态；404 不在集合内。它还显式将 socket reset、connection refused 等网络错误包裹为可重试 `APICallError`。该公开策略表明：在该快照中，普通 HTTP 404 默认不是自动重试对象。

> 由于公共快照晚于 0.0.149，F-06 至 F-09 只能用于交叉验证，不能断言二进制 0.0.149 的逐行实现完全一致。不过，精确二进制中缺少 `No endpoints found` 专用文本，且已验证 gate 协议中没有 404，使“该 404 是官方专用可恢复 gate”的假设缺乏支持。

## 动态验证状态

已经建立只监听本机的 mock server，可依次模拟 session、agent-runs 以及 chat 404；并以复制的 credentials 和隔离 HOME 启动了精确官方二进制。官方单实例保护发现已有 live CLI owner，显示 Take over/Exit 提示。为了不影响现有用户会话，本次选择 Exit，未触发 chat 404。

所以，以下问题仍未被精确二进制的动态实验直接回答：

1. 0.0.149 收到 chat 404 后是否在更高层 TUI 中额外重试；
2. 404 是否会触发模型 fallback；
3. 404 是否会删除或重建本地 Freebuff session。

它们的当前置信度为**低**，不应作为已确认官方行为写入适配器。

## 结论与适配器影响

### 已确认的结论

1. `deepseek/deepseek-v4-flash` 是官方 0.0.149 的有效模型/agent 组合。
2. `HTTP 404 No endpoints found` 不是已验证的 Freebuff session gate，也不是 session API 的“无 session”规则可以覆盖的情况。
3. 公共快照不把 HTTP 404 列为默认可重试状态；其通用 path 倾向于向调用者返回错误。

### 推断

“暂时没有可分配端点”是对该上游文本和后续成功的合理解释，但属于**中等置信度推断**，不等于官方公开承诺或 CLI 已验证的重试策略。

### 对适配器的建议

如果目标是**官方 CLI 行为一致性**，当前适配器应继续将普通 chat 404 原样上报，不应把它伪装成 `session_expired` 或静默换模型。

如果目标是**VPS 协议适配器可用性**，可另行引入一个明确标注为扩展的策略：仅当 HTTP 404 的错误正文匹配 `No endpoints found` 时，进行一次有界退避重试；该策略必须有独立测试、日志分类和开关，且不能宣称来自官方 CLI。不要把所有 404 都重试。

## 推荐下一步

1. **保持官方一致性**：不改 404 行为，仅增加脱敏日志与客户端说明。
2. **增加适配器扩展**：实现一次有界重试，标记为非官方增强，并做 mock 回归测试。
3. **取得精确动态答案**：在用户确认其现有 CLI 已关闭、没有进行中的工作后，再对隔离 mock 启动 0.0.149 进行一次受控 404 测试；该测试不会访问真实上游。

## 可复现性附录

| 操作 | 结果 |
|---|---|
| `file ~/.config/manicode/freebuff` | Mach-O 64-bit arm64。 |
| `shasum -a 256 ~/.config/manicode/freebuff` | 与样本索引 SHA-256 一致。 |
| `grep -aobF 'No endpoints found' ~/.config/manicode/freebuff` | 无命中。 |
| 固定公开快照 `d46862b4...` 的 `sdk/src/error-utils.ts` | 可重试集合为 408、429、500、502、503、504。 |
| 隔离 CLI + 本地 mock | 被官方 single-instance owner 保护安全阻止；未 Take over。 |
