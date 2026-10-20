# Modelos locais — medir e evoluir o que roda na sua máquina

O prompt-builder mede modelos LOCAIS lado a lado com os da nuvem, no mesmo comando, sem proxy:

- **decisões** — um `llama-server` com a API SystemOne/TypeSafe (`POST /v1/systemone {state, questions}`
  → `{answers, usage}`), ex.: um checkpoint de decisão tipada como o Laya. Entra no modo JEV em
  `models.decision` (`jev eval/compare/train`);
- **chat** — qualquer endpoint OpenAI-compatível (`POST /chat/completions`), ex.: um modelo GGUF servido
  por llama.cpp, LM Studio, Ollama (`/v1`) ou o motor do seu app. Entra como competidor, contestante ou
  em qualquer papel de chat (`compare`, `vary`, `train`, `models.llm` do JEV).

## Configuração

```bash
export PB_LOCAL_MODELS="local/laya-ptes=http://<host>:<porta>"       # decisões (llama-server)
export PB_LOCAL_CHAT="local/k2-horizon=http://<host>:<porta>/v1"       # chat sem chave
export PB_LOCAL_CHAT="local/k2-horizon=@/caminho/endpoint.json"        # chat com {url, apiKey, model}
export PB_LOCAL_CHAT_CONTEXT=16384                                     # janela anunciada no catálogo
export PB_LOCAL_API_KEY=…                                              # Bearer dos endpoints de decisão
prompt-builder local list --check                                      # o que está configurado e se responde
```

- Vários modelos: separe por vírgula (`local/a=http://…,local/b=http://…`).
- O id **sempre** começa por `local/` (nunca sombreia um id da nuvem); id fora disso é recusado com aviso.
- `@arquivo.json` é relido a cada chamada: o servidor local pode reiniciar com outra porta ou chave.

## O que muda numa run

| ponto | comportamento |
|---|---|
| custo | 0 (`usage.cost = 0`); o pré-voo estima 0 para os locais |
| catálogo | `models list`/`models show local/…` e o catálogo de decisões trazem os locais (sem nuvem, só eles) |
| concorrência | UMA chamada por vez por endpoint (um modelo, uma GPU); o resto da run segue em paralelo |
| tokens | os do servidor local quando ele devolve `usage`; senão estimativa (caracteres/4) |
| geração | id `local-…`, respondido sem ir à nuvem |
| esforço | sem `reasoning` no catálogo: o modelo local roda como o servidor dele estiver configurado |

Run com muitas chamadas locais: abaixe a concorrência global e suba os timeouts, porque a fila local
conta no relógio de cada chamada (e rode a run como sempre):

```bash
export OPENROUTER_MAX_CONCURRENCY=4
export OPENROUTER_ROLE_TIMEOUTS="competitor=300/900"
```

## Exemplos

```json
{ "models": { "decision": ["typesafe/jev-1.13", "local/laya-ptes"] } }
```

```json
{ "models": { "competitors": ["deepseek/deepseek-v4-flash", "local/k2-horizon"], "judges": ["google/gemini-3.8-flash"] } }
```

## Armadilhas

- O juiz e o gabarito continuam na nuvem por padrão: a key do OpenRouter segue necessária para eles.
- Modelo local pequeno costuma truncar ou fugir do formato com prompt longo: meça o prompt **da versão
  local** (curto, com exemplos no formato exato) contra o da nuvem, não o mesmo prompt nos dois.
- Um checkpoint de decisão só serve na pergunta para a qual foi treinado: meça antes de trocar o decisor
  de nuvem por ele (p≈0,5 em tudo = a pergunta está fora do que ele aprendeu).
