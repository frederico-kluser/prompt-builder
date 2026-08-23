# REPORT — Modo agente em container Docker (Fase 5)

Data: 2026-08-23 · Sessão do deep-orchestrator `20260823-154331-2263676` · 5 ondas + COMMIT-FINAL

## Pedido

> "quero que o modo agente, cada instancia rode em um container docker recebendo a key para executar o agente"

→ `isolation.kind = 'container'`: **cada execução do agente `pi` (cada rep de cada contestant) roda num
container Docker efêmero**, recebendo a key do OpenRouter por `--env-file` do host.

## O que foi entregue (mergeado em `development`)

| Commit | Onda | Conteúdo |
|---|---|---|
| `81be921` | 2 | Núcleo container: `src/agent/container.ts` (novo) + branch container em `src/agent/pi.ts` + `spawn.onKill` + `PrepareOpts.isolation` + `runAgentStage` repassa isolation |
| `5f3a236` | 3 | `agents doctor --container` (preflight docker CLI + imagem; canário em container) |
| `869ff05` | 4 | Docs: `agent-docs/agent-task.md`, `agent-docs/agents.md`, `ARENA-CONFIG.md`, `agent-docs/troubleshooting.md` |
| (COMMIT-FINAL) | 5 | `EXPLAINER.html` atualizado + `reconcile-evidence.md` (adendo) + este relatório |

Snapshots de gate (tags): `int-onda2-container-run`, `int-onda3-container-doctor`, `int-onda4-container-docs`.
Gates em toda onda: `npm run build` + `npx tsc --noEmit` → 0 erros; squash verificado contra o snapshot (árvore idêntica).

## Como funciona (arquitetura)

- **Imagem** `prompt-builder-pi:<versão>` (Dockerfile embutido em `src/agent/container.ts`: `node:22-bookworm-slim`
  + git + ca-certificates + bash + `npm i -g @earendil-works/pi-coding-agent@<ver>`). Buildada/cacheada na
  **primeira preparação de run** em container; `isolation.image` sobrescreve a tag.
- **Execução** por rep: `docker run -i --rm --name pb-agent-<execId> --env-file <tmp-0600> -v <workspace>:/ws
  -v <execDir>:/exec -w /ws -m 2g --pids-limit 512 --user <uid>:<gid> <imagem> pi <argv da receita>`.
  A tarefa entra por **stdin** (o pi lê o conteúdo inicial de stdin em `--mode json`); `-i` é obrigatório
  (sem ele o stdin vira EOF e o pi sai exit 0 sem fazer nada — correção crítica provada no spike).
- **Key**: NUNCA em argv/arquivo/volume. `--env-file` tmp `0600` no host (`os.tmpdir()`), fora dos volumes,
  apagado em finally; `argv.json` (auditoria) mascara o caminho como `<env-file-tmp-0600>`.
- **Kill/timeout**: matar o CLI docker não mata o container → `docker kill <name>` + `docker rm -f <name>`
  (via `spawn.onKill` + finally); `--rm` cobre o exit normal. Zero órfãos (verificado).
- **Owneria**: `--user <uid>:<gid>` do host (artefatos saem legíveis/apagáveis sem sudo; verificado).
- **Escopo**: só a EXECUÇÃO do agente. `setup[]`/`verify[]` (oráculo) continuam no HOST — TODO de fase
  futura para `dockerExec` também neles (env consistente).
- **Doctor**: `agents doctor [--deep] [--container]` — pré-voo exige docker CLI + imagem quando `--container`
  (exit 3); canário de sala limpa pode rodar em container.

## Validação real (evidência, 2026-08-23)

### Run de agente em container (run `337246b0`, compare, 2 agentes paralelos, custo total **US$ 0,0201**)

- Watcher docker capturou **2 containers `pb-agent-*` simultâneos** (`Up ~4s`) criados e removidos — execução
  paralela em container confirmada; `docker ps -a` pós-run → **zero órfãos**.
- `gemini-2.5-flash`: `completed`, 2 turnos (1 tool call), custo US$0,0006971, **oráculo score 1** (resolve),
  responseIds persistidos; workspace commit `e045a577` — o agente editou o workspace de verdade no container.
- `gemini-2.5-flash-lite`: `completed`, 1 turno, custo US$0,0004501, **oráculo score 0** (nao) — o oráculo discrimina.
- Placar: 100 × 0 (`judgeScoreByContestant`); 0 failed / 0 incomplete; `budgetExhausted: false`.
- **Segurança**: `grep -rl sk-or-` na run inteira → **NONE**; `pi-home/auth.json` = `{}` (o pi não persiste a key);
  `argv.json` com `<env-file-tmp-0600>` mascarado (nenhum caminho real de env-file); owneria 100% `ondokai:ondokai`;
  `session/*.jsonl`, `events.raw.jsonl` (custo >0 ao vivo), `dossier.md`, `digests.json` todos presentes no host.
- `agents doctor --container` → **exit 0** com `· docker ok (prompt-builder-pi:0.84.2)`; imagem ausente → erro
  claro exit 3 (validado com `prompt-builder-pi:9.9.9`).

### Regressão chat (run `c6f2f70e`, compare, US$ 0,0077)

2 competidores de chat, 1 cenário pinado com gabarito, juiz `gemini-2.5-pro`: **exit 0**, `finished`,
ambos 100/100, `budgetExhausted: false` — o pipeline de chat (datagen/competidor/juiz/placar) segue intacto.

### Custo total da sessão de validação

Run agente US$0,0201 + regressão chat US$0,0077 + smokes das ondas (spike ~US$0,002, Onda 2 ~US$0,005,
Onda 3 canários <US$0,01) ≈ **US$ 0,05 no total**.

## Achados registrados (fora de escopo, pré-existentes)

1. **`agents doctor --deep` (host E container) reporta `canary.ok:false`**: o canário envenena
   `$HOME/SYSTEM.md` (token `CANARY-GLOBAL-SYS`) e o `pi` carrega esse arquivo como config base que as flags
   `--no-*` não suprimem — o próprio canário se auto-acusa, de forma DETERMINÍSTICA e IDÊNTICA nos dois modos
   (verificado: host baseline também falha). Não é regressão do container; é um ajuste de expectativa do
   canário que pertence a uma tarefa futura (fora do pedido).
2. **Reconciliação de custo OpenRouter indisponível**: `GET /api/v1/generation?id=<responseId>` → 404
   (ver `reconcile-evidence.md`, commitado). O custo de agente permanece `agent-derived`; `responseIds` agora
   são persistidos em `trajectory.json`.
3. Aviso de disco (< 5 GB em `/tmp`) é warning do doctor, não falha.

## Pendências conscientes

- `dockerExec` para `setup[]`/`verify[]` (oráculo) — TODO documentado nas docs (consistência de ambiente).
- Canário `--deep` — ajustar expectativa de `$HOME/SYSTEM.md` do pi (tarefa futura).
- `killContainer` no finally roda sempre (2 spawns docker por exec, ~ms; idempotente — aceitável).
- Imagem `prompt-builder-pi:0.84.2` permanece no daemon (cache por tag, reutilizada nas próximas runs).