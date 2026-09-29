---
name: prompt-builder
description: Benchmark de LLMs e evolução de system prompts pelo terminal ou MCP, sem interface web, com controle de orçamento. Use ao comparar modelos, testar variações de um prompt, treinar automaticamente um system prompt contra cenários gerados, escolher o nível de raciocínio (think level) de um modelo, estimar o custo de uma chamada de LLM antes de gastar, operar o benchmark via servidor MCP (tools start_run/get_result), correr/executar o modo agente (agents run, agent-task), reproduzir ou exportar runs (runs reproduce, runs export, sessions winner), avaliar/comparar/evoluir decisões tipadas do Jev (TypeSafe: noul/choice/score, calibração, custo por decisão — jev run/train), ou listar o catálogo de modelos do OpenRouter com os níveis de raciocínio que cada um aceita.
license: MIT
metadata:
  homepage: https://www.npmjs.com/package/prompt-builder-cli
---
Benchmark sem UI (CLI/MCP): cenários → respostas → juiz contra gabarito → duelos.
`compare`=modelos · `vary`/`train`=prompts · `models show --json`=think level ·
`estimate`/`--dry-run`=custo · `agents run`=agentes · `runs reproduce`/`sessions winner`=depois.
`jev`=decisões tipadas do Jev (docs `jev`).
CLI: `npx prompt-builder-cli` (bins `prompt-builder`/`pbuilder`).

## Caminho feliz

```bash
npx prompt-builder-cli config example --mode train -o arena.json
npx prompt-builder-cli train --config arena.json --budget 3 --dry-run
npx prompt-builder-cli train --config arena.json --budget 3 --output-format ndjson
```

## Modelos sugeridos (do dono)

- juízes: **google/gemini-3.8-flash** + **meta/muse-spark-1.3**
- gerador: **xiaomi/mimo-v2.6-pro** (compare: **meta/muse-spark-1.3** — gerador não compete)
- competidores: **deepseek/deepseek-v4.1-flash** + **z-ai/glm-5.3-flash** + **xiaomi/mimo-v2.6-pro**
- sob teste: **xiaomi/mimo-v2.6-pro** · gabarito: **z-ai/glm-5.3-flash** (≠ juiz ≠ sob teste)

Listas: `skills/prompt-builder/models.md`.

## MCP e modo agente

- **MCP** (`prompt-builder mcp`): jobs (`start_run`+`idempotencyKey`→`jobId`, `run_status`,
  `cancel_run`) + `run_benchmark`/`train_prompt`/`get_result`/`estimate_cost`/`list_models`/
  `read_docs`/`run_agent_benchmark`/`get_agent_dossier`.
- **Agente**: `agents doctor` · `agents run --config <arq> --budget <usd> [--dry-run]` ·
  `agents logs`/`replay` (docs `agents`/`agent-task`).

## Regras

1. `--budget`/`limits set --daily` sempre (sem TTY/teto = exit `2`).
2. Think level: `models show <id> --json` → `thinkLevels`.
3. `--dry-run` antes de run cara (mesmo exit, sem key).
4. `--json`/`ndjson`: payload stdout, log stderr.
5. Retentativa = mesma `--idempotency-key` (senão `run.locked`).
6. `sessions winner --apply` = handoff; holdout regredido → exit `10` salvo `--override`.
   Exit: `6` inconclusiva · `7` parcial · `8` rede · `130` SIGINT (`--help`).

Docs embarcadas: `docs --list` e `docs <tópico>` (à versão instalada).
