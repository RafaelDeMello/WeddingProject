# PROGRESS — weddingrafessa

Registro cronológico do projeto. **Somente acréscimo**: cada fase concluída ganha uma nova entrada no final do arquivo. Entradas antigas nunca são editadas; se algo mudou, registre em uma entrada nova explicando a mudança.

Leia este arquivo inteiro no início de toda sessão, junto com o `AGENTS.md` e o `BUGS.md`.

## Modelo de entrada

```md
---

## [AAAA-MM-DD] Fase N — <título>

**Ferramenta/modelo:** <OpenCode + modelo / Claude Code>
**Status:** concluída | parcial

### O que foi feito
- ...

### Decisões tomadas
- <decisão> — <motivo>

### Desvios da especificação
- <o que mudou em relação ao AGENTS.md e por quê> (ou "Nenhum")

### Arquivos principais
- `caminho/arquivo` — <papel>

### Como rodar / testar
- `comando`

### Testes
- <N> passando, <N> falhando (detalhar falhas)

### Pendências para a próxima fase
- ...

### Bugs relacionados
- BUG-XXX (ou "Nenhum")
```

---

## [2026-09-29] Fase 0 — Planejamento e infraestrutura

**Ferramenta/modelo:** planejamento feito fora do repositório
**Status:** concluída

### O que foi feito
- Especificação completa escrita no `AGENTS.md`.
- VPS preparada: containers de outros serviços de um projeto anterior derrubados com `docker compose down` (volumes preservados). Sistema atualizado e reiniciado (kernel `(versão do kernel)`).
- Na VPS resta apenas o container `caddy` (portas 80/443), com compose em `/opt/caddy`. Ele sobe sozinho após reboot.
- DNS criado: o subdomínio do evento aponta para o IP da VPS (propagado e verificado).

### Decisões tomadas
- Deploy na VPS própria em vez de Vercel + Supabase — VPS já paga, sem limite de armazenamento, Caddy já funcionando.
- SQLite em vez de Postgres — necessário para nome do convidado e cotas por janela; um arquivo só, no mesmo volume e backup das fotos.
- Câmera própria com `getUserMedia` + fallback `<input capture>` — convidados abrem o QR pela câmera do celular (Safari/Chrome), não por navegadores internos de apps.
- Cota real por convidado; limite por IP generoso — convidados no Wi-Fi do salão compartilham IP.

### Desvios da especificação
- Nenhum.

### Pendências para a próxima fase
- Fase 1: scaffold do monorepo, validação de env, Prisma + migração, `/api/health`.
- Antes do deploy: inspecionar Caddyfile e redes do `caddy` para definir como o app será alcançado.
- Pós-casamento (fora do escopo deste projeto): mover o Caddy para uma pasta própria de infra e limpar as entradas DNS/Caddy antigas.

### Bugs relacionados
- Nenhum.

---

## [2026-09-29] Fase 1 — Scaffold, env, Prisma + migração, `/api/health`

**Ferramenta/modelo:** Claude Code (Opus 5.5)
**Status:** concluída

### O que foi feito
- `AGENTS .md` renomeado para `AGENTS.md` (`git mv`); `CLAUDE.MD` → `CLAUDE.md` importando `@AGENTS.md`, `@PROGRESS.md` e `@BUGS.md`.
- Monorepo com npm workspaces (`server`, `web`), versões fixadas, `.gitignore` cobrindo `.env`, `data/`, `*.db*`.
- Validação de todas as envs com Zod no boot (`server/src/env.ts`); falha rápida com mensagem apontando a variável.
- Prisma 6.19.3 + SQLite: schema idêntico à spec, `binaryTargets = ["native", "debian-openssl-3.0.x"]`, migração `init`.
- Na inicialização: cria `DATA_DIR/{db,photos,thumbs,tmp}`, ativa `journal_mode=WAL` e `busy_timeout=5000`.
- App Express (`createApp` testável + `index.ts` com shutdown gracioso): `trust proxy 1`, sem `x-powered-by`, `express.json({ limit: '10kb' })`, `GET /api/health`, 404/413/400/500 no formato `{ error: { code, message } }`, logs com pino.
- Esqueleto React + Vite com proxy de `/api` e `allowedHosts: ['.trycloudflare.com']`; `npm run dev` sobe os dois com `concurrently`.

### Decisões tomadas
- Prisma fixado em 6.x — o 7 exige driver adapter e remove `url` do schema, conflitando com a spec (aprovado).
- TypeScript 5.9.3 em vez do 7.x (port nativo recente) — menor risco no prazo.
- `prisma` em `dependencies` (não dev) — o container precisa do CLI para `prisma migrate deploy`.
- `server/prisma.config.ts` carrega o `.env` da raiz só se `DATABASE_URL` não estiver definido — em dev o `.env` fica na raiz; no container as envs vêm do compose.
- Em dev, `DATA_DIR=../data` e `DATABASE_URL=file:../../data/db/app.db` (relativos a `server/` e `server/prisma/`); ambos apontam para `data/` na raiz. Documentado no `.env.example`.
- Validação de env mais estrita que o texto da spec: datas exigem offset explícito (rejeita `Z` e sem offset), `PUBLIC_BASE_URL` exige https em produção e é normalizada para a origem, segredos com tamanho mínimo e rejeição de placeholders `<...>`.
- Testes: `globalSetup` roda `prisma migrate deploy` num banco-modelo temporário; cada suíte copia o arquivo (isolamento, sem tocar em `data/`).
- Dependências aprovadas para as próximas fases: helmet, pino-http, archiver, express-rate-limit, cookie-parser (cookie assinado, sem HMAC manual), multer, sharp, file-type, `@types/*`.

### Desvios da especificação
- **Aprovado para a Fase 3:** concorrência da cota com lock em memória por guest + transação + `busy_timeout` (o Prisma usa transações `DEFERRED` no SQLite; sem o lock, dois uploads simultâneos poderiam ler a mesma contagem). Válido porque há um único container/processo.
- **Aprovado para a Fase 2:** checagem de `Origin` relaxada **apenas** com `NODE_ENV=development` (aceita também `localhost` e `*.trycloudflare.com`); em produção continua estrita. Testes devem cobrir os dois casos.
- **Aprovado para a Fase 6:** script `scripts/reset-data` que apaga banco e fotos de teste antes do evento, com confirmação interativa.

### Arquivos principais
- `package.json` — workspaces e scripts (`dev`, `build`, `test`, `typecheck`, `db:migrate`)
- `.env.example` — todas as envs, com notas para dev
- `server/src/env.ts` — schema Zod das envs
- `server/src/db.ts` — PrismaClient, WAL/busy_timeout, diretórios de dados
- `server/src/app.ts` / `server/src/errors.ts` / `server/src/logger.ts` / `server/src/index.ts`
- `server/prisma/schema.prisma` + `server/prisma/migrations/*_init`
- `server/test/*` — globalSetup, helpers e testes
- `web/` — esqueleto Vite + React

### Como rodar / testar
- `cp .env.example .env` e ajustar para dev (ver comentário no topo do arquivo)
- `npm install`
- `npm run db:migrate`
- `npm run dev` → http://localhost:5173 (API em :3000)
- `npm test` / `npm run typecheck` / `npm run build`

### Testes
- 21 passando, 0 falhando (env: 15; app: health, 404, 413, JSON inválido; banco: WAL ativo, migração + unique `(guestId, clientUploadId)`).
- Manual: `npm run dev` respondeu `/api/health` direto e via proxy do Vite; `node dist/index.js` sem envs sai com código 1 e lista as variáveis inválidas.

### Pendências para a próxima fase
- Fase 2: guests + sessão (cookie-parser assinado) + `/api/event` + `/api/me` + checagem de `Origin` (estrita em produção, relaxada em dev), helmet/CSP, pino-http.
- Fase 3: `PRAGMA busy_timeout` vale por conexão e o Prisma pode abrir várias conexões SQLite — avaliar `connection_limit=1` na `DATABASE_URL` junto com o lock por guest.
- Fase 6: o entrypoint precisa criar `/data/db` antes de `prisma migrate deploy`; a imagem precisa incluir `prisma/`, `prisma.config.ts` e o CLI do Prisma.
- Fase 6: npm 11 (local) bloqueia install scripts não aprovados (`allowScripts`) — Prisma e esbuild funcionaram localmente, mas conferir o `npm ci` no build da imagem (Node 22 vem com npm 10, que roda os scripts).
- `npm audit`: 3 alertas altos em `deepmerge-ts`, dependência de `@prisma/config` (loader de config do CLI, não processa input de usuário). O "fix" sugerido faz downgrade do Prisma; não aplicado.
- `EVENT_NAME` ainda com o nome da noiva por definir.

### Bugs relacionados
- Nenhum.

---

## [2026-09-29] Fase 2 — Guests, sessão, `/api/event`, `/api/me`

**Ferramenta/modelo:** Claude Code (Opus 5.5)
**Status:** concluída

### O que foi feito
- `GET /api/event` → `{ name, status, opensAt, closesAt, limits }`, com status `not_open` / `open` / `closed` calculado por relógio injetável (`AppDeps.now`).
- `POST /api/guests`, nesta ordem: Origin → rate limit por IP → Zod (400 `validation_error`) → slug (404 `event_not_found`) → janela (403 `upload_closed`, mensagem distinta para "ainda não abriu" e "encerrado") → sessão válida existente (200 com o mesmo guest) → cria guest (201) e define cookie.
- Nome: remove caracteres de controle, espaços de largura zero, BOM e overrides bidi (mantém ZWJ de emojis), colapsa espaços, trim, NFC; 1–40 code points.
- Guest salva `ipHash = sha256(ip + SESSION_SECRET)` e `userAgent` truncado em 255.
- `GET /api/me` → `{ guestId, name, quota }` com cota real calculada da tabela `Photo` (vazia até a Fase 3).
- `POST /api/session/logout` → apaga o cookie (idempotente, protegido pela checagem de Origin). O guest continua no banco.
- Sessão: `cookie-parser` com `SESSION_SECRET`; cookie `wr_session` assinado (HMAC-SHA256), `httpOnly`, `SameSite=Lax`, `Path=/`, `Secure` só em produção, expira 1 dia após `UPLOAD_CLOSES_AT`. `requireGuest` valida assinatura → formato UUID → guest existe no banco; se falhar, 401 `unauthorized` e apaga o cookie.
- Checagem de `Origin` em `/api` para POST/PUT/PATCH/DELETE: estrita em produção (igual a `PUBLIC_BASE_URL`, ausente = 403 `invalid_origin`); em `development` aceita também `localhost`/`127.0.0.1` (http/https) e `https://*.trycloudflare.com`.
- helmet com CSP restritiva (`default-src 'self'`, `img-src 'self' blob: data:`, `media-src 'self' blob:`, `object-src 'none'`, `frame-ancestors 'none'`…); HSTS e `upgrade-insecure-requests` só em produção; `Permissions-Policy: camera=(self), microphone=(), geolocation=()`.
- Rate limit de criação de convidado: `express-rate-limit`, `IP_MAX_GUESTS_PER_WINDOW` (padrão 30) a cada 10 min, store em memória. 429 padronizado: `{ error: { code: 'rate_limited', message, retryAfterSeconds } }` + header `Retry-After` (helper `sendRateLimited`, reaproveitável na Fase 3).
- pino-http com id por request; loga só método, URL e status (sem IP, cookie ou Authorization); ignora `/api/health`.

### Decisões tomadas
- Nova env opcional `IP_MAX_GUESTS_PER_WINDOW` (padrão 30), validada no `env.ts` e documentada no `.env.example` — aprovado.
- `POST /api/guests` com sessão válida devolve 200 com o guest existente, ignorando o nome novo — aprovado; evita duplicatas em reload/duplo toque.
- `resetsAt: null` quando não há fotos na janela — aprovado.
- `remainingInWindow` é limitado também por `remainingTotal` (não mostra 10 na janela se só restam 3 no total). Fotos ocultas continuam contando na cota.
- A checagem de sessão existente em `POST /api/guests` vem depois de slug e janela: fora da janela, nem quem já tem sessão "entra" de novo.
- `retryAfterSeconds` vai dentro de `error` no corpo do 429.

### Desvios da especificação
- **Aprovado:** rota nova `POST /api/session/logout` (não prevista na spec), para pessoas diferentes usarem o mesmo celular. O botão "Não é você?" fica para a Fase 5.
- **Aprovado:** env nova `IP_MAX_GUESTS_PER_WINDOW` (a spec pede limites configuráveis, mas não listava esta).
- Checagem de Origin relaxada em dev, conforme aprovado na Fase 1.

### Arquivos principais
- `server/src/session.ts` — cookie assinado, `requireGuest`, `loadSessionGuest`
- `server/src/security.ts` — helmet/CSP, Permissions-Policy, checagem de Origin
- `server/src/rateLimit.ts` — limite de criação de convidado por IP
- `server/src/guestName.ts` — schema/normalização do nome
- `server/src/event.ts` — status e payload do evento
- `server/src/quota.ts` — cálculo de cota (reaproveitado na Fase 3)
- `server/src/routes/{event,guests,session}.ts`
- `server/test/{guests,session,security,event}.test.ts`

### Como rodar / testar
- `npm test`
- `npm run dev` e, por exemplo: `curl -c jar -H 'Origin: http://localhost:5173' -H 'Content-Type: application/json' -d '{"slug":"<EVENT_SLUG>","name":"Ana"}' http://localhost:5173/api/guests` → `curl -b jar http://localhost:5173/api/me`

### Testes
- 76 passando, 0 falhando.
- Cobertos: nome válido/inválido (vazio, espaços, controles, 41 chars, tipo errado, ausente), NFC e caracteres invisíveis, emoji contando 1; slug errado; antes/depois da janela; sessão existente → 200 sem duplicar; ipHash sem IP em claro; cookie adulterado (guestId trocado, assinatura alterada, sem assinatura, outro segredo); guest inexistente com assinatura válida; flags do cookie em produção e dev; logout (apaga cookie, idempotente, exige Origin); Origin em produção (ausente, outro domínio, subdomínio parecido, http, `null`, localhost, trycloudflare) e em dev; CSP/HSTS/Permissions-Policy; rate limit com 429 + `Retry-After` e isolamento por IP; três estados do evento; cota com janela deslizante, `resetsAt`, fotos ocultas e piso zero.
- Verificação de mutação: tirar `Secure` em produção e liberar Origin de dev em produção quebram 3 testes.
- Manual: fluxo event → guests → me → logout → me (401) via proxy do Vite; POST sem Origin → 403.

### Pendências para a próxima fase
- Fase 3: `connection_limit=1` na `DATABASE_URL` (aprovado) + lock em memória por guest + transação; reusar `getQuota` e `sendRateLimited`; limite de upload por IP (`IP_MAX_UPLOADS_PER_WINDOW`).
- **Fase 5:** validar que a CSP (`script-src 'self'`, `style-src 'self'`) não bloqueia o SPA compilado servido pelo Express (scripts/estilos inline do build do Vite).
- Fase 5: rota `/e/:slug` servindo o SPA, com 404 para slug diferente de `EVENT_SLUG`; botão "Não é você?" chamando `POST /api/session/logout`.
- O rate limit em memória zera quando o container reinicia — aceitável (é só proteção contra abuso, a cota real está no banco).
- Dependências desta fase instaladas com `--ignore-scripts`: um `npm run dev` aberto travava o DLL do engine do Prisma no Windows. O schema não mudou, então o client gerado continua válido.

### Bugs relacionados
- Nenhum.

---

## [2026-09-30] Fase 3 — Upload completo: validação, sharp, cotas, idempotência, disco

**Ferramenta/modelo:** Claude Code (Opus 5.5 / Sonnet 5.5)
**Status:** concluída

### O que foi feito
- `POST /api/photos` (multipart: `photo` + `clientUploadId`), com as checagens nesta ordem: Origin (403) → rate limit por IP (429 `rate_limited`) → sessão (401) → janela de upload (403 `upload_closed`) → espaço em disco (507 `insufficient_storage`) → multer → Zod estrito (400 `validation_error`) → **idempotência** (200 com a foto existente, sem olhar a cota) → **cota fail-fast** (429) → magic bytes (415) → sharp (422) → gravação → **lock do convidado + transação** (recheca idempotência e cota, insere) → 201 `{ id, quota }`.
- Erros do multer: arquivo grande → 413 `file_too_large`; arquivo extra, campo de arquivo com outro nome, campos demais/grandes, multipart malformado → 400 `invalid_upload`; sem arquivo ou corpo não multipart → 400 `missing_photo`; campo de texto desconhecido → 400 `validation_error`. Limites: `files: 1`, `fileSize: MAX_UPLOAD_BYTES`, `fields: 5`, `fieldSize: 1 KB`, `parts: 6`.
- `clientUploadId`: `z.uuid()` estrito, normalizado para minúsculas (`ABC…` e `abc…` são a mesma foto).
- Imagem: `file-type` (só jpeg/png/webp, ignora Content-Type e nome) → sharp com `limitInputPixels` 50 MP, `.rotate()`, máximo 2000px sem ampliar, JPEG q85, sem metadados (EXIF/GPS removidos) → miniatura 400px. Falha de decodificação/limite de pixels → 422 `invalid_image`.
- Disco: gravação em `data/tmp/<uuid>.part` + `rename` atômico para `photos/AAAA-MM-DD/<photoId>.jpg` (dia no fuso `America/Sao_Paulo`) e `thumbs/<photoId>.jpg`. Caminhos gravados no banco são relativos a `DATA_DIR`. Nomes sempre gerados pelo servidor.
- Limpeza: `PhotoFiles` registra tudo o que criou; se o request não termina em commit (cota estourada na recheca, duplicata concorrente, exceção), apaga os arquivos antes de responder. `data/tmp` é esvaziado no boot.
- Espaço em disco: `statfs` injetável (`AppDeps.statfs`); abaixo de `MIN_FREE_DISK_MB` → 507 e log de erro `ALERTA…`. Se o `statfs` falhar, o envio segue (log de aviso).
- Cota: 429 `quota_exceeded` (janela; `retryAfterSeconds` até a foto mais antiga sair da janela) e 429 `total_quota_exceeded` (`retryAfterSeconds` até `UPLOAD_CLOSES_AT`, mensagem sem "tente em X min"). Ambos com header `Retry-After`. `Photo.createdAt` usa o relógio injetável.
- `connection_limit=1` aplicado automaticamente na `DATABASE_URL` (`withConnectionLimit`), além de WAL e `busy_timeout`.
- Concorrência: `KeyedMutex` (lock por convidado) + transação interativa; `Semaphore` limita a **2 processamentos de imagem simultâneos**; `sharp.cache(false)`.
- Rate limit de upload por IP (`IP_MAX_UPLOADS_PER_WINDOW`, 10 min) contando toda tentativa, antes de ler o corpo.

### Decisões tomadas
- Idempotência vem **antes** da cota — um retry legítimo de foto já aceita não pode falhar por cota esgotada.
- Processamento pesado (decodificar, gravar) fica **fora** do lock; só recheca + insert são serializados — fotos de convidados diferentes processam em paralelo.
- Arquivos são gravados antes do insert: se o processo cair entre o `rename` e o insert, sobra no máximo um arquivo sem registro (inofensivo: não aparece no admin nem no ZIP). O inverso (registro sem arquivo) quebraria o ZIP.
- HEIC não é aceito (415): o fluxo normal passa pelo canvas (JPEG) e o Safari converte HEIC no `<input capture>`. **Confirmar num iPhone real na Fase 5.**
- Fotos ocultas continuam contando na cota (já na Fase 2).
- Com `connection_limit=1` as transações já se serializam no banco; o lock por convidado continua (aprovado) como defesa explícita, barata e independente da configuração do pool.

### Desvios da especificação
- **Mudança de spec (aprovada):** padrões dos limites por IP: `IP_MAX_UPLOADS_PER_WINDOW` 200 → **1000** e `IP_MAX_GUESTS_PER_WINDOW` 30 → **150** (`env.ts` e `.env.example`). Motivo: dezenas de convidados dividem o IP do Wi-Fi do salão; a cota real é por convidado e o limite por IP é só proteção contra abuso. **O `AGENTS.md` ainda mostra 200/30** (não editei a especificação por conta própria).
- **Aprovado (Fase 1):** lock em memória por convidado + transação + `busy_timeout` + `connection_limit=1`, em vez de apenas "transação".
- **Aprovado:** 429 `total_quota_exceeded` com `retryAfterSeconds` até `UPLOAD_CLOSES_AT`.
- **Aprovado:** semáforo de 2 processamentos simultâneos + `sharp.cache(false)`; **na Fase 6 usar `mem_limit: 1g`** no compose (a spec dizia 512m).
- Limites extras do multer além da spec: `fieldSize: 1 KB` e `parts: 6`.

### Arquivos principais
- `server/src/routes/photos.ts` — a rota e a ordem das checagens
- `server/src/upload.ts` — multer e mapeamento de erros
- `server/src/imageProcessing.ts` — magic bytes, sharp, miniatura
- `server/src/storage.ts` — gravação atômica, descarte, `statfs`, limpeza do tmp
- `server/src/concurrency.ts` — `KeyedMutex` e `Semaphore`
- `server/src/quota.ts` — `getQuota` e `quotaBlock`
- `server/src/rateLimit.ts` / `server/src/errors.ts` — limitador por IP e 429 padronizado
- `server/src/db.ts` — `withConnectionLimit`
- `server/test/{photos,photos-limits,concurrency}.test.ts`, `photoHelpers.ts`, `fixtures.ts` (imagens geradas com sharp; nenhum binário commitado)

### Como rodar / testar
- `npm test` / `npm run typecheck` / `npm run build`
- Manual (dev): criar guest (`POST /api/guests`) e depois `curl -b jar -H "Origin: http://localhost:5173" -F photo=@foto.jpg -F clientUploadId=<uuid> http://localhost:3000/api/photos`

### Testes
- 141 passando, 0 falhando (3 execuções seguidas, sem flakiness).
- Cobertos: upload válido (caminhos gerados pelo servidor, 2000px/400px, sem ampliar, PNG/WebP → JPEG, nome malicioso ignorado); EXIF/GPS/orientação (fixture com GPS e orientação 6: arquivo e miniatura sem EXIF, pixels girados); magic bytes (texto `.jpg`, GIF → 415; JPEG com nome `.txt` aceito); JPEG truncado e imagem > 50 MP → 422; tamanho (limite −1, exato, 9 MB); erros do multer (sem arquivo, JSON, dois arquivos, campo com outro nome, campos demais, campo > 1 KB, campo desconhecido, multipart truncado); `clientUploadId` inválido; 401, Origin, fora da janela; cota por janela (429, `Retry-After`, relógio avançando), por convidado, ocultas contam; cota total; **concorrência** (10 em paralelo com limite 3 → 3×201 + 7×429; com total 4; convidados diferentes em paralelo); **idempotência** (repetição, 5 simultâneos, sem consumir cota, com cota esgotada, arquivo inválido no retry); disco (statfs simulado, limite exato, bigint, statfs real, falha ao medir); rate limit por IP (vários convidados no mesmo IP, `Retry-After`, vem antes da sessão, outro IP passa); `KeyedMutex`, `Semaphore`, `withConnectionLimit`.
- Todos os testes de falha verificam que `tmp/` está vazio e que não há arquivo órfão (arquivos no disco == registros no banco).
- Verificação de mutação: remover a recheca da cota na transação quebra 3 testes; remover o descarte de arquivos quebra 4.
- Manual: upload real no servidor de dev (201 → retry 200, cota descontada uma vez, `tmp/` vazio, texto `.jpg` → 415).

### Pendências para a próxima fase
- Fase 4: admin (Basic Auth com `timingSafeEqual`, rate limit de falhas, `no-store`), listagem, thumbs, ocultar, ZIP em streaming. Resolver caminhos sempre a partir de `DATA_DIR` + `filePath` do banco (nunca de input).
- Fase 5: validar CSP com o SPA compilado; `/e/:slug` com 404 para slug errado; botão "Não é você?"; tratar 413/415/422/429 (`quota_exceeded` × `total_quota_exceeded`) e 507 na UI; confirmar HEIC no iPhone.
- Fase 6: `mem_limit: 1g`; entrypoint cria `/data/db` antes do `migrate deploy`; `scripts/reset-data`.
- Risco conhecido: `memoryStorage` mantém o arquivo inteiro na RAM durante o request (normal ~300 KB, fallback até 8 MB); com muitos envios grandes simultâneos o uso de memória sobe — mitigado por `mem_limit: 1g`; conferir no loadtest da Fase 7.
- O rate limit em memória zera ao reiniciar o container (aceitável).

### Bugs relacionados
- Nenhum.

---

## [2026-09-30] Ajuste entre fases — spec atualizada e reordenação das fases

**Ferramenta/modelo:** Claude Code (Sonnet 5.5)
**Status:** concluída

### O que foi feito
- `AGENTS.md` atualizado para refletir o que foi aprovado na Fase 3: limites por IP de **1000 uploads** e **150 criações de convidado** a cada 10 min (antes 200 e 30), nova env `IP_MAX_GUESTS_PER_WINDOW=150` na lista de variáveis, e `mem_limit: 1g` no container (antes 512m).

### Decisões tomadas
- **Reordenação das fases por causa do prazo:** a Fase 4 (admin) fica para depois — as fotos ficam no disco e o admin só é necessário após o casamento. A próxima fase passa a ser a **Fase 6** (Docker, compose, `.env.example`, README de deploy e `scripts/reset-data`), que também inclui o `scripts/backup.sh` (antes na Fase 7). Ordem efetiva: 6 (+ backup) → 5 (front) → 4 (admin) → loadtest da 7.
- A Fase 5 (front) continua indispensável antes do evento; o `/e/:slug` servindo o SPA é antecipado para a Fase 6.
- `web/.env.local` entra no `.dockerignore`.

### Desvios da especificação
- **Ordem de implementação** diferente da seção "Ordem de implementação" do `AGENTS.md` (aprovado). O texto dessa seção não foi alterado; vale esta entrada.
- Sem acesso ao admin até a Fase 4, baixar as fotos exige acesso à VPS (`docker cp` / o backup remoto do rclone).

### Arquivos principais
- `AGENTS.md` — tabela de limites, lista de envs e `mem_limit`

### Como rodar / testar
- Não se aplica (só documentação).

### Testes
- Nenhum teste alterado; a suíte continua em 141 passando.

### Pendências para a próxima fase
- Fase 6 (com backup e `/e/:slug`), conforme o entendimento a ser aprovado.
- Risco a acompanhar: sem `/admin`, o único caminho para ver/baixar as fotos antes da Fase 4 é o backup no remoto e o acesso à VPS.

### Bugs relacionados
- Nenhum.

---

## [2026-09-30] Fase 6 — Docker, compose, README de deploy, reset-data, backup e `/e/:slug` (antecipado da Fase 5)

**Ferramenta/modelo:** Claude Code (Sonnet 5.5)
**Status:** concluída

### O que foi feito
- **SPA servido pelo Express** (`server/src/spa.ts`): `GET /e/<EVENT_SLUG>` devolve o `index.html` do build (`Cache-Control: no-cache`); slug errado, `/e/`, `/e/<slug>/extra`, `/`, `/index.html` e qualquer outro caminho → **404 HTML simples** que não entrega o app. `/assets/*` (e demais arquivos do build) via `express.static` só sobre `web/dist`, com `max-age=1 ano, immutable` em `/assets`. `X-Robots-Tag: noindex`. Nada de `DATA_DIR` é servido. Env nova e opcional `WEB_DIST_DIR` (padrão `../web/dist`). Em produção, sem build do front o servidor nem sobe.
- **Dockerfile multi-stage** (`node:22-bookworm-slim` + `openssl`): `build` (npm ci + `vite build` + `tsc`), `prod-deps` (`npm ci --omit=dev -w server`, com o CLI do prisma e o client gerado para `debian-openssl-3.0.x`) e `runtime` (sem devDependencies nem código-fonte, usuário **não-root** `node`, `HOME=/tmp`, healthcheck em `/api/health`). Imagem de ~771 MB.
- **`docker/entrypoint.sh`**: cria `/data/{db,photos,thumbs,tmp}`, roda `prisma migrate deploy --schema prisma/schema.prisma` e faz `exec node dist/index.js`. **Com argumentos executa o comando pedido** (sem migrar nem subir a API) — necessário para o `reset-data` via `docker compose run`.
- **`docker-compose.yml`**: serviço/container/alias `weddingrafessa` na rede externa **`proxy`** (a do Caddy), **sem publicar portas**; `mem_limit: 1g`, `cpus: 1`, `read_only: true` + `tmpfs /tmp`, `cap_drop: ALL`, `no-new-privileges`, `init: true`, `restart: unless-stopped`, bind mount `./data:/data`.
- **`.dockerignore`** sem segredos/dados (`.env*`, `web/.env.local`, `data`, `*.db*`, `backup.env`, testes, `node_modules`, `dist`).
- **`scripts/reset-data.mjs`** (+ `npm run reset-data`): mostra o que vai apagar (fotos/convidados no banco e arquivos/MB por pasta), exige digitar `APAGAR`; apaga o conteúdo de `photos/`, `thumbs/`, `tmp/` e zera `Photo`/`Guest` (banco, schema e migrações ficam; `wal_checkpoint` + `VACUUM`). `--yes` só fora de produção. Recusa diretório que não parece de dados do app.
- **`scripts/backup.sh`**: backup online do SQLite (`sqlite3 ".backup"` com `-readonly`, dentro de um diretório de trabalho do dono do banco) + `integrity_check` + `rclone copy` (nunca `sync`) de `photos/`, `thumbs/` e `db/`; `flock` (rodada anterior em andamento → pula), rotação local (`BACKUP_KEEP_DB`, padrão 144), `--check` (valida ferramentas, banco e remoto), configuração por ambiente ou `backup.env`. Como root, abre o SQLite com o uid do dono do banco (`setpriv`) para não criar `-wal/-shm` de root ao lado do banco em uso.
- **README** reescrito: dev local, envs, deploy passo a passo, **Caddy** (inspecionar → backup do Caddyfile → `tee -a`/`nano` → conferir o que o **container** enxerga → `caddy validate` → `caddy reload`; aviso do bind mount de arquivo único; como desfazer; nunca reiniciar o Caddy), verificação pós-deploy, rclone (R2/Drive), cron, restore, reset, rotina, como pegar as fotos sem admin, problemas comuns.
- `.gitattributes`: `*.sh` e `Dockerfile` com `eol=lf`.

### Decisões tomadas
- **Bind mount `./data:/data`** em vez de volume nomeado (aprovado) — o backup e o acesso às fotos (sem admin) usam um caminho simples no host: `/opt/apps/weddingrafessa/data`. O README exige `mkdir data && sudo chown 1000:1000 data` antes do primeiro `up`.
- `prisma.config.ts` **não** vai para a imagem: o CLI roda com `--schema` e as envs vêm do compose (evita carregar TypeScript em runtime).
- `index.html` nunca em cache; `/assets` imutáveis (nomes com hash).
- O `reset-data` roda num **container avulso** (`docker compose stop` + `docker compose run --rm --no-deps …`) e não no container da API. Por isso ele **não** detecta se a API está no ar (mudança em relação ao entendimento aprovado, que previa recusar); o README manda parar a API e a confirmação `APAGAR` é obrigatória em produção.
- Backup roda como root (ou uid 1000) no host; `sqlite3`/`rclone` ficam no host, não na imagem.
- O teste do SPA faz um `vite build` real em pasta temporária no `globalSetup` do Vitest: a verificação de CSP vale para o build de verdade e vai cobrir automaticamente o front novo após o merge.

### Desvios da especificação
- **Aprovado:** bind mount `./data:/data` no lugar do volume nomeado `weddingrafessa_data:/data` (spec, seção Docker).
- **Aprovado:** reordenação — Fase 6 (+ `backup.sh`) antes da 5 e da 4; `/e/:slug` antecipado da Fase 5.
- **Aprovado:** env nova opcional `WEB_DIST_DIR`.
- Rede: o app entra na rede externa `proxy` do Caddy, sem publicar portas (padrão existente da VPS), conforme a inspeção informada.
- Entrypoint aceita argumentos (exec do comando) — extensão ao "entrypoint = migrate deploy && node dist/index.js" da spec.

### Arquivos principais
- `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `docker/entrypoint.sh`
- `server/src/spa.ts`, `server/src/app.ts`, `server/src/index.ts`, `server/src/env.ts`
- `scripts/reset-data.mjs`, `scripts/backup.sh`
- `README.md`, `.env.example`, `.gitattributes`, `.gitignore`
- `server/test/spa.test.ts`, `server/test/resetData.test.ts`, `server/test/globalSetup.ts`

### Como rodar / testar
- `npm test` (174 testes; o `globalSetup` compila o front)
- Local com Docker: `docker build -t weddingrafessa:test .` e subir com o compose usando um `.env` de teste (precisa existir a rede `proxy`: `docker network create proxy`)
- VPS: seguir o README (seções 3, 4 e 5)

### Testes
- **174 passando, 0 falhando** (duas execuções seguidas). Novos: 23 do SPA/CSP + 10 do `reset-data`.
- SPA/CSP (contra o build real): slug certo/errado/maiúsculas/sem slug/subcaminho/raiz/`index.html`/POST; `/api` segue em JSON; sem build o `/e/:slug` não existe; assets com tipo e cache corretos; path traversal (`%2e%2e`, barra invertida, byte nulo) não vaza o banco; nada de `DATA_DIR` público; `index.html` sem script/estilo/handler inline nem recursos externos; CSS só com `url()` da própria origem ou `data:image`; JS sem `eval`/`new Function`. Mutação (tirar a checagem do slug e do `/index.html`) quebra 3 testes.
- `reset-data`: `APAGAR` zera tudo e mantém pastas e banco; respostas erradas/minúsculas/vazia/entrada encerrada cancelam sem apagar; `--yes` fora de produção; `--yes` em produção recusado; diretório inválido; argumento desconhecido.
- **Docker (local, Docker Desktop):** imagem compila; compose sobe `healthy`; roda como uid 1000, `read_only`, `cap_drop ALL`, `mem=1 GiB`, 1 CPU, **sem portas publicadas**; outro container na rede `proxy` alcança `http://weddingrafessa:3000` (como o Caddy fará); smoke completo em produção (SPA, CSP, HSTS, 404 de slug errado, Origin estrito, guest → cookie `Secure` → upload 201 → retry 200 → texto `.jpg` 415 → cota descontada uma vez); dados persistem em restart/recriação; `reset-data` via `compose run` (resposta errada → cancela; `--yes` → recusado; `APAGAR` → zera) e API sobe normalmente depois; navegador real abriu `/e/<slug>` sem nenhuma violação de CSP no console.
- **`backup.sh` (container Debian com sqlite3 + rclone, como root):** 23 verificações OK — `--check`, backup com o banco sendo escrito em WAL (íntegro), nada de `-wal/-shm` do root, rotação local com remoto preservando tudo, foto apagada localmente continua no remoto, `flock` pula rodada concorrente, erros retornam código ≠ 0; `shellcheck` limpo em `backup.sh` e `entrypoint.sh`.
- Bugs encontrados e corrigidos nesta fase (pelos testes): readline do `reset-data` resolvia a confirmação como cancelada; entrypoint ignorava argumentos (o `compose run` do reset subia a API); `BACKUP_DIR` 700 impedia o `sqlite3` do uid 1000 de gravar o backup.

### Pendências para a próxima fase
- **Depois do merge da branch `FeatWeb`: reexecutar o teste de CSP (`npm test`, suíte `spa.test.ts`) e o teste no Docker** (build da imagem + smoke + abrir `/e/<slug>` no navegador), porque o build terá fontes `.woff2` e SVGs em `/assets`. Pontos de atenção: `font-src 'self'` **não** permite `data:` (fontes pequenas podem ser inlinadas pelo Vite — ajustar `build.assetsInlineLimit` ou a CSP); `style-src 'self'` bloqueia `style="…"` no HTML e `<style>` inline (estilos aplicados via CSSOM/`element.style` pelo React são permitidos).
- **Não executado na VPS** (regra do projeto): nada foi rodado lá. Antes do deploy real, o usuário executa o README (seções 3–5); o `caddy validate` é obrigatório antes do `reload`.
- Fase 5 (front): tratar 413/415/422/429 (`quota_exceeded` × `total_quota_exceeded`) e 507; botão "Não é você?"; confirmar HEIC no iPhone.
- Fase 4 (admin): sem `/admin`, as fotos só são vistas pelo disco/`scp`/backup (README, seção 8).
- Fase 7 (loadtest): conferir memória com `docker stats` sob 50 convidados (limite 1 GiB).
- Backup: testar o `rclone config` real (R2/Drive) na VPS com `backup.sh --check` antes do evento; o teste aqui usou um destino local.
- Antes do evento: rodar o `reset-data` depois dos testes e **voltar `UPLOAD_OPENS_AT`** ao valor real.
- Imagem com ~771 MB; aceitável para a VPS, pode ser enxugada depois.

### Bugs relacionados
- Nenhum.

---

## [2026-09-30] Fase 5 — Front funcional e identidade visual (branch `FeatWeb`, PR #1)

**Ferramenta/modelo:** front desenvolvido na branch `FeatWeb` (sessão separada) e mergeado pelo PR #1 (`bbcfc7b`); revisão pós-merge e este registro: Claude Code (Sonnet 5.5)
**Status:** concluída

### O que foi feito
- Cliente de API tipado (`web/src/api.ts`) com o contrato do `AGENTS.md`: `ApiError` com `code`/`status`/`retryAfterSeconds`, timeouts (15 s JSON, 60 s upload), mensagem do 429 com "tente novamente em X min" e retry automático só para falha de rede e 5xx (507, 429, 4xx não repetem). Mock da API (`VITE_MOCK_API=true|photos`) **somente no `vite dev`**: o build de produção nunca simula e o código do mock não vai para o bundle (verificado).
- Fila de envio (`uploadQueue.ts`): uma foto por vez, backoff exponencial 1 s → 2 s → 4 s → 8 s (máx. 5 tentativas), sempre com o mesmo `clientUploadId`; retry manual, descarte e reenvio quando a internet volta.
- Persistência das fotos pendentes no IndexedDB por `guestId` (`pendingStore.ts`), com reenvio ao reabrir a página e "melhor esforço" se o IndexedDB falhar.
- Câmera com `getUserMedia` (traseira por padrão, botão para virar), liberada quando a aba vai para segundo plano, com **fallback** `<input type="file" accept="image/*" capture="environment">` em qualquer falha (permissão negada, sem suporte, câmera indisponível). Compressão no cliente por canvas: JPEG, lado maior 1600 px, qualidade 0,8 (mesmo caminho no fallback).
- Fluxo do convidado (`App.tsx`, `components/*`): estados do evento (não abriu / aberto / encerrado / link incompleto / evento não encontrado), nome uma única vez, câmera → preview ("Ficou boa?", "Tirar outra" / "Enviar") → lista de envios, "N fotos restantes", aviso de limite, "Foto enviada ✓" e **"Não é você?"** (chama `POST /api/session/logout` e limpa as pendentes do convidado).
- Testes do front com Vitest em `web/test/` (lógica pura: API, fila/backoff, mock).

### Refinamento visual (2026-09-30)
- Identidade do casamento: paleta em variáveis CSS, Cormorant Garamond (títulos/números), Great Vibes (nome do evento, "Obrigado!"), Inter (texto). Fontes woff2 do Fontsource 5.3.0 (subset latin, OFL) em `web/src/fonts/`, servidas pelo app.
- Cartões marfim com borda dupla em sálvia e cantos recortados (`mask` + `-webkit-mask`); câmera em tela cheia com faixas translúcidas; pílula de status que leva à lista; aviso "Foto enviada ✓" por ~2 s; preview em moldura blush.
- Contraste AA verificado (texto 4,98–8,64:1); dourado e sálvia só em detalhes. `prefers-reduced-motion` respeitado. Sem estilos inline.
- Nova cor `--erro #A33A2A` (aprovada). Textos: "N fotos restantes", "Obrigado!" como título do encerramento, "Ficou boa?" no preview.
- Pendência: validar a aparência em iPhone (Safari) e Android (Chrome) reais.

### Decisões tomadas
- O front não muda o contrato da API: toda a lógica de cota, idempotência e erros continua no servidor; o cliente só reage aos códigos (`unauthorized`, `upload_closed`, `rate_limited`, `quota_exceeded`, `insufficient_storage`...).
- Sem estilos inline no HTML (compatível com `style-src 'self'`); fontes como arquivos separados (não inlinadas), compatível com `font-src 'self'`; SVGs pequenos viram `data:image`, permitido por `img-src`.
- `/e/:slug` já era servido pelo Express desde a Fase 6 (antecipado da Fase 5); o front lê o slug do próprio caminho.

### Desvios da especificação
- Nenhum. (A ordem de implementação segue a reordenação registrada em "Ajuste entre fases": Fase 6 antes da 5.)

### Arquivos principais
- `web/src/api.ts`, `web/src/uploadQueue.ts`, `web/src/pendingStore.ts`, `web/src/camera.ts`, `web/src/compress.ts`, `web/src/slug.ts`, `web/src/mockApi.ts`
- `web/src/App.tsx`, `web/src/components/{GuestHome,CameraView,NameForm,PhotoPreview,UploadList,MockPanel}.tsx`
- `web/src/styles.css`, `web/src/fonts/*` (woff2 + licenças OFL), `web/src/assets/*.svg`
- `web/vite.config.ts` (portas por `web/.env.local`, não versionado), `web/vitest.config.ts`, `web/test/*`

### Como rodar / testar
- `npm run dev` (Vite em :5173 com proxy para a API em :3000); `VITE_MOCK_API=true` em `web/.env.local` para rodar sem a API.
- `npm test` (a raiz agora roda os testes dos dois workspaces), `npm run typecheck`, `npm run build`.

### Testes
- **45 passando no web** (API/erros, fila e backoff, mock, funções puras) e **174 no server**, todos passando após o merge; typecheck limpo.
- **Pendência de CSP e Docker depois do merge: cumprida.** O `globalSetup` do server faz um `vite build` real, então a suíte `spa.test.ts` rodou contra o build com as 6 fontes `.woff2` e os SVGs: passou (sem script/estilo inline, CSS só com `url()` da própria origem ou `data:image`, sem `eval`). Imagem Docker construída com o código mergeado, rodando read-only/não-root: `/e/<slug>` abriu num navegador real com fontes e CSS carregando de `/assets` e **sem nenhuma violação de CSP** no console; fluxo nome → fallback de câmera → compressão (4000×3000 → 1600×1200) → envio (201) → cota 10 → 9; foto salva em 1600×1200 sem EXIF, miniatura 400×300; sessão persiste no reload; "Não é você?" volta à tela de nome; sem overflow horizontal em 375 px.
- **Em produção (informado pelo usuário):** o app está no ar em `fotos.example.com`, com **envio validado a partir de um celular real no 4G**.

### Pendências para a próxima fase
- Validar a aparência e a câmera ao vivo em **iPhone (Safari)** e **Android (Chrome)** reais (o teste de câmera não roda no navegador de desenvolvimento); confirmar HEIC no `<input capture>` do iPhone.
- Melhorias apontadas na revisão (não bloqueiam): (1) `total_quota_exceeded` (429) é tratado como limite da janela — a lista de envios e o aviso mostrariam "tente em N min" com N enorme em vez de "você já enviou o máximo"; (2) `crypto.randomUUID()` sem fallback (iOS < 15.4); (3) campo de nome com `maxLength` 80 contra o limite de 40 do servidor; (4) fotos pendentes no IndexedDB ficam órfãs se a sessão cair (401) e o guest mudar.
- O front novo ainda não tem a galeria compartilhada (mudança de escopo registrada na entrada seguinte).

### Bugs relacionados
- Nenhum.

---

## [2026-09-30] Mudança de escopo — galeria compartilhada entre convidados (e nova Fase 4)

**Ferramenta/modelo:** Claude Code (Sonnet 5.5)
**Status:** concluída (só documentação; a implementação é a nova Fase 4)

### O que foi feito
- `AGENTS.md` atualizado a pedido do usuário:
  - **Contexto:** "galeria para convidados" deixa de estar em "Fora de escopo"; parágrafo novo descreve a galeria compartilhada (convidados com sessão veem as fotos de todos, em tempo quase real por polling; fotos ocultas nunca aparecem nem são servidas).
  - **API:** bloco novo **Galeria** com o contrato: `GalleryItem = { id, guestName, createdAt, thumbUrl, photoUrl, mine }`; `GET /api/gallery?cursor=&limit=30` → `{ items, nextCursor }` (mais recentes primeiro, sem ocultas); `GET /api/gallery/updates?since=<ISO>` → `{ added, removedIds, serverTime }`; `GET /api/gallery/photos/:id/thumb` e `/:id` (oculta ou inexistente → 404; `Cache-Control: private` com cache curto). Todas exigem sessão (401 sem ela). A descrição do `/admin` passou a ser a página de moderação (celular, grade, atualização periódica, ocultar/reexibir, sem script inline).
  - **Segurança:** "fotos nunca acessíveis publicamente" agora permite **convidados com sessão** (`/api/gallery/*`, sem ocultas) e **admin** (`/api/admin/*`, com ocultas); registrado que a galeria é tão privada quanto o link do QR.
  - **Ordem de implementação, item 4:** galeria (endpoints) → admin de moderação → ZIP em streaming.
  - **Critérios de aceite:** "nenhuma foto acessível sem sessão de convidado (galeria) ou autenticação admin; foto oculta não é servida a convidados".

### Decisões tomadas
- Prioridade da nova Fase 4: (1) endpoints da galeria com testes; (2) admin de moderação (Basic Auth com `timingSafeEqual`, rate limit de falhas, `no-store`, `/admin` usável no celular, sem script inline); (3) `GET /api/admin/export.zip` em streaming com `archiver`, pastas por convidado e `_ocultas/`, testado com muitas fotos sem estourar a memória.
- O front (`web/`) implementa o contrato da galeria; esta fase trabalha só em `server/` (e na raiz, se necessário).

### Desvios da especificação
- **Mudança de escopo aprovada pelos noivos/usuário:** galeria compartilhada entre convidados (antes fora de escopo). Motivo: decisão dos noivos de todos verem as fotos em tempo quase real.

### Arquivos principais
- `AGENTS.md` — escopo, API, segurança, ordem de implementação e critérios de aceite

### Como rodar / testar
- Não se aplica (só documentação).

### Testes
- Nenhum teste alterado; suítes em 174 (server) + 45 (web) passando.

### Pendências para a próxima fase
- Implementar a Fase 4 conforme a aprovação do entendimento (a apresentar).
- `README.md` (seção 8) ainda diz que as fotos "não são servidas pelo Express": atualizar quando a galeria e o admin existirem.
- **Risco de privacidade:** a sessão é criada por qualquer pessoa que tenha o link do QR (slug), então a galeria expõe nome e foto de todos a quem tiver o link; a sessão dura até 1 dia depois de `UPLOAD_CLOSES_AT`. Orientar para não divulgar o link fora da festa.
- **Produção já está no ar** (PROGRESS, Fase 5): a Fase 4 deve ser implantada fora do horário da festa; migrações aditivas, e a imagem antiga continua compatível com o banco novo.

### Bugs relacionados
- Nenhum.

---

## [2026-09-30] Fase 4 (parte 1 de 3) — Endpoints da galeria compartilhada

**Ferramenta/modelo:** Claude Code (Sonnet 5.5)
**Status:** parcial (item 1 de 3: galeria; faltam o admin de moderação e o ZIP)

### O que foi feito
- **Migração `20260930214420_gallery_visibility`** (aditiva): `Photo.visibilityChangedAt DateTime?` (atualizado a cada ocultar **e** reexibir) + índices em `createdAt` e `visibilityChangedAt`. Validada o upgrade sobre um banco no schema antigo com dados (3 fotos, 1 oculta): dados preservados, coluna nula nas antigas, `integrity_check` ok, sem drift.
- **Endpoints** (`server/src/routes/gallery.ts`, `server/src/gallery.ts`), todos com sessão de convidado (401 sem ela) e limite por IP `IP_MAX_GALLERY_PER_WINDOW`:
  - `GET /api/gallery?cursor=&limit=30` → `{ items, nextCursor, serverTime }`: mais recentes primeiro (`createdAt`, desempate por `id`), sem ocultas; `limit` 1–60 (padrão 30, fora disso 400 `validation_error`); cursor opaco (base64url de `createdAt em ms.id`), inválido → 400 `invalid_cursor`; busca `limit+1` para decidir `nextCursor` (sem página vazia extra); `mine` correto; nome do convidado por join (sem N+1).
  - `GET /api/gallery/updates?since=<ISO>` → `{ added, removedIds, serverTime, hasMore }`: `added` = visíveis com `createdAt > since` **ou** `visibilityChangedAt > since` (inclui reexibidas); `removedIds` = ocultas com `visibilityChangedAt > since`; `since` exige ISO 8601 (com `Z` ou offset), senão 400; `serverTime` = horário real capturado **antes** das consultas, sem subtrair nada (a sobreposição de 30 s e a deduplicação por `id` ficam no front).
  - Limite de **200** em `added` (mais antigos primeiro, pela data em que ficaram visíveis): com mais, `hasMore = true` e `serverTime` = instante da última foto devolvida, para o front buscar de novo na hora; fotos no mesmo instante do corte vêm juntas (nenhuma é separada); `removedIds` sempre completo.
  - `GET /api/gallery/photos/:id/thumb` e `/:id` → arquivo; oculta, inexistente, `id` que não é UUID, arquivo ausente ou caminho do banco que escapa de `DATA_DIR` → **404** (mesma resposta para todos). Consulta o banco sempre, inclusive em requisições condicionais (304): ocultar vale na hora. `Cache-Control: private, max-age=60`, `Vary: Cookie`, ETag; 404 sem cache.
- `AGENTS.md` atualizado com o contrato final (serverTime na listagem, `hasMore`, teto de 200, `visibilityChangedAt` e índices no modelo, novo limite na tabela e na lista de envs).
- `.env.example` e `README.md`: `IP_MAX_GALLERY_PER_WINDOW` (padrão 100000).

### Decisões tomadas
- `visibilityChangedAt` no lugar do `unhiddenAt` proposto (aprovado): uma só coluna cobre ocultar e reexibir.
- `added` é montado por duas consultas disjuntas já ordenadas pela chave exata (criadas e nunca mexidas por `createdAt`; mexidas por `visibilityChangedAt`) e mescladas em memória — o Prisma não ordena por `COALESCE` e evitamos SQL cru (formato de data do SQLite).
- Teto de busca de 301 linhas por consulta (200 + folga de 100 para empates + 1); se bater no teto, `hasMore` fica verdadeiro mesmo quando tudo o que foi buscado coube.
- A rota de arquivo devolve o mesmo 404 para oculta/inexistente/sem arquivo para não revelar a existência de fotos ocultas.
- Até a parte 2, nada no servidor grava `visibilityChangedAt`/`hiddenAt` (o admin fará isso); os testes gravam os dois direto no banco.

### Desvios da especificação
- **Aprovados nesta fase:** coluna `visibilityChangedAt` e dois índices em `Photo` (modelo de dados); `serverTime` também na listagem e `hasMore`/teto de 200 em `updates`; limite `IP_MAX_GALLERY_PER_WINDOW` (padrão 100000). Tudo já refletido no `AGENTS.md`.

### Arquivos principais
- `server/prisma/schema.prisma`, `server/prisma/migrations/20260930214420_gallery_visibility/migration.sql`
- `server/src/gallery.ts`, `server/src/routes/gallery.ts`, `server/src/rateLimit.ts` (`galleryLimiter`), `server/src/env.ts`, `server/src/app.ts`
- `server/test/gallery.test.ts`

### Como rodar / testar
- `npm test` (raiz: server + web), `npm run typecheck`.
- Migração em produção: `git pull && docker compose up -d --build` (o entrypoint roda `prisma migrate deploy`); a imagem antiga continua compatível com o banco novo.

### Testes
- **62 testes novos** (gallery); total **236 no server + 45 no web, todos passando**; typecheck limpo.
- Cobertos: 401 em todas as rotas (sem cookie, adulterado, convidado removido); formato do item e `mine` com dois convidados (fotos enviadas de verdade); ordem e ocultas; reexibida volta na posição original; paginação de 75 fotos (30/30/15 sem repetir nem pular), múltiplo exato do limite, empates de `createdAt`, ocultar entre páginas; limit padrão/máximo/inválidos; 7 tipos de cursor inválido; `since` inválido (5 formas) e formatos aceitos; `added` estritamente depois de `since`; `since` no futuro; **`since` no passado devolve tudo o que mudou**; **foto reexibida em `added`**; **foto ocultada em `removedIds`**; criada e ocultada na mesma janela; ocultada e reexibida entre consultas; ocultadas antes de `since` não repetem; **`hasMore` com 250 novas** (200 + 50, `serverTime` no ponto de parada), exatamente 200, empate no corte, cliente seguindo `hasMore` com 450 e 700 fotos (novas + reexibidas intercaladas) sem perder nem repetir, `removedIds` completo com `added` truncado; arquivos (bytes idênticos ao disco, cabeçalhos de cache, oculta → 404 inclusive 304/ETag e para o dono, reexibida volta, id inválido/inexistente/traversal, arquivo ausente, caminhos do banco fora de `DATA_DIR`); ponta a ponta envio → updates → ocultar → updates; limite por IP (429 + `Retry-After`).
- Mutações verificadas: servir foto oculta (3 falhas), ignorar reexibidas em `added` (5), separar empates no corte (1), subtrair do `serverTime` (1).

### Pendências para a próxima fase
- Fase 4, partes 2 e 3: admin de moderação (Basic Auth com `timingSafeEqual`, `ADMIN_MAX_FAILURES_PER_WINDOW` padrão 10 — em produção usar 30 e o moderador deve usar dados móveis, registrar no README; `/admin` em `server/admin-ui/` com `COPY` no Dockerfile; `PATCH` grava `hiddenAt` **e** `visibilityChangedAt`) e `GET /api/admin/export.zip`.
- Front (`web/`): implementar o contrato — deduplicar por `id`, usar sobreposição de ~30 s no `since`, repetir a chamada de `updates` na hora quando `hasMore` for `true`, e remover da tela o que vier em `removedIds`.
- `README.md` (seção 8) ainda diz que as fotos não são servidas pelo Express: atualizar na parte 2/3.
- Deploy: a produção está no ar; implantar fora do horário da festa.

### Bugs relacionados
- Nenhum.

---

## [2026-09-30] Front — ajustes e galeria compartilhada (branch feat/web-ajustes)

**Ferramenta/modelo:** Claude Code (Opus 5.5)
**Status:** concluída no front; aguardando endpoints da galeria e teste em aparelho real

### O que foi feito
- build.target até iOS 14/Safari 14 (padrão do Vite 8 era iOS 16.4).
- uuidv4 com fallback em getRandomValues (randomUUID só no iOS 15.4+).
- Câmera frontal: foto sai espelhada como o preview; decisão pela câmera realmente aberta (facingMode do track). Traseira nunca espelha.
- Nome com maxLength 40.
- Erros por código: 429 total_quota_exceeded → "Você já enviou o máximo de fotos." (nunca minutos); quota_exceeded/rate_limited com minutos; 413/415/422/507 com textos próprios; "Tentar de novo" manual só onde pode dar certo. Nunca orienta a procurar os noivos.
- Pendentes no IndexedDB de uma sessão que caiu (401) são reenviadas pela sessão nova, mesmo clientUploadId.
- Cota: "N fotos disponíveis agora"; "N fotos restantes" quando o limite total restringe.
- Cormorant Garamond 500 removido.
- Galeria como tela principal: grade com rolagem infinita, visualizador com navegação, polling de /updates a cada 15 s (pausado com a aba oculta, imediato após envio), hasMore consultado na hora, moderação em tempo real, fotos próprias na hora com selo de status e trocadas pelo item real sem duplicar, pílula de status que leva às fotos com falha. Lista de envios removida.
- VITE_MOCK_API com partes separadas por vírgula (session, photos, gallery); mock da galeria com vazia/12/95 fotos, chegada, rajada (hasMore), moderação e reexibição.

### Decisões tomadas
- since = último serverTime − 30 s em toda consulta, dedup por id; o corte nunca retrocede. Se uma resposta com hasMore não traz nada novo, a seguinte usa o serverTime exato (senão a paginação trava com mais mudanças que o limite dentro de 30 s).
- Primeiro since: serverTime de GET /api/gallery; sem ele, createdAt mais recente ou abertura do evento.
- Câmera fecha ao voltar para a galeria; se o iPhone pedir permissão a cada vez, manter aberta.

### Desvios da especificação
- Lista de envios substituída por selos nas miniaturas (aprovado).

### Testes
- web: 122 passando (lógica pura em node). server: 174 passando.
- Manual (navegador embutido, mock): fluxo completo, espelhamento por pixel, paginação 95, rajada 45, moderação com foto aberta, falha → pílula → folha de ações.

### Pendências
- Integrar com os endpoints reais da galeria.
- Testar em iPhone (Safari, incluindo iOS < 15.4 se possível) e Android (Chrome): câmera, permissão ao reabrir a câmera, espelhamento.
- ~~Backend: serverTime em GET /api/gallery, hasMore, reexibida como added (filtro pela mudança de visibilidade) e desempate no corte do hasMore.~~ **Entregue no item 1 da Fase 4** (commits `5b2e56f`, `b02d661` e `555d470`): `serverTime` em `GET /api/gallery`, `hasMore` e teto de 200 em `/updates`, reexibida em `added` (via `visibilityChangedAt`) e fotos empatadas no corte vindo juntas. Falta só o front integrar com os endpoints reais.

### Bugs relacionados
- Nenhum.

### Verificação pós-merge (PR #2, `046d836`) — registrada pelo Claude Code (Sonnet 5.5)
- Código combinado (`main` = `046d836`): typecheck limpo; `npm test` da raiz com **236 testes no server e 122 no web, todos passando**; `npm run build` limpo.
- CSP contra o build novo: a suíte `spa.test.ts` (que faz um `vite build` real) passou; o build não tem script/estilo/handler inline, o CSS só referencia fontes da própria origem e `data:image`, não há `eval` nem `new Function`, e nada do mock vai para o bundle de produção.
