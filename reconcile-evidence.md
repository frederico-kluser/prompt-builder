# reconcile-evidence.md — Verificação empírica do `responseId` (§20.4 / Fase 4)

Data: 2026-08-23 · Executor `pi` v0.84.2 · Modelo `google/gemini-2.5-flash` (thinking minimal)
Ambiente: sala limpa em `/tmp`, env explícito (`HOME`/`PATH`/`LANG`/`TZ` escritos),
`PI_CODING_AGENT_DIR` e `PI_CODING_AGENT_SESSION_DIR` em `/tmp`, `PI_OFFLINE=1`,
argv `--mode json --provider openrouter --model google/gemini-2.5-flash
--thinking minimal --session-dir <tmp> --no-context-files --no-extensions
--no-skills --no-prompt-templates --no-themes --no-approve
--tools read,write,edit,bash,ls --system-prompt none`.
Tarefa trivial: "crie um arquivo ok.txt no diretório atual com o conteúdo 'ok'." ✓ (ok.txt criado)

⚠️ Segurança: **a key do OpenRouter NÃO aparece neste arquivo** — foi lida do
`~/.pi/agent/auth.json` (campo `openrouter.key`), injetada apenas no `env` do pi e
no header `Authorization`, e nunca impressa/comitada. Os ids de geração abaixo
(**não são segredo**).

## Método

1. Executou UMA execução do pi com a receita de sala limpa acima (custo ~US$0,001).
2. Do stream JSONL (`--mode json`), coletou os `message_end` de mensagens `assistant`,
   que carregam `message.usage.cost.total` (o custo **derivado** pelo pi a partir da
   sua própria tabela de preços — §20) e `message.responseId`.
3. Para cada `responseId` (padrão `gen-...`), chamou o endpoint **de geração** do
   OpenRouter com a MESMA key usada na chamada:
   `GET https://openrouter.ai/api/v1/generation?id=<responseId>` com
   `Authorization: Bearer <key>`.
4. Comparou o resultado com o `usage.cost.total` do pi na mesma `message_end`.

## Resultado bruto

| responseId (`pi`) | pi `usage.cost.total` | GET /generation | corpo |
|---|---|---|---|
| `gen-1787507694-6GfN07sBHArp036SLk2i` | 0.000343 | **HTTP 404** | `{"error":{"message":"Generation gen-1787507694-6GfN07sBHArp036SLk2i not found","code":404}}` |
| `gen-1787507696-mTtVw2mZRiji70tL9QcQ` | 0.0003234 | **HTTP 404** | `{"error":{"message":"Generation gen-1787507696-mTtVw2mZRiji70tL9QcQ not found","code":404}}` |

`data.cost` / `data.usage` / `data.purchased`: **ausentes** (o corpo é só o erro 404).

### Sanidade da key (exclui auth como causa do 404)
`GET /api/v1/key` com a mesma key → **HTTP 200**, dados: label `sk-or-v1-df5...d5f`,
usage 44.07 USD, is_free_tier false. Ou seja: a key é válida e tem crédito; o 404 é
do endpoint de geração, não de autenticação.

O stream da execução teve 4 `message_end` (2 de `user`, 2 de `assistant` com
`responseId`), 2 `turn_end`, `agent_settled` presente.

## VEREDITO

**NÃO** — o `responseId` emitido pelo `pi` (`gen-<timestamp>-<random>`, ex.
`gen-1787507694-6GfN07sBHArp036SLk2i`) **não é** o id aceito pelo endpoint de
geração do OpenRouter `GET /api/v1/generation?id=...` nesta versão (pi 0.84.2,
OpenRouter padrão, senha única `auth.json`). Para ambos os ids a resposta foi
**404 "Generation not found"** com a mesma key usada na geração — o que descarta
erro de autenticação e indica incompatibilidade de formato/escopo do id.

## Consequência para a implementação (Fase 4 — branch "SE NÃO")

Como a premissa de §20.4 falhou empiricamente, **a reconciliação de custo com o
OpenRouter está INDISPONÍVEL/inverificada**: não há `billed` confiável para
comparar com o `derived`. Consequências:

- O subcomando `agents reconcile <runId>` (`src/cli/commands/agents.ts`) imprime o
  **resumo DERIVADO** (soma dos `usage.costUsd` das execuções de agente +
  `totalCostUsd` da run) e um **aviso explícito** de que a reconciliação está
  indisponível, com o custo permanecendo `source 'catalog'/'agent-derived'`.
- **O endpoint `GET /api/v1/generation` NÃO é chamado em produção.**
- A função `fetchGeneration()` **NÃO foi adicionada** a `src/openrouter.ts` (era
  aditiva condicional ao veredito SIM).
- O `RunRecord.agentCostReconciled` (adicionado por outra sub-tarefa da onda;
  NULL na 6.1) permanece vazio.

## Nota sobre persistência dos responseIds

Mesmo que o 404 fosse eventualmente resolvido (ex.: trocar o id por outra forma),
os `responseIds` **não são persistidos** no store atual: o `PiRunOutcome.responseIds`
é capturado no parser de `src/agent/pi.ts` mas `runAgentStage.ts` não os grava nem
em `trajectory.json` nem em `exec.json`; o bruto vive só nos transcripts raw
`session/*.jsonl` (que não entram nos `digests.json`). Para uma reconciliação real
futura (proxy local de §20.4/§20.5), será preciso primeiro persistir os
`responseIds` no `trajectory.json`/`ExecutionRecord` na onda do store.

## Atualização (2026-08-23, tarde)

A onda "onda7-fixes" (mergeada depois deste documento) passou a **persistir os
`responseIds` no próprio `trajectory.json`** (campo aditivo `responseIds`, escrito
por `runAgentStage.ts`). Confirmado empiricamente na run de validação do modo
container (run `337246b0`, execução `llm__google-gemini-2-5-flash__def__tdef`):
`trajectory.json` traz `["gen-1787512178-...", "gen-1787512180-..."]`. O bruto
segue nos transcripts `session/*.jsonl`; o veredito acima (404 do endpoint de
geração → reconciliação indisponível) **permanece válido**.