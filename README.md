# weddingrafessa — câmera de convidados via QR Code

Um app web para casamentos (e outras festas): os convidados escaneiam um **QR Code** impresso nas mesas,
informam o nome uma única vez, tiram fotos pela câmera do próprio navegador e todas aparecem numa
**galeria compartilhada em tempo quase real**. Os anfitriões baixam tudo depois em um ZIP.

Foi desenvolvido em poucos dias para um casamento real, com foco em **confiabilidade** e **segurança**,
e usado na festa. Esta é a versão para você rodar a sua própria.

## O que ele faz

- **Sem instalar nada:** o convidado abre o link do QR no Safari/Chrome, usa a câmera da página
  (com fallback para o seletor de arquivo) e envia.
- **Envio robusto:** a foto é comprimida no celular, tem fila com *retry* e backoff exponencial, e é
  idempotente (reenviar a mesma foto não conta duas vezes).
- **Galeria compartilhada:** todos veem as fotos de todos (polling), podem apagar as próprias, e a moderação
  pode ocultar qualquer foto.
- **Janela de upload e cotas:** abre e fecha sozinho nos horários que você definir; limite por convidado
  (janela deslizante e total) e proteção por IP.
- **Admin de emergência (`/admin`):** grade das fotos no celular, ocultar/reexibir, e **download de tudo em ZIP**
  (em *streaming*, organizado por convidado).
- **Backup:** script para copiar fotos e banco para Google Drive / Cloudflare R2 (via `rclone`) a cada 10 minutos.

## Stack

- Backend: Node 22 + Express, Zod, Prisma + SQLite (WAL), multer, sharp, file-type, helmet, pino.
- Frontend: React + Vite (build estático servido pelo próprio Express), textos em pt-BR.
- Testes: Vitest + Supertest. Deploy: Docker + Docker Compose atrás de um Caddy (HTTPS automático).

## Segurança, em resumo

HTTPS obrigatório; sessão por cookie assinado (`httpOnly`, `Secure`, `SameSite=Lax`); checagem de `Origin`
contra CSRF; CSP restritiva; validação de imagem por *magic bytes*; remoção de EXIF/GPS; IP guardado só como
hash; fotos **nunca** públicas (só convidados com sessão e admin autenticado); container não-root com sistema
de arquivos somente leitura. A especificação completa está em [`AGENTS.md`](AGENTS.md).

> A galeria é tão privada quanto o link do QR: não divulgue o link fora da festa.

## Sumário

1. [Rodar localmente](#1-rodar-localmente)
2. [Variáveis de ambiente](#2-variáveis-de-ambiente)
3. [Subir em uma VPS](#3-subir-em-uma-vps)
4. [Backup](#4-backup)
5. [Limpar os dados de teste antes do evento](#5-limpar-os-dados-de-teste-antes-do-evento)
6. [Durante e depois do evento](#6-durante-e-depois-do-evento)
7. [Personalizar para o seu evento](#7-personalizar-para-o-seu-evento)
8. [Problemas comuns](#8-problemas-comuns)

---

## 1. Rodar localmente

Requisitos: Node 22+ e npm.

```bash
npm install
cp .env.example .env     # e ajuste para desenvolvimento (veja o comentário no topo do arquivo)
npm run db:migrate       # cria data/db/app.db
npm run dev              # API em :3000 e Vite em http://localhost:5173 (proxy de /api)
npm test                 # Vitest + Supertest (faz um `vite build` real do front)
npm run typecheck
npm run build
```

No `.env` de desenvolvimento, troque (é o que o comentário do `.env.example` explica):

```
NODE_ENV=development
PUBLIC_BASE_URL=http://localhost:5173
DATA_DIR=../data
DATABASE_URL=file:../../data/db/app.db
UPLOAD_OPENS_AT=<uma data no passado>
```

Abra `http://localhost:5173/e/<EVENT_SLUG>`. Para testar no celular, use um túnel
(`*.trycloudflare.com` já está liberado em `allowedHosts`):

```bash
cloudflared tunnel --url http://localhost:5173
```

Para mexer só no visual, sem API: `VITE_MOCK_API=session,photos,gallery` em `web/.env.local`.

## 2. Variáveis de ambiente

Todas são validadas no boot (Zod); valor inválido derruba o app com a lista dos problemas.
Veja o [`.env.example`](.env.example) completo. As principais:

| Variável | Para quê |
|---|---|
| `PUBLIC_BASE_URL` | URL pública, com `https://` em produção (usada na checagem de `Origin`) |
| `EVENT_SLUG` | trecho secreto do QR (`/e/<slug>`). Use algo curto e aleatório |
| `EVENT_NAME` | nome exibido na interface |
| `UPLOAD_OPENS_AT` / `UPLOAD_CLOSES_AT` | janela de upload, ISO 8601 **com offset** (ex.: `-03:00`) |
| `GUEST_MAX_PER_WINDOW` / `GUEST_WINDOW_MINUTES` / `GUEST_MAX_TOTAL` | cota por convidado (padrão 10 a cada 10 min; 150 no total) |
| `IP_MAX_UPLOADS_PER_WINDOW` / `IP_MAX_GUESTS_PER_WINDOW` / `IP_MAX_GALLERY_PER_WINDOW` | proteção por IP, generosa de propósito: os convidados dividem o Wi-Fi do local |
| `MIN_FREE_DISK_MB` | abaixo disso o upload é recusado (507) |
| `SESSION_SECRET` | assina o cookie; gere com `openssl rand -hex 32` |
| `ADMIN_USER` / `ADMIN_PASSWORD` | login (Basic Auth) do admin e do ZIP; senha com 12+ caracteres: `openssl rand -base64 24` |
| `ADMIN_MAX_FAILURES_PER_WINDOW` | tentativas erradas de login por IP a cada 15 min (padrão 10). **Em produção use 30** (veja a [seção 6](#6-durante-e-depois-do-evento)) |
| `DATA_DIR`, `DATABASE_URL` | no container: `/data` e `file:/data/db/app.db` |

## 3. Subir em uma VPS

### 3.1 Requisitos

- Uma VPS Linux (testado em **Ubuntu**), com pelo menos **1 vCPU, 1–2 GB de RAM** e disco suficiente para as
  fotos (planeje ~1 GB para cada ~2 mil fotos, mais a margem de `MIN_FREE_DISK_MB`).
- Um **domínio ou subdomínio** (ex.: `fotos.seudominio.com`) com um registro **A** apontando para o IP da VPS.
- Portas **80 e 443** abertas no firewall (o Caddy usa a 80 para emitir o certificado).
- Acesso por SSH com um usuário com `sudo`.

### 3.2 Instalar as dependências no servidor

```bash
# Docker + plugin do Compose
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"      # saia e entre de novo no SSH para valer

# Para o backup (opcional): sqlite3, rclone e util-linux (flock, setpriv)
sudo apt-get update && sudo apt-get install -y git sqlite3 rclone util-linux
```

### 3.3 Baixar o código e configurar

```bash
sudo mkdir -p /opt/apps && sudo chown "$USER" /opt/apps && cd /opt/apps
git clone <URL-DO-SEU-REPOSITORIO> weddingrafessa
cd weddingrafessa

cp .env.example .env
nano .env
#   PUBLIC_BASE_URL=https://fotos.seudominio.com
#   EVENT_SLUG=<algo aleatório, ex.: a8k2x>   EVENT_NAME=<nome do evento>
#   UPLOAD_OPENS_AT / UPLOAD_CLOSES_AT  (com offset do seu fuso)
#   SESSION_SECRET=<openssl rand -hex 32>
#   ADMIN_USER=<...>   ADMIN_PASSWORD=<openssl rand -base64 24>
#   ADMIN_MAX_FAILURES_PER_WINDOW=30
chmod 600 .env        # o .env nunca é versionado

# Pasta de dados (bind mount). O container roda como uid/gid 1000: a pasta precisa ser dele ANTES do primeiro "up".
mkdir -p data && sudo chown 1000:1000 data
```

### 3.4 Proxy reverso com HTTPS (Caddy)

O app **não publica portas**: ele entra numa rede Docker chamada `proxy`, e o Caddy o alcança por lá como
`weddingrafessa:3000`. Se você ainda não tem um Caddy no servidor, suba um:

```bash
docker network create proxy
sudo mkdir -p /opt/caddy && cd /opt/caddy
```

`/opt/caddy/docker-compose.yml`:

```yaml
services:
  caddy:
    image: caddy:2
    container_name: caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config
    networks:
      - proxy

volumes:
  caddy_data:
  caddy_config:

networks:
  proxy:
    external: true
    name: proxy
```

`/opt/caddy/Caddyfile` (troque o domínio pelo seu):

```
fotos.seudominio.com {
    request_body {
        max_size 10MB
    }
    encode gzip
    reverse_proxy weddingrafessa:3000
}
```

```bash
docker compose up -d
```

`max_size 10MB`: o limite do app é 8 MB por foto, e o Caddy barra antes o que passar disso.

> **Já tem um Caddy (ou outro proxy) no servidor?** Basta colocá-lo na rede `proxy` (ou outra rede que você
> escolha e ajuste no `docker-compose.yml`) e acrescentar o bloco acima ao Caddyfile dele, validando antes de
> recarregar: `docker exec <container> caddy validate --config /etc/caddy/Caddyfile` e depois
> `caddy reload --config ...`. Se preferir publicar uma porta em vez de usar rede Docker, remova a seção
> `networks` do serviço no compose, adicione `ports: ["127.0.0.1:3100:3000"]` e aponte o proxy para
> `127.0.0.1:3100`.

### 3.5 Subir o app

```bash
cd /opt/apps/weddingrafessa
docker compose up -d --build         # build da imagem + migrações automáticas no start
docker compose logs -f weddingrafessa  # deve mostrar "aplicando migrações" e "servidor iniciado"
docker compose ps                      # STATUS "healthy" em até ~1 min
```

O container sobe com `mem_limit: 1g`, `cpus: 1`, sistema de arquivos **somente leitura** (só `/data` e `/tmp`
graváveis), sem capabilities extras e com o usuário não-root `node`.

### 3.6 Verificar

```bash
curl -s https://fotos.seudominio.com/api/health                                    # {"ok":true}
curl -s -o /dev/null -w '%{http_code}\n' https://fotos.seudominio.com/e/slug-errado  # 404
curl -s -o /dev/null -w '%{http_code}\n' https://fotos.seudominio.com/e/<EVENT_SLUG> # 200
```

Depois, em um **iPhone (Safari)** e em um **Android (Chrome)**, preferencialmente pelo 4G: abra o link do QR,
informe o nome, tire uma foto e envie. Ela deve aparecer na galeria e em `data/photos/AAAA-MM-DD/`.

Gere o QR Code com o endereço `https://fotos.seudominio.com/e/<EVENT_SLUG>` (qualquer gerador serve).

> **Janela de upload e testes:** o teste na VPS acontece **antes** de `UPLOAD_OPENS_AT`. Para testar, abra a
> janela no `.env` (uma data no passado), faça `docker compose up -d`, teste, rode o
> [reset-data](#5-limpar-os-dados-de-teste-antes-do-evento) e **volte** o valor real.

### 3.7 Atualizar

```bash
cd /opt/apps/weddingrafessa && git pull && docker compose up -d --build   # migrações rodam sozinhas
```

## 4. Backup

`scripts/backup.sh` roda **no host** (cron, a cada 10 min durante o evento):

1. backup **online** do SQLite (`sqlite3 ".backup"`, nunca cópia do `.db` em uso) + `integrity_check`;
2. `rclone copy` de `photos/`, `thumbs/` e dos backups do banco para o remoto.
   É `copy`, não `sync`: o que for apagado localmente **continua** no remoto.

### 4.1 Configurar o remoto do rclone

```bash
rclone config          # n) new remote → escolha o tipo e siga o assistente
rclone listremotes
```

- **Cloudflare R2:** tipo `s3`, provider `Cloudflare`, com Access Key/Secret e endpoint
  `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`. Destino: `BACKUP_REMOTE=r2:nome-do-bucket`.
- **Google Drive:** tipo `drive`. Numa VPS sem navegador, responda *n* para "Use web browser" e siga o
  `rclone authorize "drive"` numa máquina com navegador. Destino: `BACKUP_REMOTE=gdrive:nome-da-pasta`.

### 4.2 Configurar e testar

```bash
cd /opt/apps/weddingrafessa
cat > backup.env <<'EOF'
BACKUP_REMOTE=r2:nome-do-bucket
EOF
chmod 600 backup.env                       # não é versionado
chmod +x scripts/backup.sh

sudo ./scripts/backup.sh --check           # confere sqlite3, rclone, banco e acesso ao remoto
sudo ./scripts/backup.sh                   # primeiro backup de verdade
```

Rode como **root** (o script abre o SQLite com o uid do dono do banco, 1000) ou como o próprio usuário 1000.
As variáveis opcionais (`APP_DIR`, `DATA_DIR`, `BACKUP_DIR`, `BACKUP_KEEP_DB`, `RCLONE_FLAGS`) estão
documentadas no topo do script.

### 4.3 Cron (a cada 10 minutos)

```bash
sudo crontab -e
```

```cron
*/10 * * * * /opt/apps/weddingrafessa/scripts/backup.sh >> /var/log/weddingrafessa-backup.log 2>&1
```

O script usa `flock`: se uma rodada demorar, a próxima é pulada. Depois do evento, remova a linha do cron.

### 4.4 Restaurar

```bash
docker compose stop weddingrafessa
cp -a data/db/app.db data/db/app.db.antes-do-restore 2>/dev/null
rm -f data/db/app.db-wal data/db/app.db-shm
cp backups/db/app-<carimbo>.db data/db/app.db     # ou: rclone copy <remoto>/db/app-<carimbo>.db data/db/
# Fotos: rclone copy <remoto>/photos data/photos ; rclone copy <remoto>/thumbs data/thumbs
sudo chown -R 1000:1000 data
docker compose start weddingrafessa
```

## 5. Limpar os dados de teste antes do evento

`scripts/reset-data.mjs` apaga **fotos, miniaturas, arquivos temporários e as tabelas Guest/Photo** (o banco,
o schema e as migrações ficam). Ele mostra o que vai apagar e exige digitar `APAGAR`. Rode com a API **parada**:

```bash
cd /opt/apps/weddingrafessa
docker compose stop weddingrafessa
docker compose run --rm --no-deps weddingrafessa node /app/scripts/reset-data.mjs
docker compose start weddingrafessa
```

`--yes` pula a pergunta, mas **só funciona fora de produção**. Em desenvolvimento: `npm run reset-data`.
Lembre de **voltar `UPLOAD_OPENS_AT`** ao valor real e recriar o container (`docker compose up -d`).

## 6. Durante e depois do evento

```bash
docker compose logs -f --tail=100 weddingrafessa     # logs estruturados (sem IP em claro)
docker stats weddingrafessa --no-stream               # memória (limite 1 GiB)
df -h data                                            # o app recusa uploads com pouco espaço livre
```

**Admin (`/admin`).** Abra `https://fotos.seudominio.com/admin` com `ADMIN_USER`/`ADMIN_PASSWORD`. A página
mostra as fotos mais recentes (as ocultas ficam esmaecidas), com **Ocultar / Reexibir**, **Carregar mais**,
**Atualizar** (e atualiza sozinha a cada 30 s) e o botão de **download do ZIP**. Ocultar tira a foto da galeria de
todos em poucos segundos; o arquivo continua no disco e no backup. Funciona bem no celular.

> **Cuidado com o limite de login.** Estourado o limite de tentativas erradas (`ADMIN_MAX_FAILURES_PER_WINDOW`),
> até a senha certa é recusada (`429`) até a janela passar. Como os convidados dividem o Wi-Fi, use `30` em
> produção e entre no admin pelos **dados móveis** do celular.

> **Reexibir também traz de volta fotos que o próprio convidado apagou:** não há distinção entre "apagada pelo
> dono" e "ocultada pelo admin". Cada convidado pode apagar as próprias fotos; elas somem da galeria, mas o
> arquivo continua no disco e no backup (e vai para `_ocultas/` no ZIP) e continua contando na cota dele.

**Baixar todas as fotos (ZIP).** Abra `https://fotos.seudominio.com/api/admin/export.zip` (mesmo login) ou:

```bash
curl -u admin -o fotos.zip https://fotos.seudominio.com/api/admin/export.zip
```

- **Estrutura:** uma pasta por convidado, `<nome>-<id curto>/<HHmmss>-<id da foto>.jpg`. Ocultas/apagadas ficam em
  `_ocultas/<mesma pasta>/…`; arquivos registrados mas ausentes no disco são listados em `_faltando.txt`.
- **Streaming:** o ZIP é gerado enquanto baixa, sem compressão. Não há barra de progresso confiável nem retomada:
  se a conexão cair, recomeça do zero. Com milhares de fotos são vários GB, então **baixe no Wi-Fi ou no cabo**.
- **Uma exportação por vez:** a segunda recebe `429 export_in_progress`; espere ~30 s.
- **Alternativas:** `scp -r usuario@<ip>:/opt/apps/weddingrafessa/data/photos ./fotos` ou
  `rclone copy <remoto>/photos ./fotos` (do backup, sem depender da VPS).

## 7. Personalizar para o seu evento

- **Nome, datas e limites:** só no `.env` (seção 2).
- **Monograma/identidade:** `web/src/brand.ts` (monograma) e `web/src/styles.css` (paleta em variáveis CSS).
  Fontes e SVGs ficam em `web/src/fonts/` e `web/src/assets/`.
- **Textos:** em português, nos componentes de `web/src/components/` e em `web/src/api.ts` (mensagens de erro).
- **Fuso horário:** `TZ` e o offset de `UPLOAD_OPENS_AT`/`UPLOAD_CLOSES_AT` no `.env`; o horário dentro do ZIP usa
  `America/Sao_Paulo` (ajuste em `server/src/zipExport.ts` se estiver em outro fuso).

## 8. Problemas comuns

| Sintoma | O que verificar |
|---|---|
| Container reinicia em loop | `docker compose logs weddingrafessa`: env inválida (lista os campos) ou permissão de `data/` (`sudo chown 1000:1000 data`) |
| `502` do Caddy | o app está na rede `proxy`? `docker network inspect proxy`; `docker compose ps` (healthy?) |
| Certificado HTTPS não emite | o registro **A** do domínio aponta para o IP da VPS? As portas 80/443 estão abertas? `docker logs caddy` |
| `/e/<slug>` dá 404 | o slug do QR é igual a `EVENT_SLUG` do `.env`? Mudou o `.env`? `docker compose up -d` recria o container |
| "O envio de fotos ainda não abriu" | `UPLOAD_OPENS_AT` no `.env` (ISO com offset) |
| Câmera não abre | precisa de HTTPS e de navegador nativo (Safari/Chrome), não de navegador interno de app (WhatsApp, Instagram) |
| Upload 507 | pouco espaço em disco (`MIN_FREE_DISK_MB`); `df -h` |
| `429` no admin com a senha certa | limite de tentativas erradas: espere o `Retry-After` ou use outro IP (dados móveis) |
| ZIP baixado incompleto | a conexão caiu (não há retomada): baixe de novo no Wi-Fi/cabo, ou use `rclone`/`scp` |
| Erro de permissão no banco após backup | use o `backup.sh` como está; arrume com `sudo chown -R 1000:1000 data` |

## Estrutura do repositório

```
server/     API Express + Prisma (src/, prisma/, test/, admin-ui/)
web/        React + Vite
scripts/    backup.sh, reset-data.mjs
docker/     entrypoint.sh
Dockerfile, docker-compose.yml, .env.example
AGENTS.md   especificação completa do projeto
PROGRESS.md histórico de desenvolvimento · BUGS.md registro de bugs
```

## Licença

[MIT](LICENSE).
