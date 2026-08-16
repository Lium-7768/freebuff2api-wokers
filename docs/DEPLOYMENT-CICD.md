# GitHub Actions 到 VPS 的安全部署

## 目标

发布分支 `codex/vps-protocol-compat` 的推送会先运行协议回归测试。测试通过后，GitHub Actions 仅使用 `Production` Environment 的部署秘密，通过受限 SSH 账号将不可变 Docker 镜像和运行时秘密发送到 VPS。仓库、镜像和常规日志中不保存 VPS 应用凭据。

## GitHub Environment：`Production`

在 GitHub 仓库的 **Settings → Environments → Production** 中配置以下 secrets：

| Secret 名称 | 内容 | 用途 |
|---|---|---|
| `DEPLOY_HOST` | VPS 主机名或 IP | 仅供 SSH 客户端连接。 |
| `DEPLOY_USER` | `freebuff-deploy` | 受限部署账号。 |
| `DEPLOY_SSH_PRIVATE_KEY` | 专用部署私钥全文 | 只能使用 forced-command 部署入口。 |
| `DEPLOY_SSH_KNOWN_HOSTS` | VPS 的 SSH 主机指纹行 | 防止连接到伪造主机。 |
| `FREEBUFF_API_KEY` | 对外适配器访问密钥 | 仅在部署时传送给 VPS。 |
| `FREEBUFF_TOKEN` | 一个或多个逗号分隔的 Freebuff auth token | 兼容传统 token 池；仅在部署时传送给 VPS。 |
| `FREEBUFF_CREDENTIALS_JSON` | 官方 `{default:{authToken,fingerprintId,...}}` JSON | Actions 在标准输入传输前仅在 runner 内 Base64 编码；VPS 仅写入 root-only secret 文件。 |

## VPS 的秘密边界

部署脚本把运行时秘密写入 `/run/freebuff2api/`，不是 `.env`。官方 credentials JSON 在 GitHub Actions runner 内编码为单行 Base64，VPS 受限入口解码后再写文件；明文不会写入镜像、Git 工作树或普通部署日志：

- `api_key`
- `upstream_tokens`（使用传统 token 池时）
- `upstream_credentials_json`（使用官方 credentials JSON 时）

目录由 root 管理，部署账号没有交互 shell 且只能运行受限命令。容器把该目录只读挂载到 `/run/freebuff2api`，以 `FREEBUFF_SECRETS_DIR=/run/freebuff2api` 读取；不会把应用秘密写入镜像或 Git 工作树。若两种上游凭证同时配置，适配器会合并并去重账号；官方 JSON 中只有 `authToken` 与 usage 专用 `fingerprintId` 进入运行时协议，`name`、`email`、`fingerprintHash` 不会被发送。

为读取宿主机的 `0400 root:root` secrets 文件，服务进程在容器内以 UID 0 运行；启动参数同时删除全部 Linux capabilities 并启用 `no-new-privileges`，从而仅保留读取只读挂载所需的最小权限。
`/run` 是临时文件系统。若 VPS 重启，服务不会带着旧 token 自动恢复，必须通过 GitHub Actions 再部署一次；这是本设计刻意避免在 VPS 上持久保存应用 secrets 的代价。

## 发布与回滚

工作流将构建后的镜像通过 SSH 标准输入传到 VPS，不使用 Docker Hub 或 GHCR。VPS 先在 `127.0.0.1:8878` 启动候选容器并检查 `/healthz`，成功后才替换 `127.0.0.1:8877` 的生产容器。候选或生产健康检查失败时，脚本恢复上一个容器。

如需人工恢复，请在 GitHub Actions 页面选择已知良好的提交并运行 **Deploy Freebuff adapter to VPS**。不要在 VPS 手工创建 `.env` 或向容器直接传入业务秘密。

## 轮换秘密

轮换对外 API Key 或上游 token 时，更新 `Production` Environment 的对应 secret，并从 Actions 页面重新运行部署工作流。部署成功后，旧 `/run/freebuff2api` 内容会被替换；此前容器不会保留旧应用秘密。
