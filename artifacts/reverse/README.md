# Reverse artifacts

这里保存本项目逆向分析产生的**脱敏、可提交、可复查**产物。

- `freebuff-cli-0.0.149/metadata.json`：样本身份和公开源码快照信息。
- `freebuff-cli-0.0.149/binary-offsets.json`：关键字符串在官方 CLI 二进制中的偏移。
- `freebuff-cli-0.0.149/runtime-observation.json`：真实 CLI run-state/log 的脱敏统计。
- `local-e2e-result.json`：当前 Node/VPS 架构的本地端到端验证结果。

这里不保存真实 token、UID、登录状态、完整官方二进制、NPM 下载缓存或第三方源码镜像。
这些内容不是项目构建产物，也不应进入 Git。
