# prompt-builder pelo terminal — guia completo para agentes

Complemento da `SKILL.md`: como operar o prompt-builder **só pelo terminal** (CLI; o MCP é o
mesmo binário), de qualquer diretório, com as opções recomendadas e a pergunta obrigatória
sobre outro modelo. Profundidade de cada assunto: `prompt-builder docs <tópico>`.

## 0. Onde está e com que comando

A skill chega ao agente por **symlink** (`<dir-de-skills>/prompt-builder` → pasta real). O
`where.sh` desta pasta segue o link e resolve tudo **agora** (nada fixo no texto: se o repo
mudar de lugar, a resposta muda junto):

```bash
bash <pasta desta skill>/where.sh        # relatório: raiz, CLI, build, key, dados, o que corrigir
bash <pasta desta skill>/where.sh --cli  # só o comando do CLI, numa linha
```

No Claude Code a pasta é `${CLAUDE_SKILL_DIR}` (o caminho do link — o `where.sh` acha o real).
O relatório diz que **comando** usar: `prompt-builder` quando o do PATH leva a esta raiz; senão
`node <raiz>/dist/cli/index.js` (vale de qualquer diretório). Troque `prompt-builder` por ele em
todos os exemplos. Rode, na ordem, o que vier em "Corrigir" — exceto gravar a key (é do usuário).

| Situação que o `where.sh` mostra | O que fazer |
|---|---|
| `prompt-builder` fora do PATH (ou de OUTRA instalação) | `bash <raiz>/scripts/agent-setup.sh install` — lançadores no PATH, skill em todos os agentes, Plannotator (idempotente; `npm run agent-setup:doctor` confere) |
| `dist/` ausente ou mais velho que `src/` (checkout) | `npm --prefix <raiz> run build` |
| `node_modules` ausente (checkout) | `npm --prefix <raiz> install`, depois o build |
| key AUSENTE | o usuário roda `prompt-builder key set --stdin` (a key entra pela entrada padrão, nunca em argv) ou exporta `OPENROUTER_API_KEY`; `models`, `estimate` e `--dry-run` não precisam dela |
| raiz é um **worktree ligado** | links e lançadores globais apontados para ele quebram no `git worktree remove`: instale a partir da cópia principal (o comando vem no aviso) |
| skill é uma CÓPIA sem raiz | use o `prompt-builder` do PATH ou `npx prompt-builder-cli` (versão publicada) |

Saúde da instalação: `prompt-builder doctor` (key, limite da key, teto diário, runs ativas) e
`bash <raiz>/scripts/install-agent-skill.sh doctor` (o link da skill em cada agente). Dados das
runs: `~/.prompt-builder` (ou `--data-dir` / `$PROMPT_BUILDER_HOME`).

Escopo: esta skill é para USAR o prompt-builder — medir modelos e evoluir prompts. Mexer no
código do próprio prompt-builder é outro trabalho, com as regras do repositório dele.

## 1. O fluxo de toda run (nesta ordem)

1. **Objetivo → modo.**

   | Pergunta do usuário | Modo |
   |---|---|
   | Qual **modelo** responde melhor a este tema? | `compare` |
   | Qual **variação do meu prompt** funciona melhor neste modelo? (1 medição) | `vary` |
   | Evolua meu prompt com holdout e significância | `train` |
   | Classificação/roteamento/triagem em alto volume (decisão tipada) | `jev` (docs `jev`) |
   | Agente que mexe em arquivos (diff + trajetória) | `agents run` (docs `agents`) |

2. **Config com os defaults** (§2): `prompt-builder config example --mode <compare|vary|train> -o arena.json`
   e edite SÓ `theme`, `scenarioBrief`, `prompt` e, se o usuário pedir, `stages`.
3. **Pergunta obrigatória** (§3): outro modelo para rodar?
4. **Pré-voo**, com as MESMAS flags da run: `--dry-run --json`. Nada é gasto.
5. **Orçamento**: `usage.budget_below_estimate` ou `usage.confirmation_required` → proponha ao
   usuário `error.details.estimate.high` como `--budget`. Nunca `--force`/`--yes` sem o "sim" dele.
6. **Run** com `--budget`, `--output-format ndjson` e uma `--idempotency-key` (retentativa = a mesma
   key: anexa à run existente, não paga de novo). Longa? `--detach` + `runs wait <id>`.
7. **Resultado e entrega** (§4.6): vencedor, relatório de ciclos, handoff com gate.

```bash
prompt-builder config example --mode compare -o arena.json
prompt-builder compare --config arena.json --budget 2 --dry-run --json
prompt-builder compare --config arena.json --budget 2 --idempotency-key compare-suporte-1 --output-format ndjson
```

## 2. Opções recomendadas (mantenha-as)

São os defaults do dono do projeto, embutidos no `config example`. Mude um item só quando o
usuário pedir — e diga o que mudou.

| Opção | Recomendado | Fonte |
|---|---|---|
| Modelos por papel | as listas de `models.md` (juízes = 2 primeiros; compare = os 3 competidores; vary/train = o 1º sob teste + gabarito `z-ai/glm-5.3-flash`) | `config example` |
| Motor do juiz | JEV (`typesafe/jev-1.13`, default); a lista de juízes vira a escalada | não passe `--judge-engine llm` |
| Esforço | juiz `high`, gerador de cenários `low`; o resto no default do modelo | `effort` do config |
| Think level | só o que `models show <id> --json` lista em `thinkLevels.accepted` | nunca chute |
| Cenários | 8 no exemplo (6–12); `train` por flags = 10; ≤ 5 = modo econômico | `stages` |
| Treino | 3 iterações (3–5), holdout 0,3 (piso 10 cenários), técnicas `persona,constraints,format` | `training`/`variation` |
| Finais | 3 finalistas, duelos ligados | `finalists` |
| Orçamento | `estimate.high` do `--dry-run`, com o "sim" do usuário; teto diário US$ 20 | `limits show` |
| Saída | `--output-format ndjson` (progresso) ou `--json` (um objeto no fim) | stdout = payload |

Regras do schema (exit `3`): juiz ≠ competidor/modelo sob teste; gabarito (`reference`) ≠ juiz ≠
modelo sob teste e **obrigatório** em `vary`/`train`; no `compare`, o gerador (`datagen`) não compete.

## 3. A pergunta obrigatória: outro modelo

**Sempre** antes de gastar (toda run nova: `compare`, `vary`, `train`, `jev run`, `agents run`), mesmo
que o usuário já tenha dado os modelos. Uma pergunta por run — não a repita a cada passo.

1. Mostre o plano: modelos por papel e a estimativa do `--dry-run`.
2. Pergunte se ele quer sugerir **outro modelo para rodar**. Use a ferramenta de pergunta do
   agente (ex.: `AskUserQuestion` no Claude Code) com: "Seguir só com os recomendados", 1–2
   alternativas de `models.md` ainda fora da run (quando houver) e o campo livre para qualquer id
   do OpenRouter. Sem essa ferramenta, pergunte no chat e **PARE** até a resposta.
3. Sugestão recebida → valide: `prompt-builder models show <id> --json` (existe? `thinkLevels`,
   preço — `"unknown"` não é grátis —, `lifecycle.expirationDate`). Nome aproximado? Ache o id com
   `prompt-builder models list --search <termo>`.
4. Encaixe pelo modo, respeitando as regras do §2:

   | Modo | Onde entra o modelo sugerido |
   |---|---|
   | `compare` | competidor a mais (`models.competitors` no config, ou `--models a,b,c,<id>`) |
   | `vary`/`train` | um modelo sob teste por run: **troca** o `contestant` ou vira uma **2ª run** igual com `--model <id>` (pergunte qual); colidiu com o gabarito? o gabarito passa ao próximo livre de `models.md` |
   | `jev` | `models.decision` (modelo de decisão) ou `models.llm` (LLM na mesma decisão) |
   | `agents run` | mais um contestant no config do agente (docs `agent-task`) |
   | juiz/gabarito/gerador | só se o usuário disser que é para esse papel |

5. Refaça o `--dry-run` com as mesmas flags e mostre a estimativa nova antes de rodar.
6. Resposta "não"/"só os recomendados" → siga com os defaults, sem nova pergunta.

Sem humano algum na sessão (CI/headless): siga com os recomendados e diga no relatório que a
pergunta não pôde ser feita. Exemplo — o usuário sugeriu `openai/gpt-5-mini` no compare:

```bash
prompt-builder models show openai/gpt-5-mini --json
prompt-builder compare --models deepseek/deepseek-v4.1-flash,z-ai/glm-5.3-flash,xiaomi/mimo-v2.6-pro,openai/gpt-5-mini --judge google/gemini-3.8-flash --judge meta/muse-spark-1.3 --datagen meta/muse-spark-1.3 --theme "Suporte técnico de um SaaS de faturamento" --stages 8 --budget 2 --dry-run --json
```

## 4. Mapa completo dos comandos

### 4.1 Conhecimento (sem key)

```bash
prompt-builder docs --list           # tópicos + custo aproximado em tokens
prompt-builder docs quickstart       # comece aqui; depois docs overview/models/budget/results
prompt-builder skill                 # esta SKILL.md (skill terminal = este guia)
prompt-builder init --agent claude   # cópia da skill no projeto corrente (.claude/skills)
```

### 4.2 Modelos e think level (catálogo público, cache 24 h)

```bash
prompt-builder models list --search claude --json
prompt-builder models list --format ids
prompt-builder models show xiaomi/mimo-v2.6-pro --json
prompt-builder models export -o models.json
prompt-builder models allowlist --check
```

`thinkLevels.fit` diz o que vai no fio para cada nível pedido; `canDisable: false` = raciocínio
obrigatório. Área LGPD sensível: `models list --lgpd-area saude` (docs `models`).

### 4.3 Custo, key e limites

```bash
prompt-builder estimate -c arena.json   # faixa de custo + poder estatístico (sem key)
prompt-builder key check                # valida a key e mostra o saldo
prompt-builder limits show              # teto diário da máquina (soma todos os processos)
prompt-builder doctor
```

### 4.4 Runs: compare, vary, train

Pelo config (recomendado) — a ordem do §1 vale para os três:

```bash
prompt-builder config example --mode vary -o vary.json
prompt-builder vary --config vary.json --budget 3 --dry-run --json
prompt-builder config example --mode train -o train.json
prompt-builder train --config train.json --budget 10 --dry-run --json
prompt-builder train --config train.json --budget 10 --idempotency-key treino-suporte-1 --output-format ndjson
```

Por flags (mesmos defaults; `--base-prompt-file` é o prompt de partida e entra como controle):

```bash
prompt-builder vary --model xiaomi/mimo-v2.6-pro --judge google/gemini-3.8-flash --judge meta/muse-spark-1.3 --reference z-ai/glm-5.3-flash --theme "Classificação de tickets de suporte" --base-prompt-file prompt.md --techniques persona,constraints,format --stages 8 --budget 3 --dry-run
```

Mais: `--judge-cascade b1,b2:forte` (juiz econômico, docs `compare`), `competitorConfigs` (mesmo
modelo com esforços diferentes, docs `compare`), `prompt-builder techniques` (as 19 técnicas),
`library` (dataset estável de cenários, docs `train`), `config validate arena.json`.

### 4.5 Acompanhar, parar, retomar

```bash
prompt-builder runs status <id>             # job (--detach), run ou sessão
prompt-builder runs wait <id> --timeout 900 # exit 9 se esgotar
prompt-builder runs cancel <id>             # parada graciosa, guarda o parcial
prompt-builder runs resume <id>             # retoma sem pagar de novo o que já foi pago
```

Eventos do NDJSON e envelope de erro (`{ok:false, error:{code, kind, hint}}`): docs `ndjson`.
Decida pelo `error.kind` e rode o que o `error.hint` sugere.

### 4.6 Resultados e entrega

```bash
prompt-builder runs list
prompt-builder runs winner <id> --json
prompt-builder runs show <id> --json
prompt-builder sessions show <sessionId>
prompt-builder sessions report <sessionId> --html relatorio.html
prompt-builder sessions winner <sessionId> --apply prompt.md
prompt-builder runs reproduce <id>
prompt-builder runs export <id> -o run.json
```

- Duas réguas, não intercambiáveis: `standings` (taxa de vitória nas finais) ou judge-score médio — o
  CLI diz qual usou (docs `results`).
- `sessions winner --apply` faz backup + diff e **bloqueia** (exit `10`) se o campeão regrediu no
  holdout; `--override "<motivo>"` só com o usuário. `--prompt-only` imprime cru, sem o gate.
- Relatório para quem decide: o Markdown de `sessions report <id>` vira o brief da skill
  **plannotator-visual-explainer** (os números já vêm prontos; não recalcule — docs `report`).

### 4.7 Jev (decisões tipadas) e modo agente

```bash
prompt-builder jev example --kind triagem --mode eval -o jev.json
prompt-builder jev validate jev.json
prompt-builder jev run -c jev.json --dry-run --budget 0.05
prompt-builder jev report <runId> --markdown relatorio.md
prompt-builder agents doctor
prompt-builder agents run --config agente.json --budget 5 --dry-run
```

O Jev não é ZDR: em área LGPD sensível fica indisponível. No modo agente, `setup[]`/`verify[]`
EXECUTAM na máquina: mostre-os ao usuário antes do `--allow-exec-config` (docs `agents`).

### 4.8 MCP (mesmo binário, por stdio)

```bash
prompt-builder mcp
```

Tools: `start_run` (+`idempotencyKey`) → `jobId`, `run_status`, `cancel_run`, `get_result`,
`get_session_report`, `estimate_cost`, `list_models`, `read_docs`. Registro no Claude Code:
`claude mcp add --transport stdio arena -- prompt-builder mcp` (sem o lançador no PATH:
`npx -y prompt-builder-cli mcp`).

## 5. Códigos de saída → ação

| Exit | Significado | Ação |
|---|---|---|
| `0` | ok | leia o payload do stdout |
| `2` | uso inválido / sem `--budget` / orçamento abaixo da estimativa | corrija a flag; orçamento: §1 passo 5 |
| `3` | config inválida | `config validate <arq>`; leia `error.message` |
| `4` | auth (key ausente/recusada) | o usuário grava a key (§0) |
| `5` | sem crédito | avise o usuário; nada a repetir |
| `6` | run **inconclusiva** | há resultado, mas não sustenta conclusão: não promova |
| `7` | **parcial** por orçamento | resultado válido e incompleto; `runs resume <id>` com teto novo, se o usuário quiser |
| `8` | rede | repita com a MESMA `--idempotency-key` |
| `9` | espera esgotada (`runs wait`) | espere de novo; a run segue |
| `10` | portão recusou (holdout regredido) | não aplique; mostre o relatório ao usuário |
| `130` | interrompido | `runs resume <id>` |

Problemas comuns (400 no esforço, 402, 403, `run.locked`, teto diário, truncamento): docs
`troubleshooting`.
