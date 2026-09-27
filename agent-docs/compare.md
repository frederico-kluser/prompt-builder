# `compare` — qual modelo responde melhor

```bash
prompt-builder compare \
  --models openai/gpt-5-mini,google/gemini-3-flash,deepseek/deepseek-v4 \
  --judge anthropic/claude-sonnet-5 \
  --datagen openai/gpt-5-mini \
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
    "datagen": "openai/gpt-5-mini",
    "judges": ["anthropic/claude-sonnet-5"],
    "competitorConfigs": [
      { "model": "openai/gpt-5-mini", "reasoning": "low" },
      { "model": "openai/gpt-5-mini", "reasoning": "high" }
    ]
  }
}
```

Confira antes que os dois níveis existem naquele modelo:
`prompt-builder models show openai/gpt-5-mini --json | jq .model.thinkLevels`.

## Julgamento

No `compare` clássico (lista de modelos), o julgamento padrão é o **listwise**:
o juiz ordena as respostas às cegas. Com `competitorConfigs`, ou passando
`referenceJudging: true` no arquivo, o julgamento passa a ser **por gabarito**
(pointwise + finais), que é mais estável e produz judge-score comparável entre
runs.

## Resultado

```bash
prompt-builder runs winner <runId> --json
prompt-builder runs show <runId> --json | jq '.data.run.judgeScoreByContestant'
```

Se as finais rodaram, a régua é `standings` (taxa de vitória nos duelos); senão
é o judge-score médio. O CLI sempre diz qual das duas foi usada — elas não são
intercambiáveis.
