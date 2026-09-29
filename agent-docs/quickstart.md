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
#    (Só a execução exige key: models, estimate e --dry-run funcionam sem ela.)
echo "$OPENROUTER_API_KEY" | npx prompt-builder-cli key set --stdin

# 2. Descubra o modelo do seu ambiente e quais níveis de raciocínio ele aceita.
npx prompt-builder-cli models list --search claude --json | jq '.data[0]'

# 3. Escreva a configuração (ou gere um exemplo e edite).
npx prompt-builder-cli config example --mode train -o arena.json

# 4. PRÉ-VOO sem gastar nada. Sempre faça isto antes (mesmo --budget da run).
npx prompt-builder-cli train --config arena.json --budget 10 --dry-run --json

# 5. Rode. Com --output-format ndjson você acompanha evento a evento.
npx prompt-builder-cli train --config arena.json --budget 10 --output-format ndjson

# 6. Promova o vencedor para o arquivo: backup + diff, e BLOQUEIA (exit 10)
#    se o campeão regrediu no holdout. `--prompt-only` imprime cru, SEM o gate.
npx prompt-builder-cli sessions winner <sessionId> --apply prompt.md
```

O exemplo gerado (8 cenários, 3 iterações, 2 juízes) estima ~US$ 6–8 com os
preços de 2026-09. Preço muda: se o passo 4 sair `usage.budget_below_estimate`
(orçamento abaixo do piso) ou `usage.confirmation_required` (orçamento dentro da
faixa, sem `--yes`), use `error.details.estimate.high` como `--budget` — ou
reduza `stages`/`training.iterations`/juízes no arquivo. Nada foi gasto.

Depois do treino, `sessions report <sessionId>` diz quanto o prompt melhorou e
quanto a mudança muda o custo por chamada (`docs report`).

No checkout do repositório, `npm run agent-setup` deixa `prompt-builder` no PATH
(lançadores em `.local/bin` do seu home, ou `PB_BIN_DIR`, que executam ESTE
`dist/`), liga a skill em todos
os agentes e instala o Plannotator do relatório; `npm run agent-setup:doctor`
confere. Fora do repo, `npx prompt-builder-cli` baixa a versão publicada.

## Regras que evitam os erros mais comuns

1. **Sempre passe `--budget`.** Fora de um terminal interativo o comando
   **recusa** rodar sem ele (código de saída `2`, nada gasto). Use
   `--budget 5` para um teto em dólares ou `--budget none` para assumir o custo
   explicitamente.
2. **Nunca chute um think level.** Peça `models show <id> --json` e leia
   `thinkLevels.accepted`. O campo `thinkLevels.fit` diz o que realmente vai no
   fio para cada nível pedido — pedir `max` a um modelo que só aceita
   `[xhigh, high]` vira `xhigh`, mas um nível fora da lista pode virar HTTP 400.
3. **Sempre `--dry-run` antes de uma run cara, com as MESMAS flags.** Ele roda o
   pré-voo inteiro sem gastar (só leituras gratuitas: catálogo público e, com
   key, o saldo) e sai com o **mesmo `error.code` e código de saída** que a run
   real recusaria — todas as recusas em `error.details.wouldRefuse`, a
   estimativa em `details.estimate`. Exit `0` = a run real passaria; o que ainda
   falta (key, saldo não verificado) vem em `data.requires`.
4. **Retentativa = mesma `--idempotency-key`.** Repetir a key com a mesma
   config se anexa à run existente (espera ou devolve o resultado) e não gasta
   de novo; sem ela, um 2º processo com a mesma config sai `run.locked`. Há um
   teto diário por máquina (US$ 20 padrão, `limits show`) somando processos.
5. **O juiz não pode competir.** Nenhum modelo em `judges` pode ser o modelo sob
   teste nem um competidor — o schema rejeita (viés de auto-preferência).
6. **Leia o código de saída.** `0` ok · `1` falha inesperada · `2` uso inválido ·
   `3` config inválida · `4` auth · `5` sem crédito · `6` **run inconclusiva** ·
   `7` **parcial, orçamento esgotado** · `8` rede · `9` espera esgotada ·
   `10` portão recusou (ex.: handoff com holdout regredido) · `130` interrompido. O `7` não é erro: há resultado válido, só incompleto.
   O `6` também traz resultado, mas ele **não sustenta conclusão** (vereditos
   perdidos > 10% num papel ou < 5 cenários julgados por contestant) — não
   promova um prompt com base nele.
   Sob `--json`/`ndjson`, **todo** erro sai no stdout como
   `{ok:false, command, error:{code, kind, message, hint, details}}` — decida
   pelo `error.kind` e rode o que `error.hint` sugere (`docs ndjson`).

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
