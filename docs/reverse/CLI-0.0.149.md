# Freebuff CLI 0.0.149 逆向摘要

## 样本

```text
版本：0.0.149
格式：Mach-O 64-bit arm64 / Bun 单文件程序
大小：90,294,626 bytes
SHA-256：fecf6ec876666cc0f60578d0ebcf4bb320e090335fbadc0bec0aebd0780e5a85
```

机器可读信息位于：

- `artifacts/reverse/freebuff-cli-0.0.149/metadata.json`
- `artifacts/reverse/freebuff-cli-0.0.149/binary-offsets.json`
- `artifacts/reverse/freebuff-cli-0.0.149/runtime-observation.json`

## 已验证协议

### 登录

```text
POST /api/auth/cli/code
GET  /api/auth/cli/status
```

登录使用 fingerprintId/fingerprintHash，成功后保存完整 credentials。当前适配器只读取 authToken，不实现登录。

### Session

```text
GET    /api/v1/freebuff/session
POST   /api/v1/freebuff/session
DELETE /api/v1/freebuff/session
```

已确认 gate：

```text
waiting_room_required  428
session_expired        410
session_superseded     409
session_model_mismatch 409
session_limit_reached  409
waiting_room_queued    429
```

### Agent run

START：

```json
{"action":"START","agentId":"base3-free-*","ancestorRunIds":[]}
```

FINISH 包含：

```text
runId, status, totalSteps, directCredits, totalCredits,
errorMessage, steps
```

真实 CLI 运行证明它是持久化多 step runtime，而不是固定 `totalSteps=0`。

### Chat metadata

```text
freebuff_instance_id
trace_session_id
run_id
client_id
cost_mode
llm_step_number
```

### base3

官方 opening：

```text
You are Buffy, the coding agent behind Codebuff.
```

确认存在15个工具，但当前适配器不会伪装成这些工具的执行环境。完整列表见机器证据 JSON。

## 真实运行观察

脱敏 run-state/log 统计：

- 系统提示长度：4393
- 工具：15
- 消息：264
- 最长观察 run：53 个 LLM step、54 个工具调用
- 取消和上游 428 时，FINISH 的 `totalSteps` 仍是实际已进入的 step 数

## 公开源码交叉验证

使用过公开快照：

```text
commit d46862b4b2ebf69a1b37e5c5daf9aa37052a61a0
2026-08-14T14:47:39Z
Sync public snapshot from freebuff-private
```

该快照比 NPM `0.0.149` 发布时间晚约31小时。它只能用于交叉验证，不能宣称是二进制的精确源码。

## 服务端检测证据边界

公开快照包含 `cf-worker-signals.ts` 和 `foreign-client-signals.ts`，并出现本项目公开仓库名称。但：

- 没有在公开快照找到生产调用点。
- 生产配置未知。
- 这些是服务端源码，不在 CLI 二进制中。

所以只能确认“源码设计了检测”，不能确认当前生产环境启用了封禁、阻断或降级。

## 完整性结论

已经高置信覆盖：base3、工具目录、登录、session、owner、START/FINISH/steps、metadata、SSE、usage、ads 和真实多 step 行为。

仍未知：精确 private commit、生产检测接线、成功原始生产 SSE 样本和私有账号风控。
