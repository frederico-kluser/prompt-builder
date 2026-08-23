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
