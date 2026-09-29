# `compare` — qual modelo responde melhor

```bash
prompt-builder compare \
  --models openai/gpt-5-mini,google/gemini-3.8-flash,deepseek/deepseek-v4-pro \
  --judge anthropic/claude-sonnet-5 \
  --datagen xiaomi/mimo-v2.6-pro \
  --theme "Extração de dados de notas fiscais brasileiras" \
  --stages 8 --budget 2
```

Regras do schema, todas rejeitadas na validação (código `3`):

- pelo menos **2** competidores, todos distintos;
- o modelo de `--datagen` **não** pode ser competidor;
- nenhum `--judge` pode ser competidor.

## Comparar configurações do mesmo modelo

Para medir o efeito de temperatura ou de nível de raciocínio, use um
`arena-config@1` com `competitorConfigs` — ali a identidade do concorrente é a
**tripla** modelo + temperatura + raciocínio, então o mesmo modelo pode competir
contra si mesmo:

```json
{
  "format": "arena-config@1",
  "mode": "compare",
  "theme": "…",
  "models": {
    "datagen": "xiaomi/mimo-v2.6-pro",
    "judges": ["anthropic/claude-sonnet-5"],
    "competitorConfigs": [
      { "model": "openai/gpt-5-mini", "reasoning": "low" },
      { "model": "openai/gpt-5-mini", "reasoning": "high" }
    ]
  }
}
```

Confira antes que os dois níveis existem naquele modelo:
`prompt-builder models show openai/gpt-5-mini --json | jq .data.model.thinkLevels`
(o `--json` vem no envelope `{ok, command, data}` — o modelo fica em `.data.model`).

## Julgamento

No `compare` clássico (lista de modelos), o julgamento padrão é o **listwise**:
o juiz ordena as respostas às cegas. Com `competitorConfigs`, ou passando
`referenceJudging: true` no arquivo, o julgamento passa a ser **por gabarito**
(pointwise + finais), que é mais estável e produz judge-score comparável entre
runs.

## Modo econômico do juiz (`--judge-cascade`)

O papel juiz domina o custo. `--judge-cascade barato1,barato2:forte` troca o
painel por uma **cascata**: os 2 juízes baratos votam em paralelo e o forte só
julga os vereditos em dúvida — os baratos divergem (ou um não votou), algum
voto saiu `parcial`, ou a resposta é o extremo de comprimento de uma etapa com
razão > 3×. Sem gatilho, vale o consenso barato. Os 3 modelos são distintos e
nenhum pode competir (exit `3`). O record traz `judgeCascade` (vereditos,
escalonados e `escalatedFraction`); o custo segue medido em `costByRole.judge`.
Vale em `compare`/`vary`/`train` por flag (o `arena-config@1` não tem a chave).

## Resultado

```bash
prompt-builder runs winner <runId> --json
prompt-builder runs show <runId> --json | jq '.data.run.judgeScoreByContestant'
```

Se as finais rodaram, a régua é `standings` (taxa de vitória nos duelos); senão
é o judge-score médio. O CLI sempre diz qual das duas foi usada — elas não são
intercambiáveis.
