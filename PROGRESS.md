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
