---
name: prompt-builder
description: Benchmark de LLMs e evolução de system prompts pelo terminal, com controle de orçamento. Use ao comparar modelos, testar variações de um prompt, escolher o nível de raciocínio (think level) de um modelo, estimar o custo de uma chamada de LLM antes de gastar, ou treinar automaticamente um system prompt contra cenários gerados. Use também para listar ou exportar o catálogo de modelos do OpenRouter com os níveis de raciocínio que cada um aceita.
license: MIT
metadata:
  homepage: https://www.npmjs.com/package/prompt-builder-cli
---

# prompt-builder

Mede **qual modelo ou prompt responde melhor**, com evidência: cenários →
respostas → juiz contra gabarito → duelos. Sem instalar: `npx prompt-builder-cli <cmd>`.

| Pergunta | Comando |
|---|---|
| qual modelo é melhor? | `compare` |
| esse prompt melhora? | `vary` · `train` |
| que think level aceita? | `models show <id> --json` |
| quanto custa? | `estimate` · `--dry-run` |
| qual agente resolve melhor? | `agents run` |

## Caminho feliz

```bash
echo "$OPENROUTER_API_KEY" | npx prompt-builder-cli key set --stdin
npx prompt-builder-cli config example --mode train -o arena.json
npx prompt-builder-cli train --config arena.json --budget 3 --dry-run
npx prompt-builder-cli train --config arena.json --budget 3 --output-format ndjson
npx prompt-builder-cli sessions winner <sessionId> --apply prompt.md
```

## Regras

1. Sempre `--budget`: sem TTY o comando recusa (exit `2`, nada gasto).
2. Nunca chute think level: `models show <id> --json` → `thinkLevels.accepted`/`fit`.
3. `--dry-run` antes de run cara, com as mesmas flags: mesmo exit da real, sem key.
4. O juiz nunca é competidor (o schema rejeita).
5. `--json`/`--output-format ndjson`: payload no stdout, narração no stderr.
6. Exit `7` = parcial por orçamento (resultado válido); `10` = portão recusou.
7. Retentativa = mesma `--idempotency-key` (sem ela: `run.locked`).

## Documentação embarcada (casada com a versão instalada)

`npx prompt-builder-cli docs --list`, depois `docs <tópico>`: `quickstart`
(comece aqui; códigos de saída), `models`, `budget`, `train`/`compare`/`vary`
(inclui `library`), `results` (inclui `runs reproduce`), `ndjson`,
`troubleshooting`, `agents`/`agent-task` (modo agente).
