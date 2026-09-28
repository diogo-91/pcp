FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    PORT=3100 \
    DATABASE_FILE=/app/data/pcp.sqlite

# O banco fica aqui. Monte um VOLUME PERSISTENTE neste caminho (no EasyPanel: Mounts > Volume > /app/data):
# sem ele, o que o PCP digitou é perdido a cada redeploy.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3100/api/health || exit 1

# `node` direto (sem npx) para o SIGTERM chegar ao processo e o banco fechar limpo.
CMD ["node", "--disable-warning=ExperimentalWarning", "--import", "tsx", "src/server.ts"]
