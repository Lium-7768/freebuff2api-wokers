# freebuff2api-wokers

运行在自有 VPS 上的 Freebuff OpenAI/Anthropic 兼容适配器

> 当前基线：Freebuff CLI `0.0.149`、base3、VPS Node.js 单进程。

## 给 AI 先看

- [当前架构](docs/ARCHITECTURE.md)
- [逆向后的完整重构](docs/REFACTOR.md)
- [Freebuff CLI 0.0.149 逆向摘要](docs/reverse/CLI-0.0.149.md)
- [AI 接手说明](docs/AI-HANDOFF.md)
- [机器可读逆向产物](artifacts/reverse/README.md)

## 架构

```text
Codex / SDK
    ↓
server.js                  Node HTTP、断连取消、退出清理
    ↓
worker.js                  鉴权、协议转换、账号池
    ↓
账号轮询                   A → B → C → A
    ↓
session → START → LLM step → FINISH
    ↓
https://www.codebuff.com
```

对外接口：

```text
GET  /healthz
GET  /v1/models
POST /v1/chat/completions
POST /v1/responses
POST /v1/messages
POST /v1/messages/count_tokens
```

## 主要重构

- 按官方 base3 opening 和已验证核心提示构造 system message。
- FINISH 使用真实 `totalSteps` 和 `steps` ledger；Responses 工具续接会复用同一 run，累计多个 LLM step。
- 增加 `llm_step_number`，修正 `client_id` 和 Responses trace 延续。
- 修复拆分工具调用、Responses tool history、尾部无换行 SSE 和无效 SSE 错误传播。
- `/healthz` 只读本地缓存，不主动请求上游。
- 删除无证据的自动 usage、广告、设备和工具签名行为。
- 不复用、不删除、不 takeover 其他客户端的 active session。
- SIGINT/SIGTERM 释放当前进程明确持有的 session。
- 多账号严格轮询、账号/模型独立冷却、请求内不重复账号。
- 所有已观察账号为 limited 时，模型目录只显示 Flash 和 Mimo。

详细对比见 [docs/REFACTOR.md](docs/REFACTOR.md)。

## 多账号

账号按 credentials JSON 中的配置顺序轮询：

```text
A → B → C → A → B → C
```

每个账号复用自己的 session。明确限流或临时错误才切换账号；session gate 原样返回，不跨账号抢 seat。

也可以使用完整账号 JSON。推荐把官方 CLI 的多账号文件原样传入；每个账号的 `authToken` 与 `fingerprintId` 会绑定在同一条轮询记录中：

```bash
export FREEBUFF_CREDENTIALS_JSON="$(cat freebuff_tools/freebuff_credentials.json)"
```

唯一支持的格式是 `{accounts:{accountKey:{...}}}`。单账号也必须放在 `accounts` 中：

```json
{
  "accounts": {
    "user-a": {"authToken":"token-a","fingerprintId":"fp-a"},
    "user-b": {"authToken":"token-b","fingerprintId":"fp-b"}
  }
}
```

每个账号只需要 `authToken` 与 `fingerprintId` 两个字段；其他官方 CLI 元数据不需要复制到 VPS 配置。

其中每个账号的 `fingerprintId` 仅用于该账号的 `/api/v1/usage` body。

## Node/VPS 启动

要求 Node.js 20+：

```bash
npm install

export FREEBUFF_API_KEY="$(openssl rand -hex 32)"
export FREEBUFF_CREDENTIALS_JSON="$(cat freebuff_tools/freebuff_credentials.json)"
export HOST='0.0.0.0'
export PORT='8787'

npm start
```

检查：

```bash
curl http://127.0.0.1:8787/healthz

curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer $FREEBUFF_API_KEY"
```

Responses 示例：

```bash
curl http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer $FREEBUFF_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"deepseek/deepseek-v4-flash",
    "input":"只回复：连接成功",
    "stream":false
  }'
```

## Codex CLI

`~/.codex/config.toml`：

```toml
[model_providers.freebuff]
name = "freebuff"
base_url = "http://127.0.0.1:8787/v1"
env_key = "FREEBUFF_API_KEY"
wire_api = "responses"

[profiles.freebuff]
model_provider = "freebuff"
model = "deepseek/deepseek-v4-flash"
```

使用：

```bash
export FREEBUFF_API_KEY='与服务端一致的访问密钥'
codex exec --profile freebuff "只回复：连接成功"
```

## DeepSeek Harness

本适配器也可作为 `/Users/meiyu/code/deepseek/deepseek-harness` 的
`@deepseek-ai/dsh-llm-deepseek` 宿主端点。Harness 使用 Chat Completions，
而不是 Responses：

```bash
export DEEPSEEK_BASE_URL='https://你的域名/v1'
export DEEPSEEK_API_KEY='VPS 上配置的 FREEBUFF_API_KEY'

# Harness 默认使用无前缀模型名；适配器也接受这个别名。
python - <<'PY'
from deepseek_harness import DeepSeekHarness
with DeepSeekHarness(provider="deepseek-official", model="deepseek-v4-flash") as harness:
    print(harness.run("只回复：Harness连接成功").final_response)
PY
```

Freebuff 的 base3 上游只接受 CLI 原生工具名。请求带有 Harness 的
`x-deepseek-harness-user-id`/`x-deepseek-harness-session-id` 标头时，适配器
会自动将 `bash/read/write/edit/todo_write` 等 Harness 工具名转换为原生名，
再把返回的 tool call 名称转换回去。若客户端不发送这些标头，可在服务端显式
设置 `FREEBUFF_CLIENT_BEHAVIOR=harness` 后重启服务。

Harness 的本地工具仍由 Harness 执行；VPS 只负责上游 session、SSE 和工具调用
协议转换。部署新代码后应先运行 Harness 的单步文本和一轮 `bash` 工具回归，
再进行长时间多 step 任务。

## 环境变量

| 变量 | 必需 | 默认值 | 说明 |
|---|---|---|---|
| `FREEBUFF_API_KEY` | 是 | 无 | 本服务访问密钥 |
| `FREEBUFF_CREDENTIALS_JSON` | 是 | 无 | 唯一支持的多账号 JSON：`{accounts:{accountKey:{authToken,fingerprintId,...}}}`；单账号也必须使用 accounts 容器 |
| `HOST` | 否 | `0.0.0.0` | 监听地址 |
| `PORT` | 否 | `8787` | 监听端口 |
| `CODEBUFF_API` | 否 | `https://www.codebuff.com` | Freebuff/Codebuff 上游地址 |
| `TOKENHARBOR_API_KEY` | 否 | 无 | TokenHarbor API 密钥；配置后开放 TokenHarbor 模型 |
| `TOKENHARBOR_API_BASE` | 否 | `https://tokenharbor.ai/v1` | TokenHarbor OpenAI-compatible API 地址 |
| `FREEBUFF_DEBUG` | 否 | `false` | 输出脱敏路由日志 |
| `FREEBUFF_CLIENT_BEHAVIOR` | 否 | `cli` | `cli` 按报告启用 ads/usage；`off` 显式关闭；`harness` 仅启用 Harness 工具名/多 step 兼容 |
| `SHUTDOWN_GRACE_MS` | 否 | `5000` | SIGINT/SIGTERM 等待活动 HTTP 请求的毫秒数；可设为 `0` |
| `SHUTDOWN_CLEANUP_TIMEOUT_MS` | 否 | `5000` | 退出时等待 session DELETE 的毫秒数；可设为 `0` |

`FREEBUFF_TOKEN` 和 `FREEBUFF_FINGERPRINT_ID` 不再支持；服务启动时若检测到这两个变量会直接报错。请使用完整的 `FREEBUFF_CREDENTIALS_JSON`。

### 生产发布中的 provider 密钥

生产发布不把 provider 密钥写入镜像、Compose 文件或仓库。GitHub Actions 从 Production environment 的 `TOKENHARBOR_API_KEY` secret 读取密钥，通过 SSH 标准输入发送给 VPS 的受限 `install-secrets` 命令；VPS 将其保存为 root-only 的 `/run/freebuff2api/tokenharbor_api_key`，启动容器时以 `TOKENHARBOR_API_KEY` 注入。TokenHarbor 的模型只有在该 secret 非空时才会出现在 `/v1/models` 中。当前接入的 Free 模型为 `tokenharbor/qwen3.8-27b:free`、`tokenharbor/deepseek-v4-flash:free` 和 `tokenharbor/mimo-v2.5:free`；免费模型集合以 TokenHarbor 官方 Models 页面为准，可能轮换或下线。

### VPS 部署边界

- 建议以单个 Node 进程运行；内存中的 session owner、轮询游标和冷却状态不在多进程间共享。
- `server.js` 提供 HTTP，公网部署应在前面使用 Caddy/Nginx 等反向代理负责 TLS 和访问控制。
- `SIGTERM` 会触发活动请求取消、FINISH 收尾和自有 session 清理；编排器的终止宽限期应大于 `SHUTDOWN_CLEANUP_TIMEOUT_MS`。

## 测试和审计

```bash
npm test
npm run test:e2e
npm run audit:protocol
```

这些命令只使用本地 mock 上游和假 token，不消耗真实账号额度。

## 架构边界

本项目是协议适配器，不是完整 Freebuff CLI runtime：
- 浏览器登录仍由 `freebuff_tools` 或官方 CLI 负责。服务端只接收官方 credentials JSON，不执行浏览器登录或完整 credentials 管理；默认按报告发送 ads/usage；如需显式停用可设置 `FREEBUFF_CLIENT_BEHAVIOR=off`。
- 不在 VPS 执行官方15个本地工具。
- 支持 Responses `previous_response_id` 的客户端驱动多 step run 续接，但不在 VPS 执行官方15个本地工具；工具仍由 Codex/SDK 客户端执行。
- Codex 工具由 Codex 客户端执行，本服务负责正确传递 tool call/result。
- 内存状态要求单 Node 实例运行。

## License

[AGPL-3.0](LICENSE)

## VPS 多厂商架构

当前生产目标只有 VPS Docker，不再使用 Cloudflare Workers 或 Vercel。新的运行入口是 `src/gateway.js`，由 `src/router.js` 解析模型并交给 `src/providers/` 中对应的厂商实现。`src/protocol/` 负责统一的 OpenAI-compatible 输出；根目录的 `worker.js` 仅保留为旧测试和导入路径的兼容 facade。

当前 provider 包括：

| Provider | 模型/协议 |
|---|---|
| `freebuff` | Freebuff CLI base3、DeepSeek Flash/Pro 和其他 CLI 模型 |
| `orca` | Orca Router OpenAI-compatible 模型 |
| `bai` | B.AI DeepSeek V4 Flash |
| `manus` | Manus task API 转换为 OpenAI Chat Completions |
| `tokenharbor` | TokenHarbor OpenAI-compatible Chat Completions；公开模型统一使用 `tokenharbor/` 前缀，当前 Free 模型为 `tokenharbor/qwen3.8-27b:free`、`tokenharbor/deepseek-v4-flash:free`、`tokenharbor/mimo-v2.5:free` |

新增或修改 provider 时，应先更新对应 `src/providers/<provider>.js`，再通过 `src/router.js` 接入模型目录；HTTP 层不应直接添加厂商分支。�新增或修改 provider 时，应先更新对应 `src/providers/<provider>.js`，再通过。
