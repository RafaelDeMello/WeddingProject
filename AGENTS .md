# Projeto: weddingrafessa — câmera de convidados via QR Code

## Contexto

Casamento em **03/10/2026**. Os convidados escaneiam um QR Code impresso nas mesas, abrem uma página no navegador (Safari no iOS / Chrome no Android — **não** via WhatsApp/Instagram), informam o nome uma única vez, tiram uma foto pela câmera da própria página, conferem o preview e enviam. Os noivos baixam tudo depois.

Prazo real: precisa estar **funcionando e testado em produção até quinta-feira à noite**. Priorize confiabilidade sobre features. O front-end deve ser **funcional e simples**; o visual será refinado depois. O foco agora é o fluxo completo funcionando de ponta a ponta com todas as proteções abaixo.

**Fora de escopo:** galeria para convidados, vídeos, telão ao vivo, curtidas, login de convidado, upload de várias fotos da galeria do celular.

## Regras para o agente

Este arquivo é a especificação do projeto e vale para toda sessão, independentemente do modelo em uso.

- **Trabalhe uma etapa por vez** (ver "Ordem de implementação"). Ao terminar uma etapa, rode os testes, reporte o que foi feito e **pare**. Só avance quando eu aprovar.
- **Não altere esta especificação por conta própria.** Se algo aqui parecer errado ou inviável, explique e proponha a mudança antes de implementar.
- **Não adicione dependências fora da stack listada** sem perguntar. Fixe versões no `package.json`.
- **Não rode comandos na VPS** (ssh, scp, deploy). Gere os arquivos e as instruções; quem executa na VPS sou eu.
- **Não pule testes** nem os marque como `skip` para fazer a suíte passar. Se um teste falhar, corrija o código ou explique por que o teste está errado.
- **Commits pequenos**, um por etapa ou subetapa, com mensagens no formato Conventional Commits (`feat:`, `fix:`, `test:`, `chore:`).
- Antes de criar arquivos numa etapa, **liste o que pretende criar** em poucas linhas.
- Nunca commitar `.env`, banco SQLite ou fotos. Garantir que estejam no `.gitignore` desde a etapa 1.

## Arquivos de acompanhamento

- **`PROGRESS.md`** — histórico do projeto, somente acréscimo.
  - Ler inteiro no início de toda sessão.
  - Ao concluir cada fase, **antes do commit final da fase**, acrescentar uma entrada no final seguindo o modelo do próprio arquivo.
  - Nunca editar entradas anteriores. Correções viram entrada nova.
  - Todo desvio da especificação deve constar em "Desvios da especificação", com o motivo.
- **`BUGS.md`** — registro de bugs.
  - Ler no início de toda sessão e considerar os bugs abertos.
  - Registrar todo bug que eu reportar e todo bug encontrado durante o trabalho que não for corrigido na mesma tarefa.
  - Ao resolver, preencher causa, correção (com commit) e teste de regressão, e atualizar a tabela de resumo. Nunca apagar registros.
  - Bug `crítico` aberto bloqueia o avanço de fase.

## Stack

- TypeScript em todo o projeto
- **Backend:** Node 22 + Express, Zod para validação, Prisma + **SQLite**, multer (memoryStorage), sharp, file-type
- **Frontend:** React + Vite (build estático servido pelo próprio Express)
- **Testes:** Vitest + Supertest
- **Deploy:** Docker + Docker Compose numa VPS Ubuntu, atrás de um Caddy já existente

Estrutura sugerida (npm workspaces):

```
/server   → API Express + Prisma
/web      → React/Vite
/scripts  → backup.sh, loadtest
Dockerfile (multi-stage: build web + build server → runtime)
docker-compose.yml
.env.example
```

## Fluxo do convidado

1. QR aponta para `https://fotos.example.com/e/<EVENT_SLUG>`. Slug diferente de `EVENT_SLUG` → 404.
2. Front chama `GET /api/event` e mostra o estado: **ainda não abriu**, **aberto** ou **encerrado**.
3. Se não houver sessão, pede o nome → `POST /api/guests { slug, name }` → servidor cria o Guest e define cookie de sessão assinado.
4. Tela de câmera (`getUserMedia`, câmera traseira por padrão, botão para alternar para frontal).
   - **Fallback:** se a permissão for negada ou `getUserMedia` falhar/não existir, usar `<input type="file" accept="image/*" capture="environment">`.
5. Ao capturar: compressão no cliente via canvas → **JPEG, lado maior 1600px, qualidade 0.8** (alvo ~300 KB). Aplicar o mesmo no fallback.
6. Preview com **"Enviar"** e **"Tirar outra"**.
7. Envio: `POST /api/photos` (multipart, campo `photo` + campo `clientUploadId` UUID gerado no cliente por foto).
   - Estados visíveis: enviando → enviada ✓ / falhou.
   - **Retry automático** com backoff exponencial (1s, 2s, 4s, 8s, máx. 5 tentativas), sempre com o **mesmo `clientUploadId`**.
   - Fila de pendentes em memória; persistir em IndexedDB é desejável se sobrar tempo (reenviar ao reabrir a página).
8. Mostrar quantas fotos restam na janela atual. Em 429, mostrar "Você atingiu o limite, tente novamente em X min" usando `retryAfterSeconds`.

Textos da interface em pt-BR.

## API

Todas as respostas em JSON, erros no formato `{ error: { code, message } }`.

**Públicas**

- `GET /api/health` → `{ ok: true }`
- `GET /api/event` → `{ name, status: "not_open" | "open" | "closed", opensAt, closesAt, limits: { perWindow, windowMinutes, total } }`
- `POST /api/guests` — body `{ slug, name }`
  - Valida slug e janela de upload. Cria Guest, define cookie de sessão. Retorna `{ guestId, name, quota }`.
- `GET /api/me` → requer sessão. Retorna `{ guestId, name, quota: { remainingInWindow, remainingTotal, resetsAt } }`.
- `POST /api/photos` — requer sessão, multipart com `photo` e `clientUploadId`.
  - Retorna `201 { id, quota }`. Se o `clientUploadId` já existir para esse guest, retorna `200` com a foto já existente (idempotente, **não** conta de novo na cota).

**Admin** (HTTP Basic Auth, credenciais em env — funciona direto no navegador para baixar o ZIP)

- `GET /admin` → página HTML simples com contagem total, lista paginada de miniaturas (nome do convidado + horário) e botão de download.
- `GET /api/admin/photos?cursor=` → lista paginada.
- `GET /api/admin/photos/:id` e `GET /api/admin/photos/:id/thumb` → arquivos.
- `PATCH /api/admin/photos/:id { hidden: boolean }` → ocultar/reexibir (soft delete).
- `GET /api/admin/export.zip` → ZIP em **streaming** com `archiver` (nunca montar em memória), organizado em pastas por convidado: `<nome-slugificado>-<guestId curto>/<HHmmss>-<photoId>.jpg`. Incluir as ocultas em uma pasta `_ocultas/`.

## Modelo de dados (Prisma + SQLite)

```prisma
model Guest {
  id        String   @id @default(uuid())
  name      String
  ipHash    String?
  userAgent String?
  createdAt DateTime @default(now())
  photos    Photo[]
}

model Photo {
  id             String    @id @default(uuid())
  guestId        String
  guest          Guest     @relation(fields: [guestId], references: [id])
  clientUploadId String
  filePath       String
  thumbPath      String
  sizeBytes      Int
  width          Int
  height         Int
  hiddenAt       DateTime?
  createdAt      DateTime  @default(now())

  @@unique([guestId, clientUploadId])
  @@index([guestId, createdAt])
}
```

- SQLite com **WAL mode** ativado na inicialização.
- `ipHash = sha256(ip + SESSION_SECRET)` — não guardar IP em claro.
- `prisma migrate deploy` roda no start do container.

## Limites

Todos configuráveis por env.

| Regra | Padrão | Observação |
|---|---|---|
| Fotos por convidado por janela deslizante | 10 a cada 10 min | Contar via `Photo.createdAt` no banco (sobrevive a restart) |
| Fotos por convidado no total | 150 | |
| Uploads por IP | 200 a cada 10 min | **Generoso de propósito**: todos no Wi-Fi do salão (ou CGNAT do 4G) podem compartilhar o mesmo IP. É só proteção contra abuso, não a cota real |
| Criação de convidado por IP | 30 a cada 10 min | |
| Tentativas de login admin falhas por IP | 10 a cada 15 min | |
| Janela de upload | `UPLOAD_OPENS_AT` → `UPLOAD_CLOSES_AT` | ISO 8601 com `-03:00`. Fora da janela: 403 `upload_closed` |
| Tamanho máximo do arquivo | 8 MB | O cliente envia ~300 KB; a margem cobre o fallback |
| Espaço mínimo em disco | 2 GB livres | Abaixo disso, recusar upload com 507 e logar alerta (`fs.statfs`) |

**Concorrência da cota:** checar a cota rapidamente antes de processar a imagem (fail fast), processar, e então **rechecar + inserir dentro de uma transação**. Se a recheck falhar, apagar os arquivos já gravados e retornar 429.

Respostas 429 devem incluir `retryAfterSeconds` e o header `Retry-After`.

## Processamento de imagem (servidor)

1. multer `memoryStorage`, `limits: { files: 1, fileSize: MAX_UPLOAD_BYTES, fields: 5 }`.
2. Validar **magic bytes** com `file-type` — aceitar apenas `image/jpeg`, `image/png`, `image/webp`. Ignorar `Content-Type` e nome enviados pelo cliente.
3. sharp com `limitInputPixels` (ex.: 50 MP): `.rotate()` (aplica orientação EXIF) → redimensionar para no máximo 2000px → JPEG qualidade 85 → **sem metadados** (remove EXIF/GPS dos convidados).
4. Gerar thumbnail 400px.
5. Gravar em arquivo temporário e fazer `rename` atômico para o destino final.

Layout em disco (`DATA_DIR=/data`, volume Docker):

```
/data/db/app.db
/data/photos/YYYY-MM-DD/<photoId>.jpg
/data/thumbs/<photoId>.jpg
/data/tmp/
```

Nomes de arquivo sempre gerados pelo servidor (UUID). Nunca usar input do usuário em caminhos.

## Segurança

- **HTTPS** terminado no Caddy (obrigatório para `getUserMedia`).
- `app.set('trust proxy', 1)` para rate limit usar o IP real vindo do Caddy.
- **Sessão do convidado:** cookie `httpOnly`, `Secure`, `SameSite=Lax`, assinado com HMAC (`SESSION_SECRET`), contendo apenas `guestId`. Validar que o guest existe a cada request.
- **CSRF:** além do `SameSite=Lax`, rejeitar `POST`/`PATCH` cujo header `Origin` não seja `PUBLIC_BASE_URL`.
- **Sem CORS** (tudo same-origin).
- **helmet** com CSP restritiva. Permitir `blob:` e `data:` em `img-src` para o preview. Incluir `Permissions-Policy: camera=(self)`.
- **Validação com Zod** em todo input. Nome: trim, NFC, remover caracteres de controle, 1–40 caracteres.
- **Admin:** Basic Auth com comparação `crypto.timingSafeEqual`, rate limit em falhas, `Cache-Control: no-store`.
- Fotos **nunca** acessíveis publicamente; só via rotas admin autenticadas. Sem `express.static` sobre `/data`.
- `express.json({ limit: '10kb' })`.
- Logs estruturados (pino) sem conteúdo de imagem e sem IP em claro.
- **Container:** usuário não-root, filesystem read-only exceto `/data` e `/tmp`, `mem_limit: 512m`, `cpus: 1`, `restart: unless-stopped`, healthcheck em `/api/health`.
- Segredos só via `.env` (nunca commitado). Fornecer `.env.example`.

## Variáveis de ambiente

```
NODE_ENV=production
PORT=3000
TZ=America/Sao_Paulo
PUBLIC_BASE_URL=https://fotos.example.com
EVENT_SLUG=<string aleatória curta, ex. a8k2x>
EVENT_NAME=Casamento Rafael & <noiva>
UPLOAD_OPENS_AT=2026-10-03T00:00:00-03:00
UPLOAD_CLOSES_AT=2026-10-06T23:59:59-03:00
GUEST_WINDOW_MINUTES=10
GUEST_MAX_PER_WINDOW=10
GUEST_MAX_TOTAL=150
IP_MAX_UPLOADS_PER_WINDOW=200
MAX_UPLOAD_BYTES=8388608
MIN_FREE_DISK_MB=2048
SESSION_SECRET=<openssl rand -hex 32>
ADMIN_USER=<...>
ADMIN_PASSWORD=<openssl rand -base64 24>
DATA_DIR=/data
DATABASE_URL=file:/data/db/app.db
```

Validar todas as envs com Zod no boot; falhar rápido se algo estiver inválido.

## Docker

- Base `node:22-bookworm-slim` (sharp e Prisma funcionam sem dor; evitar Alpine). Instalar `openssl`.
- Multi-stage: build do web → build do server → runtime só com `dist`, `node_modules` de produção e Prisma client gerado.
- Configurar `binaryTargets` do Prisma para `debian-openssl-3.0.x`.
- Entrypoint: `prisma migrate deploy && node dist/index.js`.
- Compose com volume nomeado `weddingrafessa_data:/data`.

## Deploy na VPS

**Contexto do servidor:**

- Ubuntu, Docker Compose. Sem Dokploy.
- Existe um **Caddy** em container (`caddy`) ocupando as portas 80/443, com compose em `/opt/caddy`. Ele é o proxy global da VPS.
- DNS já criado: `fotos.example.com` → IP da VPS.
- O app deve ficar em `/opt/apps/weddingrafessa` (clone do repositório + `.env`).

**Antes de configurar a rede**, inspecionar como o Caddy alcança os upstreams atuais: ler o `Caddyfile` e rodar `docker inspect caddy` para ver redes e mounts. Seguir o **mesmo padrão**:

- Se usar rede Docker compartilhada, colocar o app nessa rede como `external` e usar `reverse_proxy weddingrafessa:3000`.
- Se os upstreams forem portas publicadas no host, publicar em `127.0.0.1:3100:3000` e replicar a forma de acesso existente.

Bloco a adicionar ao Caddyfile:

```
fotos.example.com {
    request_body {
        max_size 10MB
    }
    encode gzip
    reverse_proxy <upstream conforme padrão existente>
}
```

**Obrigatório** antes de recarregar:

```
docker exec caddy caddy validate --config /etc/caddy/Caddyfile
```

Só então:

```
docker exec caddy caddy reload --config /etc/caddy/Caddyfile
```

Ajustar o caminho do Caddyfile conforme o mount real. **Nunca** reiniciar/recriar o container do Caddy e **nunca** alterar a configuração da VPS sem confirmação explícita minha.

## Backup

`scripts/backup.sh`, para rodar via cron no host a cada 10 minutos durante o evento:

- Backup online do SQLite: `sqlite3 app.db ".backup ..."`. Nunca copiar o `.db` em uso diretamente.
- `rclone copy` de `/data/photos`, `/data/thumbs` e do backup do banco para um remoto configurável (Cloudflare R2 ou Google Drive).
- Escrever no README como configurar o remoto do rclone e a linha do crontab.

## Desenvolvimento local

- `npm run dev` sobe API e Vite com proxy de `/api` para o Express.
- Teste no celular via `cloudflared tunnel --url http://localhost:5173`. Adicionar `.trycloudflare.com` em `server.allowedHosts` no `vite.config`.
- Em dev, `Secure` do cookie condicionado a `NODE_ENV`.

## Testes

Automatizados (Vitest + Supertest) cobrindo no mínimo:

- Criação de guest: nome válido e inválido, slug errado, fora da janela.
- Upload válido; arquivo não-imagem com extensão `.jpg` (deve falhar por magic bytes); arquivo acima do limite.
- Cota por janela e cota total, incluindo **uploads concorrentes** do mesmo guest não ultrapassarem o limite.
- Idempotência por `clientUploadId`.
- EXIF/GPS removido da imagem salva.
- Admin sem credencial → 401; com credencial → 200; ZIP gerado com a estrutura de pastas correta.

Script de carga (`scripts/loadtest`, k6 ou autocannon): 50 convidados enviando fotos de ~300 KB simultaneamente, reportando latência p95 e taxa de erro.

## Ordem de implementação

1. Scaffold do monorepo, validação de env, Prisma + migração, `/api/health`.
2. Guests + sessão + `/api/event` + `/api/me`.
3. Upload completo: validação, sharp, cotas, idempotência, disco. Com testes.
4. Admin: listagem, thumbs, ocultar, ZIP.
5. Front funcional: nome → câmera + fallback → compressão → preview → envio com retry.
6. Dockerfile, compose, `.env.example`, README de deploy.
7. Backup e loadtest.

Ao final de cada etapa, rodar os testes, me reportar o que foi feito e o que falta, e **aguardar aprovação** antes da próxima. Em qualquer ambiguidade que afete segurança ou deploy, **pergunte antes de decidir**.

## Critérios de aceite

- Fluxo completo funcionando em **iPhone (Safari)** e **Android (Chrome)**, via 4G, pelo domínio de produção.
- Foto enviada aparece no `/admin` em até 2 segundos.
- Limites respeitados sob concorrência.
- ZIP baixa todas as fotos organizadas por convidado.
- Nenhuma foto acessível sem autenticação admin.
- Backup chegando no remoto.
