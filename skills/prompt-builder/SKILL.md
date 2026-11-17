---
name: prompt-builder
description: Benchmark de LLMs e evolução de system prompts pelo terminal (CLI/MCP, sem UI), com orçamento controlado. Mostra onde o prompt-builder está de verdade no disco (segue o symlink da skill até a pasta real) e o comando exato para rodá-lo de qualquer diretório. Use ao comparar modelos, testar variações ou treinar um system prompt contra cenários gerados, escolher o think level de um modelo, estimar custo antes de gastar, operar via MCP (start_run/get_result), correr o modo agente, avaliar ou evoluir decisões tipadas do Jev (noul/choice/score), reproduzir ou exportar runs, promover o prompt vencedor, gerar o relatório de ciclos de um treino (plannotator-visual-explainer) ou listar o catálogo de modelos do OpenRouter. Segue as opções recomendadas (modelos por papel, --dry-run, --budget) e sempre pergunta ao usuário se quer sugerir outro modelo para rodar. É para USAR o prompt-builder (medir modelos, evoluir prompts), não para desenvolver o código dele.
license: MIT
metadata:
  homepage: https://www.npmjs.com/package/prompt-builder-cli
---
Benchmark sem UI: cenários → respostas → juiz JEV contra gabarito → duelos.
`compare`=modelos · `vary`/`train`=prompts · `jev`=decisões · `agents run`=agentes.

## 1. Onde está (sempre primeiro)

`bash "${CLAUDE_SKILL_DIR}/where.sh"` (fora do Claude Code: `bash <pasta desta skill>/where.sh`)
segue o symlink até a pasta REAL: raiz, comando do CLI, build, key, dados e o que corrigir.
Use o comando que ele der no lugar de `prompt-builder`, de qualquer diretório.

## 2. Opções recomendadas

Parta do `config example` (modelos por papel de `models.md`, juiz JEV, esforços, finais) e
mude só tema, prompt e cenários. Think level: `models show <id> --json`. Nunca troque um
modelo recomendado por conta própria.

## 3. Outro modelo: pergunte SEMPRE, antes de gastar

Mostre os recomendados e pergunte se o usuário quer sugerir outro modelo para rodar (tool
de pergunta se houver; senão pergunte e PARE até a resposta). Valide com `models show`,
papéis distintos e novo `--dry-run` (`terminal.md` §3).

## 4. Rodar

```bash
prompt-builder config example --mode train -o arena.json
prompt-builder train --config arena.json --budget 10 --dry-run
prompt-builder train --config arena.json --budget 10 --output-format ndjson
prompt-builder sessions report <sessionId> --html relatorio.html
```

Vencedor: `runs winner <id>` · handoff com gate: `sessions winner <id> --apply prompt.md` ·
relatório para quem decide: brief da **plannotator-visual-explainer** (docs `report`).
Guia completo (modos, Jev, agente, MCP, códigos de saída): `terminal.md`.
Docs embarcadas: `prompt-builder docs --list`.

## Regras

1. `--budget` sempre (sem TTY/teto = exit `2`); `--dry-run` antes, mesmas flags.
2. `--json`/ndjson: payload no stdout, log no stderr.
3. Retentativa = mesma `--idempotency-key` (senão `run.locked`).
4. Exit `6` inconclusiva · `7` parcial · `10` portão (holdout regredido no `--apply`).
