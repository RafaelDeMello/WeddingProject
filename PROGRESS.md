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
