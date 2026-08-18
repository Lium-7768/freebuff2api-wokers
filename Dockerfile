FROM node:20-alpine

WORKDIR /app

# 将构建时审计过的代码固定进镜像；运行时不再从 GitHub 覆盖 worker.js。
COPY package.json server.js worker.js ./
COPY src ./src

# Create credentials dir (mounted at runtime)
RUN mkdir -p /app/credentials && chown -R node:node /app

USER node
EXPOSE 8787

CMD ["node", "server.js"]
