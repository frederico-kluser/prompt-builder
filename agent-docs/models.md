# Modelos e think levels

O catálogo vem do OpenRouter (`GET /models`, **público: não exige key**), é
cacheado por 24 h em `~/.prompt-builder/cache/` e funciona **offline** depois da
primeira busca. `--refresh-models` força a atualização. Sem key, o `--json`
traz `"scope": "public"`.

## Exportar

```bash
prompt-builder models list                      # tabela legível
prompt-builder models list --json               # objeto único no stdout
prompt-builder models export -o models.json     # grava em arquivo
prompt-builder models export --format csv -o m.csv
prompt-builder models list --format ids         # só os ids, um por linha
```

### Filtros

`--search <texto>` · `--provider <slug>` (repetível) · `--reasoning` /
`--no-reasoning` · `--effort <nível>` (só modelos que aceitam **aquele** degrau) ·
`--supports <param>` (repetível, ex.: `temperature`, `seed`) · `--min-context N` ·
`--max-prompt-price N` / `--max-completion-price N` (**USD por milhão de
tokens**) · `--free` · `--lgpd-area <área> [--include-ressalvas]` · `--limit N`.

## O formato de export (`prompt-builder-models@1`)

```json
{
  "id": "openai/gpt-5-mini",
  "contextLength": 400000,
  "pricing": { "prompt": 2.5e-7, "completion": 2e-6, "unit": "usd-per-token" },
  "pricePerMTok": { "prompt": 0.25, "completion": 2.0 },
  "supportedParameters": ["temperature", "seed", "reasoning_effort"],
  "caps": {
    "temperature": true, "reasoning": true, "effort": true,
    "mandatory": false, "defaultEffort": "medium",
    "supportedEfforts": ["high", "medium", "low", "minimal"]
  },
  "thinkLevels": {
    "accepted": ["off", "minimal", "low", "medium", "high"],
    "default": "medium",
    "canDisable": true,
    "fit": {
      "off": "none", "minimal": "minimal", "low": "low", "medium": "medium",
      "high": "high", "xhigh": "high", "max": "high"
    }
  }
}
```

**Duas unidades diferentes convivem, e confundi-las erra por 1.000.000×:**
`pricing.*` é **USD por token** (o formato do catálogo) e `pricePerMTok.*` é
**USD por milhão** (o que humanos usam e o que os filtros de preço esperam).

## `thinkLevels` — o campo que evita HTTP 400

A escala tem **sete degraus**: `off < minimal < low < medium < high < xhigh < max`.
Cada modelo declara quais aceita; medindo o catálogo, 214 de 345 modelos têm
raciocínio e 83 declaram uma allowlist — em **20 conjuntos distintos**.

- `accepted` — os níveis que você pode pedir a este modelo.
- `canDisable: false` — raciocínio **obrigatório**: `off` é ignorado, não enviado.
- `fit` — o que realmente vai no fio para cada nível pedido. O pedido é encaixado
  na allowlist pela menor distância ordinal e, em empate, pelo degrau **mais
  barato**: pedir `max` a um modelo com `["xhigh","high"]` vira `xhigh`.

```bash
prompt-builder models show anthropic/claude-sonnet-5
```

## Escolhendo os papéis

- **`judges[0]` / `reference`** — o modelo **mais forte** disponível. Ele escreve
  os gabaritos e julga tudo; a qualidade da avaliação inteira tem teto aqui.
  Esforço `high` ou mais.
- **`contestant`** — o modelo sob teste (ou o que vai rodar em produção).
- **`datagen`** — barato e decente; gera os cenários. Esforço `low`/`medium`.
- **`rewriter`** — reescreve as variantes de prompt. Forte o bastante para
  escrever bem; default é o `datagen`.

O juiz **não pode** ser competidor nem o modelo sob teste — o schema rejeita.
