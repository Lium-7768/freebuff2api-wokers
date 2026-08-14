# Vercel Edge 部署

本分支只增加了 `api/[...path].js` 适配层，原始 `worker.js` 保持不变。

## 部署

1. 在 Vercel 导入此仓库的 `codex/vercel-adapter` 分支。
2. Framework 选择 **Other**，不设置 Build Command 和 Output Directory。
3. 添加 Production 环境变量：

   - `FREEBUFF_TOKEN`：一个或多个 Freebuff authToken，逗号或换行分隔
   - `FREEBUFF_API_KEY`：访问此 Worker 的 API Key

4. 点击 Deploy。

## 验证

Vercel Function 使用 `/api` 前缀：

```bash
export HOST="https://你的项目.vercel.app"
export API_KEY="你的 FREEBUFF_API_KEY"

curl "$HOST/api/healthz"
curl "$HOST/api/v1/models" \
  -H "Authorization: Bearer $API_KEY"
```

OpenAI-compatible Base URL：

```text
https://你的项目.vercel.app/api/v1
```

## 注意

Vercel 使用 Edge Runtime，长时间非流式请求和长 SSE 流可能受 Vercel 计划的执行时长限制。Cloudflare Worker 仍是推荐的生产部署方式。
