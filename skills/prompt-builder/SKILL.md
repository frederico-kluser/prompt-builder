---
name: prompt-builder
description: Benchmark de LLMs e evolução de system prompts pelo terminal, com controle de orçamento. Use ao comparar modelos, testar variações de um prompt, escolher o nível de raciocínio (think level) de um modelo, estimar o custo de uma chamada de LLM antes de gastar, ou treinar automaticamente um system prompt contra cenários gerados. Use também para listar ou exportar o catálogo de modelos do OpenRouter com os níveis de raciocínio que cada um aceita.
license: MIT
metadata:
  homepage: https://www.npmjs.com/package/prompt-builder-cli
---

# prompt-builder

CLI que mede **qual modelo ou qual prompt responde melhor**, com evidência: gera
cenários, faz os participantes responderem, um juiz classifica cada resposta
contra um gabarito e os melhores duelam entre si.

Não instale nada: `npx prompt-builder-cli <comando>`.

## Quando usar

| Situação | Comando |
|---|---|
| "qual modelo é melhor para X?" | `compare` |
| "esse prompt pode melhorar?" | `vary` |
| "otimize esse prompt" | `train` |
| "que think level esse modelo aceita?" | `models show <id>` |
| "quanto isso vai custar?" | `estimate` ou `--dry-run` |
| "qual agente/prompt de agente resolve melhor?" | `agents run` |

## Modo agente (Agent Arena)

Quando a resposta não é um texto e sim **agente que executa tarefas** (edita
arquivos, roda `bash`, `verify`), o competidor vira um processo e o juiz lê um
dossiê determinístico do que ele fez. O contrato é `arena-agent-config@1` e o
caminho é `agents doctor` → `agents run --config x.json --budget N`. Leia
`docs agents` para o básico e `docs agent-task` para o contrato campo a campo.

## O caminho feliz

```bash
# 1. key (uma vez) — pela entrada padrão, nunca como argumento
echo "$OPENROUTER_API_KEY" | npx prompt-builder-cli key set --stdin

# 2. ache o modelo e os níveis de raciocínio que ele aceita
npx prompt-builder-cli models list --search gpt-5 --json

# 3. gere e edite a configuração
npx prompt-builder-cli config example --mode train -o arena.json

# 4. valide e estime SEM gastar
npx prompt-builder-cli train --config arena.json --budget 3 --dry-run

# 5. rode
npx prompt-builder-cli train --config arena.json --budget 3 --output-format ndjson

# 6. pegue o prompt vencedor
npx prompt-builder-cli sessions winner <sessionId> --prompt-only > prompt.md
```

## Regras (não improvise em cima delas)

1. **Sempre passe `--budget`.** Fora de um terminal interativo o comando recusa
   sem ele (saída `2`, nada gasto). `--budget none` assume o custo explicitamente.
2. **Nunca chute um think level.** `models show <id> --json` → `thinkLevels.accepted`
   diz o que aquele modelo aceita; `thinkLevels.fit` diz o que realmente vai no
   fio. Chutar dá HTTP 400.
3. **Sempre `--dry-run` antes de uma run cara.** Valida e estima sem nenhuma
   chamada de API.
4. **O juiz não compete.** Nenhum `--judge` pode ser o modelo sob teste nem um
   competidor — o schema rejeita (viés de auto-preferência).
5. **`--json` ou `--output-format ndjson` em tudo.** Payload vai para o stdout;
   progresso e avisos vão para o stderr.
6. **Leia o código de saída.** `7` significa **resultado parcial por orçamento**,
   não erro: há resultado válido, só incompleto.

## Documentação embarcada (casada com a versão instalada)

```bash
npx prompt-builder-cli docs --list        # tópicos + custo em tokens
npx prompt-builder-cli docs quickstart
```

| Leia | Quando |
|---|---|
| `quickstart` | primeira vez |
| `models` | escolher modelo, think level ou filtrar por preço |
| `budget` | entender como e onde a run para, e o pré-voo |
| `train` / `compare` / `vary` | montar a run daquele modo |
| `results` | interpretar judge-score, standings, holdout, significância |
| `ndjson` | consumir o stream de progresso |
| `config` | o contrato completo do `arena-config@1` |
| `troubleshooting` | 400 no esforço, 402, tudo `parcial`, run travada |

## Códigos de saída

`0` ok · `2` uso inválido · `3` config inválida · `4` auth · `5` sem crédito ·
`7` parcial (orçamento esgotado) · `8` rede · `130` interrompido

## Agentes desta máquina (configuração local do autor)

> Esta seção é específica da máquina do autor (útil para QUALQUER agente rodando
> nela; irrelevante para usuários do pacote). Nenhum segredo aparece aqui — as
> chaves vivem em `~/.secrets`, no `config.yaml` do LiteLLM
> (`~/.config/azureclaude/config.yaml`) e nos arquivos `*.key` de cada conta.

Esta máquina tem **4 agentes de código** configurados para rodar o CLI
(`npx prompt-builder-cli ...` / `npm run cli -- ...` do repo) e — no caso do modo
agente — **para serem os próprios avaliados**:

| Agente | O que é | Conta/dir | Como disparar |
|---|---|---|---|
| `pi` | **pi-coding-agent** (executor nativo do modo agente) | `pi.frederico` → `~/.pi/agent` (skills globais em `~/.pi/agent/skills`) | `pi [args]` |
| `azureclaude` | Claude Code → **LiteLLM local** (127.0.0.1:4000) → Azure AI Foundry, deployment **DeepSeek-V4-Flash-0731**; expõe UM modelo: `claude-opus-4-7` | `azureclaude` → `~/.claude-azureclaude` | `azureclaude [args do claude]`; `--proxy-status` (health), `--setup-config` (gera config.yaml) |
| `deepclaude` | Claude Code → **DeepSeek direto** (`api.deepseek.com/anthropic`, DeepSeek V4 Pro); usado pelas funções `asd`/`qwe` via `_claude_deepseek` | `deepseek-claude` → `~/.claude-deepseek` (`deepseek.key` 0600) | `deepclaude [args do claude]`; `--setup-key` |
| `asd` | **Seletor de contas** (fzf) dos conjuntos de agentes — `asd-functions.zsh` (também `qwe`/`123`/`zxc`) | contas: `k2.rodrigo`, `k2.frederico` (claude), `deepseek-claude` (dsclaude), `azureclaude`, `pi.frederico` | `asd` (menu) · registro: `claude-contas ls` |

**Como usar o CLI com cada um:** o CLI roda igual DENTRO de qualquer um deles
(via ferramenta `bash`/terminal — não é preciso nada especial). Para o modo
agente (Agent Arena), o executor do motor é o `pi`; os demais entram como
**participantes/avaliados** numa run de compare de agentes
(`arena-agent-config@1` + `agents run`), cada um no seu container `--env-file` 0600.

- **Quer medir qual agente resolve melhor tarefas de arquivo?** monte
  `arena-agent-config@1` com `scenarios[].agentTask` e oráculo `verify[]`, e rode
  `agents run --config x.json --budget N` (executor `pi`; modelos dos contestants
  definidos em `models.competitors`).
- **Quer benchmarkar os 4 agentes ENTRE si?** o motor compara modelos OpenRouter
  como contestants (o `pi` executa todos). Para comparar `asd × azureclaude ×
  deepclaude × pi` como executores locais, é um passo futuro dos adaptadores
  (`AgentExecutor`) — hoje o executor é sempre `pi`.
- **Segurança:** nunca imprima/commite chaves. O CLI lê a key de
  `OPENROUTER_API_KEY`/`key set`; o modo container recebe por `--env-file` 0600
  efêmero (fora dos volumes) e o `argv.json` mascara o caminho.


## Dataset estável e evolução segura (paridade prompt-arena)

- **`prompt-builder library`** — banco persistente de cenários+gabaritos por perfil
  (`<data-dir>/library/<perfil>/`): `init`/`add`/`seed` (idempotente)/`verify`/`coverage`/
  `export`/`rm`/`drop`. Item enriquecido: `tier`, `dimensionTags`, `persona`, `rationale` e
  **gabarito obrigatório** (`reference` textual OU `expected` de rótulo — o evolve recusa sem).
- **`expected`** (ground-truth): veredito determinístico sem juiz LLM — `"edit"`, `["edit","help"]`
  ou `{"campo":"valor"}`.
- **arena-config@1**: `scenarios: {"from":"library","profile","ids"}` · `prompt.contracts`
  (never-break em 3 camadas: local + juiz do diff + `canaries[]`; ver `agent-docs/train.md`) · `prompt.group`+`promptId` (multi-prompt coordinate ascent) · `training.reflection`
  (`deterministic|llm|off`) · `training.paretoPool` (população Pareto) · `repeats` (compare, 1–3).
- **Reprodutibilidade**: `runs reproduce` · `runs export` · `sessions winner --apply [--commit]` ·
  `registry validate` (drift do prompt em código).
