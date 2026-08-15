# AI handoff

```text
branch: codex/vps-protocol-compat
commit: refactor: align VPS adapter with Freebuff CLI protocol
state:  重构已提交；用 git status / git rev-parse HEAD 获取实时状态
```

给后续 AI 的最短阅读顺序：

1. `README.md`
2. `docs/ARCHITECTURE.md`
3. `docs/REFACTOR.md`
4. `docs/reverse/CLI-0.0.149.md`
5. `worker.js`
6. `test/worker.test.mjs`

## 当前源码事实

- 运行目标：自有 VPS、Node.js 20+、单进程。
- 入口：`server.js`。
- 核心实现：`worker.js`。
- API：Chat Completions、Responses、Anthropic Messages。
- 账号：严格稳定轮询，每账号/模型独立 session 和冷却。
- 推理：全局串行，直到整个上游 SSE 结束。
- CLI 基线：Freebuff `0.0.149` / base3。
- 普通 HTTP 推理代表一个 LLM step；Responses `previous_response_id` 的 function_call 续接会复用 run 并累计 ledger，但不执行官方本地工具。

## 不要误改

- 不要恢复 Cloudflare Worker 或 Vercel 特有逻辑。
- 不要让 `/healthz` 主动请求上游。
- 不要默认开启广告/usage 或伪造设备信息；只有用户显式设置 `FREEBUFF_CLIENT_BEHAVIOR=cli` 时才启用兼容请求。
- 不要把 `rate_limited` 当成永久无效 token。
- 不要优先选择 active session 破坏账号轮询。
- 不要删除或 takeover 未被本进程持有的 session。
- 不要把无效 SSE 静默转换为 HTTP 200 completed。
- 不要删除 Responses assistant tool-call 历史。

## 验证命令

```bash
npm test
npm run test:e2e
npm run audit:protocol
node --check worker.js
node --check server.js
git diff --check
```

全部测试使用 mock token；不会访问真实 Freebuff。

## 当前已知限制

- 内存状态不支持多 Node 实例共享。
- `/v1/models` 只有在账号状态被真实业务请求观察后才能按 tier 收窄。
- 没有完整 CLI 工具 runtime、服务端浏览器登录和磁盘 run-state；ads/usage 兼容层默认关闭，Responses continuation 仅保存在内存。
- 服务端私有风控不可从客户端代码确定。

## 工作区提醒

当前分支曾经包含大量未提交重构。继续工作前先运行：

```bash
git status --short --branch
git diff --stat
```

不要使用 reset/checkout 覆盖现有修改。
