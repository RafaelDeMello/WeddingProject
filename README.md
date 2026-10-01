# weddingrafessa — câmera de convidados via QR Code

Os convidados escaneiam um QR Code impresso nas mesas, informam o nome uma vez, tiram uma foto pela
câmera da própria página e enviam. Os noivos baixam tudo depois.

- QR aponta para `https://fotos.example.com/e/<EVENT_SLUG>` (outro slug → 404).
- Backend: Node 22 + Express + Prisma/SQLite + sharp. Front: React + Vite (servido pelo próprio Express).
- Especificação completa em [`AGENTS.md`](AGENTS.md); histórico em [`PROGRESS.md`](PROGRESS.md); bugs em [`BUGS.md`](BUGS.md).

## Sumário

1. [Desenvolvimento local](#1-desenvolvimento-local)
2. [Variáveis de ambiente](#2-variáveis-de-ambiente)
3. [Deploy na VPS](#3-deploy-na-vps)
4. [Caddy](#4-caddy-proxy-global-da-vps)
5. [Verificação](#5-verificação-pós-deploy)
6. [Backup](#6-backup)
7. [Limpar os dados de teste antes do evento](#7-limpar-os-dados-de-teste-antes-do-evento)
8. [Rotina, atualização e fotos](#8-rotina-durante-o-evento-atualização-e-acesso-às-fotos)
9. [Problemas comuns](#9-problemas-comuns)

---

## 1. Desenvolvimento local

```bash
npm install
cp .env.example .env     # e ajuste para dev (veja o comentário no topo do arquivo)
npm run db:migrate       # cria data/db/app.db
npm run dev              # API em :3000 e Vite em http://localhost:5173 (proxy de /api)
npm test                 # Vitest + Supertest (faz um `vite build` real do front)
npm run typecheck
npm run build
```

Teste no celular com um túnel (o `*.trycloudflare.com` já está em `allowedHosts`):

```bash
cloudflared tunnel --url http://localhost:5173
```

Com `NODE_ENV=development` o cookie de sessão não é `Secure` e a checagem de `Origin` também aceita
`localhost` e `https://*.trycloudflare.com`. Em produção ela é estrita (`PUBLIC_BASE_URL`).

## 2. Variáveis de ambiente

Todas são validadas no boot (Zod); valor inválido derruba o container com a lista dos problemas.
Veja o [`.env.example`](.env.example) completo. As principais:

| Variável | Para quê |
|---|---|
| `EVENT_SLUG` | trecho secreto do QR (`/e/<slug>`). Use algo curto e aleatório |
| `UPLOAD_OPENS_AT` / `UPLOAD_CLOSES_AT` | janela de upload, ISO 8601 **com offset** (`-03:00`) |
| `GUEST_MAX_PER_WINDOW` / `GUEST_WINDOW_MINUTES` / `GUEST_MAX_TOTAL` | cota real por convidado (10 a cada 10 min; 150 no total) |
| `IP_MAX_UPLOADS_PER_WINDOW` / `IP_MAX_GUESTS_PER_WINDOW` / `IP_MAX_GALLERY_PER_WINDOW` | proteção por IP, generosa (1000 / 150 / 100000 por 10 min): o Wi-Fi do salão compartilha o IP |
| `MIN_FREE_DISK_MB` | abaixo disso o upload é recusado com 507 |
| `SESSION_SECRET` | assina o cookie; `openssl rand -hex 32` |
| `ADMIN_USER` / `ADMIN_PASSWORD` | login (Basic Auth) do admin e do download do ZIP; `ADMIN_PASSWORD` com 12+ caracteres, use `openssl rand -base64 24` |
| `ADMIN_MAX_FAILURES_PER_WINDOW` | tentativas de login com senha errada por IP a cada 15 min (padrão 10). **Em produção use 30** e veja a nota na [seção 8](#8-rotina-durante-o-evento-atualização-e-acesso-às-fotos) |
| `DATA_DIR`, `DATABASE_URL` | no container: `/data` e `file:/data/db/app.db` |
| `WEB_DIST_DIR` | opcional; padrão `../web/dist` (na imagem, o front já está lá) |

> **Janela de upload e testes em produção:** o teste de ponta a ponta na VPS acontece **antes** de
> `UPLOAD_OPENS_AT`. Para testar, abra a janela no `.env` (ex.: `UPLOAD_OPENS_AT=2026-09-01T00:00:00-03:00`),
> teste, rode o [reset-data](#7-limpar-os-dados-de-teste-antes-do-evento) e **volte** o valor real.

## 3. Deploy na VPS

Pré-requisitos no host (Ubuntu): Docker + Compose plugin, `git`, e — para o backup — `sqlite3`,
`rclone` e `util-linux` (`flock`, `setpriv`):

```bash
sudo apt-get install -y sqlite3 rclone util-linux
```

O app fica em `/opt/apps/weddingrafessa` e **entra na rede Docker `proxy`** (a mesma do Caddy),
**sem publicar portas no host**. O Caddy o alcança como `weddingrafessa:3000`.

```bash
# 1. Código
sudo mkdir -p /opt/apps && cd /opt/apps
sudo git clone <URL-DO-REPOSITORIO> weddingrafessa
cd weddingrafessa

# 2. Configuração (o .env nunca é versionado)
cp .env.example .env
nano .env        # preencha: EVENT_SLUG, EVENT_NAME, SESSION_SECRET, ADMIN_USER, ADMIN_PASSWORD...
#   SESSION_SECRET:  openssl rand -hex 32
#   ADMIN_PASSWORD:  openssl rand -base64 24
chmod 600 .env

# 3. Pasta de dados (bind mount). O container roda como uid/gid 1000: a pasta precisa ser dele
#    ANTES do primeiro "up".
mkdir -p data
sudo chown 1000:1000 data

# 4. Confirme que a rede do Caddy existe
docker network ls | grep -w proxy

# 5. Sobe (build + migrações automáticas no start)
docker compose up -d --build
docker compose logs -f weddingrafessa     # deve mostrar "aplicando migrações" e "servidor iniciado"
docker compose ps                          # STATUS "healthy" em até ~1 min
```

O container sobe com `mem_limit: 1g`, `cpus: 1`, filesystem **somente leitura** (só `/data` e `/tmp`
graváveis), sem capabilities extras e com o usuário não-root `node`. O entrypoint cria `/data/db` e
roda `prisma migrate deploy` antes de iniciar a API.

## 4. Caddy (proxy global da VPS)

O Caddy é **compartilhado com outros sites**. Regras: **nunca reinicie nem recrie** o container dele;
**valide antes** de recarregar; faça backup do Caddyfile antes de editar.

Situação conhecida: rede `proxy` (external), Caddyfile em
`/opt/caddy/Caddyfile` montado em `/etc/caddy/Caddyfile`.

> ⚠️ **O Caddyfile é um bind mount de ARQUIVO ÚNICO.** Editores que *substituem* o arquivo
> (`sed -i`, `vim` com `backupcopy=no`, `mv`, `cp` para outro inode) quebram o vínculo: o container
> continua lendo a versão ANTIGA, sem nenhum erro. **Edite com `nano`** ou **acrescente com `cat >>`**,
> e sempre confira o que o **container** enxerga (passo 3).

```bash
CADDYFILE=/opt/caddy/Caddyfile

# 0. (Só leitura) Reconfira redes e mounts do Caddy
docker inspect caddy --format '{{json .NetworkSettings.Networks}}' | head -c 600; echo
docker inspect caddy --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
cat "$CADDYFILE"

# 1. Backup do Caddyfile ANTES de editar
sudo cp -a "$CADDYFILE" "$CADDYFILE.bak-$(date +%Y%m%d-%H%M%S)"

# 2. Acrescente o bloco (cat >> mantém o mesmo arquivo/inode)
sudo tee -a "$CADDYFILE" >/dev/null <<'EOF'

fotos.example.com {
    request_body {
        max_size 10MB
    }
    encode gzip
    reverse_proxy weddingrafessa:3000
}
EOF

# 3. Confira o que o CONTAINER enxerga — o bloco novo precisa aparecer aqui
docker exec caddy cat /etc/caddy/Caddyfile

# 4. OBRIGATÓRIO: validar. Se der erro, NÃO recarregue (veja "Desfazer" abaixo)
docker exec caddy caddy validate --config /etc/caddy/Caddyfile

# 5. Só então recarregar (sem derrubar conexões dos outros sites)
docker exec caddy caddy reload --config /etc/caddy/Caddyfile
```

**Desfazer** (volta o arquivo ao que era, sem trocar o inode):

```bash
sudo sh -c 'cat "$1" > "$2"' _ "$CADDYFILE.bak-<carimbo>" "$CADDYFILE"
docker exec caddy cat /etc/caddy/Caddyfile   # confira
docker exec caddy caddy validate --config /etc/caddy/Caddyfile
docker exec caddy caddy reload --config /etc/caddy/Caddyfile
```

Por que `request_body max_size 10MB`: o limite do app é 8 MB por foto; o Caddy barra antes o que passar disso.

## 5. Verificação pós-deploy

```bash
docker compose ps                                              # healthy
docker exec weddingrafessa node -e "console.log(process.getuid())"   # 1000 (não-root)
docker network inspect proxy --format '{{range .Containers}}{{.Name}} {{end}}'   # caddy e weddingrafessa
curl -s https://fotos.example.com/api/health     # {"ok":true}
curl -s -o /dev/null -w '%{http_code}\n' https://fotos.example.com/e/slug-errado   # 404
curl -s -o /dev/null -w '%{http_code}\n' https://fotos.example.com/e/<EVENT_SLUG>  # 200
```

Depois, no **iPhone (Safari)** e no **Android (Chrome)** via 4G: abrir o QR, informar o nome, tirar uma
foto e enviar. A foto deve aparecer em `/opt/apps/weddingrafessa/data/photos/AAAA-MM-DD/`.

## 6. Backup

`scripts/backup.sh` roda **no host** (cron, a cada 10 min durante o evento):

1. backup **online** do SQLite (`sqlite3 ".backup"`, nunca cópia do `.db` em uso) + `integrity_check`;
2. `rclone copy` de `photos/`, `thumbs/` e dos backups do banco para o remoto.
   É `copy`, não `sync`: o que for apagado localmente **continua** no remoto.

### 6.1 Configurar o remoto do rclone

```bash
rclone config          # n) new remote → escolha o tipo e siga o assistente
rclone listremotes
```

- **Cloudflare R2:** tipo `s3`, provider `Cloudflare`, com Access Key/Secret (R2 → *Manage API tokens*),
  endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` e um bucket (ex.: `weddingrafessa`).
  Destino: `BACKUP_REMOTE=r2:weddingrafessa`.
- **Google Drive:** tipo `drive`. Numa VPS sem navegador, responda *n* para "Use web browser" e siga o
  `rclone authorize "drive"` numa máquina com navegador. Destino: `BACKUP_REMOTE=gdrive:weddingrafessa`.

### 6.2 Configurar e testar

```bash
cd /opt/apps/weddingrafessa
cat > backup.env <<'EOF'
BACKUP_REMOTE=r2:weddingrafessa
EOF
chmod 600 backup.env                       # não é versionado (.gitignore)
chmod +x scripts/backup.sh

sudo ./scripts/backup.sh --check           # confere sqlite3, rclone, banco e acesso ao remoto
sudo ./scripts/backup.sh                   # primeiro backup de verdade
rclone ls r2:weddingrafessa | head         # as fotos e db/app-*.db devem estar lá
```

Rode como **root** (o script abre o SQLite com o uid do dono do banco, 1000) ou como o próprio usuário
1000. As variáveis opcionais (`APP_DIR`, `DATA_DIR`, `BACKUP_DIR`, `BACKUP_KEEP_DB`, `RCLONE_FLAGS`) estão
documentadas no topo do script.

### 6.3 Cron (a cada 10 minutos)

```bash
sudo crontab -e
```

```cron
*/10 * * * * /opt/apps/weddingrafessa/scripts/backup.sh >> /var/log/weddingrafessa-backup.log 2>&1
```

O script usa `flock`: se uma rodada demorar, a próxima é pulada (não acumulam). Acompanhe com
`tail -f /var/log/weddingrafessa-backup.log`. Sem erros, cada rodada termina em `backup concluído`.
Depois do evento, remova a linha do cron.

### 6.4 Restaurar

```bash
docker compose stop weddingrafessa
cp -a data/db/app.db data/db/app.db.antes-do-restore 2>/dev/null
rm -f data/db/app.db-wal data/db/app.db-shm
cp backups/db/app-<carimbo>.db data/db/app.db         # ou: rclone copy r2:weddingrafessa/db/app-<carimbo>.db data/db/
sudo chown 1000:1000 data/db/app.db
# Fotos: rclone copy r2:weddingrafessa/photos data/photos ; rclone copy r2:weddingrafessa/thumbs data/thumbs
sudo chown -R 1000:1000 data
docker compose start weddingrafessa
```

## 7. Limpar os dados de teste antes do evento

`scripts/reset-data.mjs` apaga **fotos, miniaturas, arquivos temporários e as tabelas Guest/Photo**
(o banco, o schema e as migrações ficam). Ele mostra o que vai apagar e exige digitar `APAGAR`.
Rode com a API **parada**, num container avulso que usa o mesmo volume:

```bash
cd /opt/apps/weddingrafessa
docker compose stop weddingrafessa
docker compose run --rm --no-deps weddingrafessa node /app/scripts/reset-data.mjs
docker compose start weddingrafessa
```

- `--yes` pula a pergunta, mas **só funciona fora de produção** (em produção é recusado).
- Em desenvolvimento: `npm run reset-data` (usa o `.env` da raiz).
- Lembre de **voltar `UPLOAD_OPENS_AT`** ao valor real e recriar o container
  (`docker compose up -d`) depois dos testes.

## 8. Rotina durante o evento, atualização e acesso às fotos

```bash
docker compose logs -f --tail=100 weddingrafessa     # logs estruturados (sem IP em claro)
docker stats weddingrafessa --no-stream               # memória (limite 1 GiB)
df -h /opt/apps/weddingrafessa/data                   # o app recusa uploads com menos de MIN_FREE_DISK_MB livres
ls data/photos/*/ | wc -l                             # quantidade de fotos
```

**Atualizar** (migrações rodam sozinhas no start):

```bash
cd /opt/apps/weddingrafessa && git pull && docker compose up -d --build
```

**Baixar todas as fotos (ZIP).** Abra no navegador e entre com o `ADMIN_USER` / `ADMIN_PASSWORD` do `.env`:

```
https://fotos.example.com/api/admin/export.zip
```

- **Estrutura:** uma pasta por convidado, `<nome>-<id curto>/<HHmmss>-<id da foto>.jpg` (horário de Brasília).
  As fotos **ocultas ou apagadas pelo convidado** vêm em `_ocultas/<mesma pasta do convidado>/…`. Se algum arquivo
  registrado no banco não existir mais no disco, ele é pulado e listado em `_faltando.txt`.
- **Streaming:** o ZIP é gerado enquanto baixa (sem montar nada em memória), sem compressão (JPEG não comprime).
  Por isso o navegador **não sabe o tamanho total** (sem barra de progresso confiável) e **não há retomada**: se a
  conexão cair, o download recomeça do zero.
- **Uma exportação por vez:** se já houver uma em andamento, a resposta é `429 export_in_progress` — espere
  (ela diz para tentar de novo em 30 s). Se quem baixava desistiu, a vaga é liberada na hora.
- **Demora e tamanho:** com milhares de fotos são vários GB e alguns minutos. **Baixe no Wi-Fi ou no cabo**, não no 4G.
  Em linha de comando (pede a senha sem deixá-la no histórico):

  ```bash
  curl -u admin -o fotos-casamento.zip https://fotos.example.com/api/admin/export.zip
  ```

- **Alternativas** (quem executa é você), úteis se o download pelo navegador não for possível:

  ```bash
  # as fotos estão em /opt/apps/weddingrafessa/data/photos/AAAA-MM-DD/<id>.jpg (sem o nome do convidado)
  scp -r usuario@vps:/opt/apps/weddingrafessa/data/photos ./fotos-casamento
  # ou direto do remoto do backup (R2/Drive), que não depende da VPS:
  rclone copy r2:weddingrafessa/photos ./fotos-casamento
  ```

> ⚠️ **Login do admin e o limite de tentativas erradas.** O admin tem limite de tentativas com senha errada por IP
> (`ADMIN_MAX_FAILURES_PER_WINDOW`, padrão 10 a cada 15 min). Estourado o limite, **até a senha certa é recusada**
> (`429`) até a janela passar — senão o limite não impediria adivinhar a senha. No Wi-Fi da festa dezenas de
> convidados **dividem o mesmo IP**, então um tropeço de outra pessoa poderia travar o moderador.
> **Em produção use `ADMIN_MAX_FAILURES_PER_WINDOW=30`** e entre no admin pelos **dados móveis** do celular (o IP
> do 4G é outro, não o do Wi-Fi do salão). Com a senha gerada por `openssl rand -base64 24`, adivinhar é inviável
> de qualquer forma; o limite é só uma segunda camada.

**Moderação de emergência (`/admin`).** Não há moderador na festa; a página existe para o caso de uma foto
precisar sair da galeria rapidamente. Abra `https://fotos.example.com/admin` (mesmo usuário e senha do
ZIP; no celular, de preferência pelos **dados móveis** — veja a nota abaixo). Ela mostra as fotos mais recentes
(as ocultas ficam esmaecidas, com o selo "Oculta"), um botão **Ocultar / Reexibir** em cada uma, **Carregar mais**,
**Atualizar** (e atualiza sozinha a cada 30 s) e o botão **Baixar todas as fotos (ZIP)**. Ocultar tira a foto da
galeria de todos os convidados em poucos segundos; o arquivo continua no disco e no backup. A foto ocultada **não
conta a menos** na cota do convidado.

> ⚠️ **Reexibir também traz de volta fotos que o próprio convidado apagou.** Não existe distinção entre "apagada
> pelo dono" e "ocultada pelo admin" — use o **Reexibir** só se tiver certeza.

As fotos **nunca** são públicas: o Express só as entrega a convidados com sessão (galeria, **sem** as ocultas) e ao admin autenticado. Os arquivos ficam no disco e no backup.

**Fotos apagadas pelos convidados e "Reexibir":** cada convidado pode apagar as próprias fotos pelo app
(`DELETE /api/gallery/photos/:id`). O efeito é o mesmo de "ocultar" no admin: a foto some da galeria de todos, mas
o **arquivo continua no disco e no backup** (e vai para a pasta `_ocultas/` do ZIP) e ela **continua contando na
cota** do convidado. ⚠️ Não existe distinção entre "apagada pelo dono" e "ocultada pelo admin": um **"Reexibir"
do admin traz de volta também a foto que o próprio convidado apagou**. Use o reexibir só como ferramenta de
emergência.

## 9. Problemas comuns

| Sintoma | O que verificar |
|---|---|
| Container reinicia em loop | `docker compose logs weddingrafessa`: env inválida (lista os campos), ou permissão de `data/` (`sudo chown 1000:1000 data`) |
| `502` do Caddy | o app está na rede `proxy`? `docker network inspect proxy`; `docker compose ps` (healthy?) |
| Bloco novo do Caddy "não pegou" | o Caddyfile foi substituído em vez de editado — compare `cat $CADDYFILE` com `docker exec caddy cat /etc/caddy/Caddyfile` |
| `/e/<slug>` dá 404 | o slug do QR é igual a `EVENT_SLUG` do `.env`? Mudou o `.env`? `docker compose up -d` recria o container |
| "O envio de fotos ainda não abriu" | `UPLOAD_OPENS_AT` no `.env` (ISO com `-03:00`) |
| Câmera não abre | precisa de HTTPS (o Caddy cuida) e do navegador nativo (Safari/Chrome), não de navegador interno de app |
| Upload 507 | pouco espaço em disco (`MIN_FREE_DISK_MB`); `df -h` |
| `429` no `/api/admin/…` com a senha certa | limite de tentativas erradas do admin (`ADMIN_MAX_FAILURES_PER_WINDOW`): espere o tempo do `Retry-After` ou use outro IP (dados móveis) |
| `429 export_in_progress` ao baixar o ZIP | já há uma exportação em andamento; espere ~30 s (ela termina ou é liberada quando o cliente desiste) |
| ZIP baixado incompleto / "arquivo corrompido" | a conexão caiu no meio (não há retomada): baixe de novo, de preferência no Wi-Fi/cabo, ou use `rclone`/`scp` |
| Erro de permissão no banco após backup | rodou `sqlite3` como root sem o `setpriv`? Use o `backup.sh` como está; arrume com `sudo chown -R 1000:1000 data` |

## Estrutura

```
server/     API Express + Prisma (src/, prisma/, test/)
web/        React + Vite
scripts/    backup.sh, reset-data.mjs (e, futuramente, loadtest)
docker/     entrypoint.sh
Dockerfile, docker-compose.yml, .env.example
```
