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
