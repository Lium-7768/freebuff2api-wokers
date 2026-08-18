# VPS Multi-Provider Gateway Architecture

本项目仅面向 VPS Docker 部署，不再包含 Cloudflare Workers 或 Vercel runtime。

## 三层结构

```text
server.js
  -> src/gateway.js
      -> src/router.js
          -> src/providers/freebuff-runtime.js
          -> src/providers/orca.js
          -> src/providers/bai.js
          -> src/providers/manus.js
      -> src/protocol/compat.js
      -> src/protocol/openai.js
```

`src/providers/` 是厂商层。每个厂商维护自己的模型目录、认证方式、上游地址和请求转换。Freebuff 的历史 CLI 协议实现位于 `freebuff-runtime.js`；`freebuff.js` 只维护 Freebuff 模型和配额目录，后续可以继续拆分 CLI session、ads 和 agent-run 子模块。

`src/router.js` 是 provider 路由层。它根据公开模型 ID 解析厂商和上游模型，不让 HTTP 入口直接维护多组厂商分支。

`src/protocol/` 是输出层。所有公开 HTTP 接口都以 OpenAI-compatible JSON 或 SSE 返回。上游错误必须保留厂商名称、错误类型和可安全暴露的 request id；API key、完整请求体和上游敏感响应不得进入日志。

## 公开接口

| 路径 | 方法 | 输出 |
|---|---:|---|
| `/healthz` | GET | 服务健康摘要 JSON |
| `/v1/models` | GET | OpenAI model list |
| `/v1/chat/completions` | POST | OpenAI chat completion JSON/SSE |
| `/v1/responses` | POST | Responses 请求转换为统一 chat 输出 |
| `/v1/messages` | POST | Anthropic 请求转换为统一 OpenAI 上游输出 |

`worker.js` 现在只是向 `src/gateway.js` 的兼容 facade，保留测试和旧调用方的导入路径；生产 HTTP 入口已经使用 `src/gateway.js`。

## 状态码契约

客户端输入错误返回 `400`，认证失败返回 `401`，�客户端输入错误返回 `400`，认证失败返回 `401`，�客户端输入错误返回 `400`，认证失败返回 `401`，�客户端输兗�返回 `504`，上游网络或 5xx 错误统一映射为 `502`，服务未配置必需 Secret 返回 `503`。

错误 JSON 至少包含：

```json
{
  "error": {
    "message": "[provider] human-readable message",
    "type": "upstream_error",
    "provider": "provider-id"
  }
}
```
