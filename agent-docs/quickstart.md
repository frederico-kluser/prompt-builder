# prompt-builder — começo rápido (para agentes)

Você é um agente de programação. Este CLI mede **qual modelo ou qual prompt
responde melhor** a um tema, com evidência: ele gera cenários, faz os
participantes responderem, um modelo juiz classifica cada resposta contra um
gabarito, e os melhores duelam entre si.

Tudo roda em processo, sem servidor. A saída estruturada vai para o **stdout**;
progresso e avisos vão para o **stderr**.

## O caminho de 6 passos

```bash
# 1. Key (uma vez). Nunca passe a key como argumento — ela ficaria no histórico.
echo "$OPENROUTER_API_KEY" | npx prompt-builder-cli key set --stdin

# 2. Descubra o modelo do seu ambiente e quais níveis de raciocínio ele aceita.
npx prompt-builder-cli models list --search claude --json | jq '.data[0]'

# 3. Escreva a configuração (ou gere um exemplo e edite).
npx prompt-builder-cli config example --mode train -o arena.json

# 4. VALIDE E ESTIME sem gastar nada. Sempre faça isto antes.
npx prompt-builder-cli train --config arena.json --budget 3 --dry-run

# 5. Rode. Com --output-format ndjson você acompanha evento a evento.
npx prompt-builder-cli train --config arena.json --budget 3 --output-format ndjson

# 6. Pegue o prompt vencedor, cru, para gravar num arquivo.
npx prompt-builder-cli sessions winner <sessionId> --prompt-only > prompt.md
```

## Regras que evitam os erros mais comuns

1. **Sempre passe `--budget`.** Fora de um terminal interativo o comando
   **recusa** rodar sem ele (código de saída `2`, nada gasto). Use
   `--budget 5` para um teto em dólares ou `--budget none` para assumir o custo
   explicitamente.
2. **Nunca chute um think level.** Peça `models show <id> --json` e leia
   `thinkLevels.accepted`. O campo `thinkLevels.fit` diz o que realmente vai no
   fio para cada nível pedido — pedir `max` a um modelo que só aceita
   `[xhigh, high]` vira `xhigh`, mas um nível fora da lista pode virar HTTP 400.
3. **Sempre `--dry-run` antes de uma run cara.** Ele valida a configuração e
   estima o custo sem fazer nenhuma chamada de API: transforma um erro de 20
   minutos num de 200 ms.
4. **O juiz não pode competir.** Nenhum modelo em `judges` pode ser o modelo sob
   teste nem um competidor — o schema rejeita (viés de auto-preferência).
5. **Leia o código de saída.** `0` ok · `2` uso inválido · `3` config inválida ·
   `4` auth · `5` sem crédito · `6` **inconclusiva** · `7` **parcial, orçamento
   esgotado** · `8` rede · `130` interrompido. O `7` não é erro: há resultado
   válido, só incompleto. O `6` também traz resultado, mas ele **não sustenta
   conclusão** (vereditos perdidos > 10% num papel ou < 5 cenários julgados por
   contestant) — não promova um prompt com base nele.

## Os três modos

| Comando | Pergunta que responde |
|---|---|
| `compare` | Qual **modelo** responde melhor a este tema? |
| `vary`    | Qual **variação do meu prompt** funciona melhor neste modelo? |
| `train`   | Evolua meu prompt ao longo de N iterações, com holdout e significância. |

Detalhes: `prompt-builder docs overview`, `docs train`, `docs models`,
`docs budget`, `docs ndjson`, `docs results`, `docs troubleshooting`.
O contrato do arquivo de configuração: `prompt-builder docs config`.


## Dataset estável (treino comparável entre sessões)

```bash
prompt-builder library init --profile meu-alvo
prompt-builder library add --profile meu-alvo --file itens.json   # aceita reference | expected
prompt-builder library verify --profile meu-alvo                  # itens sem gabarito = exit 3
```

Depois aponte o config: `"scenarios": { "from": "library", "profile": "meu-alvo" }`.
Detalhes em `docs train`.
