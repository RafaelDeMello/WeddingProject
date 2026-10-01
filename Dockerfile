# syntax=docker/dockerfile:1
#
# Imagem do weddingrafessa (API Express + front React compilado).
# Base Debian (bookworm-slim): sharp e Prisma funcionam sem ajustes; evitar Alpine (musl).

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------------------
# base: Node + openssl (o engine do Prisma precisa de libssl 3)
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ---------------------------------------------------------------------------
# build: instala tudo, compila o front (vite) e o server (tsc)
# ---------------------------------------------------------------------------
FROM base AS build
COPY package.json package-lock.json tsconfig.base.json ./
COPY server/package.json server/
COPY web/package.json web/
# O postinstall do server roda `prisma generate`, que precisa do schema.
COPY server/prisma server/prisma
RUN npm ci
COPY server server
COPY web web
RUN npm run build

# ---------------------------------------------------------------------------
# prod-deps: só dependências de produção do server (inclui o CLI do prisma para o migrate deploy)
# ---------------------------------------------------------------------------
FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY server/prisma server/prisma
RUN npm ci --omit=dev --workspace=server \
 && npm cache clean --force

# ---------------------------------------------------------------------------
# runtime: sem devDependencies, sem código-fonte, usuário não-root
# ---------------------------------------------------------------------------
FROM base AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    # Com o filesystem read-only, tudo o que o Node/Prisma quiser gravar vai para o tmpfs /tmp.
    HOME=/tmp \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1

COPY --from=prod-deps /app/node_modules ./node_modules
COPY server/package.json ./server/package.json
COPY server/prisma ./server/prisma
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
# Página de moderação (/admin): arquivos estáticos servidos pelo Express, sem build.
COPY server/admin-ui ./server/admin-ui
COPY scripts/reset-data.mjs ./scripts/reset-data.mjs
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh

# /data é o volume (fotos + banco). O dono é o usuário "node" (uid/gid 1000), o mesmo do host.
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh \
 && chmod 755 /usr/local/bin/entrypoint.sh \
 && mkdir -p /data \
 && chown node:node /data

USER node
WORKDIR /app/server
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
