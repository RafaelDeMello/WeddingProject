#!/usr/bin/env bash
#
# backup.sh — backup do weddingrafessa para um remoto do rclone (Cloudflare R2, Google Drive...).
# Roda NO HOST (não dentro do container), via cron, a cada 10 minutos durante o evento.
#
#   1. Backup ONLINE do SQLite com `sqlite3 ".backup"` (nunca copia o .db em uso) + integrity_check.
#   2. `rclone copy` (nunca `sync`: o que for apagado localmente continua no remoto) de
#      photos/, thumbs/ e dos backups do banco.
#
# Configuração por variáveis de ambiente ou pelo arquivo $APP_DIR/backup.env (não versionado):
#   BACKUP_REMOTE    obrigatória. Destino do rclone, ex.: r2:weddingrafessa  ou  gdrive:weddingrafessa
#   APP_DIR          padrão /opt/apps/weddingrafessa
#   DATA_DIR         padrão $APP_DIR/data          (o bind mount do compose)
#   BACKUP_DIR       padrão $APP_DIR/backups       (cópias locais do banco + trava)
#   BACKUP_KEEP_DB   padrão 144 (24 h de backups a cada 10 min) cópias locais do banco
#   RCLONE_FLAGS     flags extras para o rclone (ex.: "--transfers 8")
#
# Uso:
#   backup.sh            executa o backup
#   backup.sh --check    só confere dependências, permissões e acesso ao remoto (não copia fotos)
#
# Código de saída diferente de zero = algo falhou (o cron registra a saída no log).

set -euo pipefail
umask 077

APP_DIR="${APP_DIR:-/opt/apps/weddingrafessa}"
if [[ -f "$APP_DIR/backup.env" ]]; then
  # shellcheck disable=SC1091
  . "$APP_DIR/backup.env"
fi

DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
BACKUP_KEEP_DB="${BACKUP_KEEP_DB:-144}"
RCLONE_FLAGS="${RCLONE_FLAGS:-}"
DB_FILE="$DATA_DIR/db/app.db"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() { log "ERRO: $*" >&2; exit 1; }

MODE="run"
case "${1:-}" in
  "") ;;
  --check) MODE="check" ;;
  *) die "argumento desconhecido: $1 (use --check ou nada)" ;;
esac

[[ -n "${BACKUP_REMOTE:-}" ]] || die "defina BACKUP_REMOTE (ex.: r2:weddingrafessa) no ambiente ou em $APP_DIR/backup.env"
command -v sqlite3 >/dev/null || die "sqlite3 não encontrado (sudo apt install sqlite3)"
command -v rclone >/dev/null || die "rclone não encontrado (sudo apt install rclone, ou https://rclone.org/install/)"
command -v flock >/dev/null || die "flock não encontrado (pacote util-linux)"
[[ -f "$DB_FILE" ]] || die "banco não encontrado em $DB_FILE (o container já subiu e criou o banco?)"
[[ -d "$DATA_DIR/photos" && -d "$DATA_DIR/thumbs" ]] || die "pastas photos/ e thumbs/ não encontradas em $DATA_DIR"
[[ "$BACKUP_KEEP_DB" =~ ^[0-9]+$ && "$BACKUP_KEEP_DB" -ge 1 ]] || die "BACKUP_KEEP_DB deve ser um inteiro >= 1"

# O banco pertence ao usuário do container (uid 1000). Rodando como root, o sqlite3 roda com esse uid:
# um sqlite3 do root abrindo o banco em WAL poderia deixar arquivos -wal/-shm do root ao lado dele,
# e a API (uid 1000) não conseguiria mais abri-lo.
AS_OWNER=()
OWNER_UID="$(id -u)"
OWNER_GID="$(id -g)"
if [[ "$(id -u)" -eq 0 ]]; then
  command -v setpriv >/dev/null || die "setpriv não encontrado (pacote util-linux)"
  OWNER_UID="$(stat -c %u "$DB_FILE")"
  OWNER_GID="$(stat -c %g "$DB_FILE")"
  AS_OWNER=(setpriv "--reuid=$OWNER_UID" "--regid=$OWNER_GID" --clear-groups)
fi

mkdir -p "$BACKUP_DIR/db"
# Com umask 077 o BACKUP_DIR nasce 700 (dono root): o sqlite3 do uid 1000 não conseguiria atravessá-lo
# até o diretório de trabalho. 711 só permite "passar por ele" (não listar); db/ continua 700.
chmod 711 "$BACKUP_DIR"

if [[ "$MODE" == "check" ]]; then
  log "check: sqlite3 $(sqlite3 --version | cut -d' ' -f1), $(rclone version | head -n1)"
  "${AS_OWNER[@]}" sqlite3 -readonly "$DB_FILE" "SELECT 'banco legível: ' || count(*) || ' foto(s)' FROM Photo;" \
    || die "não consegui ler o banco (permissão? rode como root ou como o dono dos arquivos)"
  rclone mkdir "$BACKUP_REMOTE" \
    || die "rclone não alcança/cria o destino '$BACKUP_REMOTE' (veja: rclone config; rclone listremotes)"
  log "check OK — banco, remoto e ferramentas funcionando"
  exit 0
fi

# Trava: se o backup anterior ainda está rodando (muitas fotos novas), pula esta rodada.
exec 9>"$BACKUP_DIR/.lock"
if ! flock -n 9; then
  log "backup anterior ainda em andamento; pulando esta rodada"
  exit 0
fi

STAMP="$(date '+%Y%m%dT%H%M%S')"
FINAL="$BACKUP_DIR/db/app-$STAMP.db"
# O .backup roda com o uid do dono do banco, então grava num diretório de trabalho dele.
WORK="$BACKUP_DIR/work"
install -d -m 700 -o "$OWNER_UID" -g "$OWNER_GID" "$WORK"
PARTIAL="$WORK/app-$STAMP.db.partial"
trap 'rm -f "$PARTIAL"' EXIT

log "banco: backup online -> $FINAL"
# .backup usa a API de backup do SQLite: copia um estado consistente mesmo com a API gravando (WAL).
"${AS_OWNER[@]}" sqlite3 -readonly "$DB_FILE" ".timeout 15000" ".backup '$PARTIAL'" || die "sqlite3 .backup falhou"

check="$(sqlite3 "$PARTIAL" 'PRAGMA integrity_check;' 2>&1 | head -n1)"
[[ "$check" == "ok" ]] || die "integrity_check do backup falhou: $check"
mv "$PARTIAL" "$FINAL"
log "banco: backup íntegro ($(du -h "$FINAL" | cut -f1))"

# Mantém só as BACKUP_KEEP_DB cópias mais recentes do banco no disco local.
# (O remoto guarda todas: rclone copy não apaga nada.)
# shellcheck disable=SC2012
ls -1t "$BACKUP_DIR"/db/app-*.db 2>/dev/null | tail -n +"$((BACKUP_KEEP_DB + 1))" | xargs -r rm -f --

# shellcheck disable=SC2206
RCLONE_COMMON=(--retries 3 --low-level-retries 10 --stats-one-line --stats 0 --log-level INFO $RCLONE_FLAGS)

log "rclone: enviando fotos"
rclone copy "$DATA_DIR/photos" "$BACKUP_REMOTE/photos" "${RCLONE_COMMON[@]}"
log "rclone: enviando miniaturas"
rclone copy "$DATA_DIR/thumbs" "$BACKUP_REMOTE/thumbs" "${RCLONE_COMMON[@]}"
log "rclone: enviando backups do banco"
rclone copy "$BACKUP_DIR/db" "$BACKUP_REMOTE/db" --include 'app-*.db' "${RCLONE_COMMON[@]}"

log "backup concluído"
