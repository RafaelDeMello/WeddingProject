# BUGS — weddingrafessa

Registro de bugs do projeto. Bugs **nunca são apagados**: quando resolvidos, mudam de status e ganham a descrição da correção.

## Regras

- IDs sequenciais: `BUG-001`, `BUG-002`, ...
- Registrar todo bug que eu reportar e todo bug encontrado pelo agente que não seja corrigido na mesma tarefa em que surgiu.
- Ao resolver: preencher **Causa**, **Correção** (com hash do commit) e **Teste de regressão**. Sempre que viável, o bug resolvido deve ganhar um teste automatizado que falharia sem a correção.
- Bugs com severidade **crítica** bloqueiam o avanço de fase.

**Status:** `aberto` | `em correção` | `resolvido` | `não vai corrigir` (explicar o motivo)

**Severidade:**
- `crítica` — quebra o fluxo principal (tirar e enviar foto), perde fotos ou expõe dados
- `alta` — atrapalha muito o uso, mas existe contorno
- `média` — comportamento errado em caso específico
- `baixa` — detalhe visual ou de texto

## Resumo

| ID | Título | Severidade | Status | Fase |
|---|---|---|---|---|

## Modelo de registro

```md
---

### BUG-XXX — <título curto>

- **Status:** aberto
- **Severidade:** crítica | alta | média | baixa
- **Fase:** N
- **Encontrado em:** AAAA-MM-DD
- **Ambiente:** local | túnel | produção — <dispositivo / navegador / rede>

**Passos para reproduzir**
1. ...

**Esperado:** ...
**Obtido:** ...
**Logs / evidências:** ...

**Causa:** (preencher ao resolver)
**Correção:** (descrição + commit)
**Teste de regressão:** (arquivo do teste, ou motivo de não haver)
**Resolvido em:** AAAA-MM-DD
```

## Registros
