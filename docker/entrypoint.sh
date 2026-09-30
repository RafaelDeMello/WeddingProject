#!/bin/sh
# Entrypoint do container: prepara /data, aplica as migrações e sobe a API.
#
# Sem argumentos (uso normal): migrate deploy + API.
# Com argumentos: executa o comando pedido (ex.: `docker compose run --rm --no-deps weddingrafessa
# node /app/scripts/reset-data.mjs`) sem migrar e sem subir a API.
set -eu

DATA_DIR="${DATA_DIR:-/data}"

# O volume pode chegar vazio (primeiro `up`). O SQLite precisa que a pasta do banco exista
# antes do `migrate deploy`; a API recria o resto ao subir, mas deixamos tudo pronto aqui.
mkdir -p "$DATA_DIR/db" "$DATA_DIR/photos" "$DATA_DIR/thumbs" "$DATA_DIR/tmp"

cd /app/server

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

echo "[entrypoint] aplicando migrações (prisma migrate deploy)"
/app/node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma

echo "[entrypoint] iniciando a API"
# exec: o Node vira o PID principal e recebe o SIGTERM do `docker stop` (shutdown gracioso).
exec node dist/index.js
