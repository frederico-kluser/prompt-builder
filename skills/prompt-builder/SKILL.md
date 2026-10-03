---
name: prompt-builder
description: Benchmark de LLMs e evolução de system prompts pelo terminal ou MCP, sem interface web, com controle de orçamento. Use ao comparar modelos, testar variações de um prompt, treinar automaticamente um system prompt contra cenários gerados, escolher o nível de raciocínio (think level) de um modelo, estimar o custo de uma chamada de LLM antes de gastar, operar o benchmark via servidor MCP (tools start_run/get_result), correr/executar o modo agente (agents run, agent-task), reproduzir ou exportar runs (runs reproduce, runs export, sessions winner), avaliar/comparar/evoluir decisões tipadas do Jev (TypeSafe: noul/choice/score, calibração, custo por decisão — jev run/train), gerar o relatório de ciclos de um treino (quanto o prompt melhorou e quanto a mudança muda o custo — sessions report, entregue pela skill plannotator-visual-explainer), ou listar o catálogo de modelos do OpenRouter com os níveis de raciocínio que cada um aceita.
license: MIT
metadata:
  homepage: https://www.npmjs.com/package/prompt-builder-cli
---
Benchmark sem UI (CLI/MCP): cenários → respostas → juiz JEV (default) contra gabarito → duelos.
`compare`=modelos · `vary`/`train`=prompts · `sessions report`=relatório de ciclos ·
`models show --json`=think level · `estimate`/`--dry-run`=custo · `agents run`=agentes ·
`jev`=decisões tipadas (docs `jev`).
CLI: `prompt-builder` (`npm run agent-setup`; fora do repo: `npx prompt-builder-cli`).

## Caminho feliz

```bash
prompt-builder config example --mode train -o arena.json
prompt-builder train --config arena.json --budget 10 --dry-run
prompt-builder train --config arena.json --budget 10 --output-format ndjson
prompt-builder sessions report <sessionId> --html relatorio.html
```

## Relatório de ciclos

`sessions report <id>` = quanto melhorou (original × campeão, por ciclo/holdout) e Δ custo por
chamada. Completo: Markdown = brief da **plannotator-visual-explainer**
(`plannotator annotate <arq>`; docs `report`).

## Modelos

Defaults por papel e listas: `models.md`. Juiz ≠ sob teste. Motor do juiz
= JEV (default; `--judge-engine llm` = painel).

## MCP e modo agente

- **MCP** (`prompt-builder mcp`): `start_run`+`idempotencyKey`→`jobId`, `run_status`,
  `cancel_run`, `get_result`, `get_session_report`, `estimate_cost`, `list_models`, `read_docs`.
- **Agente**: `agents doctor` · `agents run --config <arq> --budget <usd> [--allow-exec-config] [--dry-run]`
  (config executa comandos: aprove 1×; sem pin = exit `3`, mesmo no dry-run).

## Regras

1. `--budget`/`limits set --daily` sempre (sem TTY/teto = exit `2`).
2. Think level: `models show <id> --json` → `thinkLevels`.
3. `--dry-run` antes de run cara (mesmo exit, sem key).
4. `--json`/`ndjson`: payload stdout, log stderr.
5. Retentativa = mesma `--idempotency-key` (senão `run.locked`).
6. `sessions winner --apply` = handoff; holdout regredido → exit `10` salvo `--override`.
   Exit: `6` inconclusiva · `7` parcial · `8` rede · `130` SIGINT (`--help`).

Docs embarcadas: `prompt-builder docs --list` e `docs <tópico>`.
