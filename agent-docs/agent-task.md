# O contrato `arena-agent-config@1|@2` (a configuração do modo agente)

O arquivo de configuração do modo agente, campo a campo. Formato
**`arena-agent-config@1`** (ou `@2`) — não um campo a mais no `arena-config@1`:
este também é lido pelo motor do navegador, e aceitar campos de agente lá faria
a UI validar uma configuração que ela nunca poderia executar.

```jsonc
{
  "format": "arena-agent-config@1",
  "mode": "compare",                    // compare | variation | training
  "theme": "Correção de bugs em TypeScript",
  "scenarioBrief": "…",

  "agent": {
    "executor": "pi",
    "executorVersion": "0.84.2",
    "install": "isolated",
    "provider": "openrouter",
    "promptMode": "append",
    "thinking": "medium",
    "tools": ["read", "write", "edit", "bash", "grep", "find", "ls"],
    "repetitions": 3,
    "maxParallel": 4,
    "isolation": { "kind": "worktree", "keepWorkspace": false },
    "limits": {
      "maxTurns": 30,
      "maxCostUsd": 0.40,               // OBRIGATÓRIO
      "timeoutMs": 600000,
      "maxOutputBytes": 8388608,
      "maxDiffBytes": 524288
    }
  },

  "models": {
    "datagen": "…", "judges": ["…"], "reference": "…",
    "competitors": ["anthropic/claude-…", "openai/gpt-…", "google/gemini-…"]
  },

  "scenarios": [
    {
      "question": "O parser de datas quebra com fuso negativo. Conserte e prove.",
      "productContext": "Você é um agente de manutenção deste repositório…",
      "rubric": "Resultado: date.test.ts passa inteiro. Escopo: não altere testes.",
      "agentTask": {
        "repo": { "kind": "git", "path": "./fixtures/date-lib", "ref": "a1b2c3d", "shallow": true },
        "setup": [{ "cmd": "npm ci --ignore-scripts", "timeoutMs": 180000 }],
        "verify": [
          { "label": "typecheck", "cmd": "npx tsc --noEmit", "weight": 1 },
          { "label": "testes",    "cmd": "npm test -- --run", "weight": 3 }
        ],
        "forbiddenPaths": ["test/", "*.test.ts", "package.json"]
      }
    }
  ],

  "judging": { "reference": true, "passes": 1, "dossierTokens": 12000 },
  "duels": true,
  "finalists": 2
}
```

## Raiz

| Campo | Tipo | Obr. | Descrição |
|---|---|---|---|
| `format` | string | **sim** | `"arena-agent-config@1"` ou `"…@2"` (campos aditivos no `agentTask`). Outro valor é rejeitado. |
| `mode` | string | **sim** | `compare` \| `variation` \| `training`. A pergunta da run (qual modelo? qual prompt? evoluir o prompt?). |
| `theme` | string | sim | Tema/título da run. |
| `scenarioBrief` | string | não | Instruções do autor para os cenários (não é usado em datagen de agente na v1 — ver nota). |

**Nota sobre `stages`/`scenarioBrief`:** em modo agente `stages` é **forçado ao
tamanho de `scenarios`** — datagen de tarefa de agente **não existe na v1**. Um
LLM não consegue gerar `repo`+`setup`+`verify` que de fato rodem sem executá-los.
Os cenários são sempre **pinados** no arquivo.

## `agent` — o executor, do ponto de vista da run

É aqui que a run diz *quem executa, com que modelo, sob que isolamento e limites*.
Vive em `config.agent` (é config **da run**, não da etapa): a mesma tarefa precisa
rodar sob o mesmo executor para todos os contestants, senão o experimento compara
duas coisas ao mesmo tempo. `agent.limits` é o **default** de todo
`scenario.agentTask.limits` ausente — senão cada cenário repetiria o mesmo bloco.

| Campo | Tipo | Obr. | Default | Descrição |
|---|---|---|---|---|
| `executor` | string | **sim** | `pi` | Qual adaptador. A v1 implementa só `'pi'` (pi.dev). |
| `executorVersion` | string | **sim** | — | Versão **exigida** do executor. Divergência = run falha no pré-voo. **Nunca `latest`.** |
| `install` | string | não | `isolated` | `'system'` usa o `pi` do PATH (rápido, mas o ambiente do dev vaza); `'isolated'` instala a versão pinada num prefixo temporário (reprodutível). |
| `provider` | string | não | `openrouter` | Provider do agente. |
| `promptMode` | string | não | `append` | Como o prompt sob teste chega ao agente. Ver abaixo. |
| `thinking` | string | não | `medium` | Nível de raciocínio do agente (mesma escada de 7 degraus do repo). |
| `tools` | string[] | não | built-ins do executor | Allowlist de ferramentas. Diferente entre contestants = dois com poderes diferentes. |
| `repetitions` | int | não | 1 | Execuções por (contestant × cenário). Agente é **estocástico**; com 1, um veredito é amostra de tamanho 1 → a diferença entre contestants pode ser ruído. Use 3+ quando a decisão importa. |
| `maxParallel` | int | não | `min(4, cpu-1)` | Execuções **simultâneas** neste processo. Recurso escasso é a máquina (processo Node + shells + I/O), não o rate limit do provedor. |
| `isolation` | objeto | não | `{kind:'worktree'}` | Ver abaixo. |
| `limits` | objeto | não | defaults abaixo | Limites default herdados por todo `agentTask.limits` ausente. |

### `agent.isolation`

| Campo | Tipo | Obr. | Default | Descrição |
|---|---|---|---|---|
| `kind` | string | não | `worktree` | `'worktree'` (default) \| `'clone'` \| `'container'`. **`worktree`** = `git worktree` raiz de mundo, artefatos no workspace local, nada de Docker. **`clone`** = clone descartável por execução (o executor o clona/descarta ao fim). **`container`** = cada execução do `pi` roda num **container Docker efêmero** (ver **Modo container** abaixo e em `docs agents`) — o agente fica isolado do host além da parede de processo; `setup[]`/`verify[]` (oráculo) também rodam em sandbox próprio (ver `docs agents`). |
| `keepWorkspace` | bool | não | `false` | Guardar o workspace ocupa disco rápido; default **não guardar** — só para debug. `.workspace-kept` = caminhos do workspace e do repo de auditoria. |
| `image` | string | não | `prompt-builder-pi:<executorVersion>` | Só tem efeito quando `kind === 'container'`. **Sobrescreve a tag** da imagem do `pi` (default `prompt-builder-pi:<executorVersion>`). Aceita tag **ou** referência por digest (`repo@sha256:…`/`sha256:…`). A tag só serve para achar a imagem: a preparação a resolve para o **digest sha256** e **todo `docker run` usa o digest** (gravado no `argv.json`). Digest ausente no daemon = erro pedindo `docker pull` (nada é puxado em silêncio). |
| `runtime` | string | não | — (runc) | Só em `kind === 'container'`. Runtime OCI **opt-in** do Docker, ex. `"runsc"` (gVisor) — opção de **alto risco operacional**, fora do default (~2× em syscalls, muito pior em I/O de arquivos pequenos como `npm ci`). Validado no daemon **antes** da run. |

#### `Modo container` (`kind: "container"`)

Cada execução do `pi` roda num container Docker efêmero por repetição, com perfil
endurecido fixo (`--network none`, `--read-only`, `--cap-drop ALL`, usuário do host,
imagem por digest) e a key do OpenRouter **fora** do sandbox (proxy de inferência
local, token fictício por execução). `setup[]`/`verify[]` em sandboxes próprios. Detalhes —
imagem, binds, proxy, rede, `agents doctor --container` e a válvula do operador:
`prompt-builder docs agents` → **Modo container**. Falha de infraestrutura nunca vira
`nao`: `docs agents` → **Falhas de infraestrutura**.

### `agent.limits`

| Campo | Tipo | Obr. | Default | Descrição |
|---|---|---|---|---|
| `maxTurns` | int | não | 30 | Turnos do agente (contados por evento `turn_start`). |
| `maxCostUsd` | number | **sim** | — | **Teto de gasto desta execução, em USD. OBRIGATÓRIO.** Ver `docs agents`. |
| `timeoutMs` | int | não | 600000 | Parede de tempo da execução inteira (10 min). |
| `maxOutputBytes` | int | não | 8388608 | Teto de bytes de stdout+stderr gravados (8 MiB). Acima disso, mata. |
| `maxDiffBytes` | int | não | 524288 | Teto de bytes do diff considerado (512 KiB). Acima, o dossiê trunca com marca. |

### `promptMode` — `replace` vs `append` vs `none`

`promptMode` é onde mora o erro metodológico mais provável. É a distinção de como
o prompt sob teste chega ao `pi` (`--system-prompt` vs `--append-system-prompt`):

- **`'replace'`** — mede **"este texto é um bom system prompt de agente?"**. O
  agente perde as instruções de uso de ferramenta que o prompt default do `pi` dá.
  Armadilha quando o objeto sob teste **não é** o prompt de agente inteiro: o
  agente vira burro e você conclui que o prompt é ruim.
- **`'append'`** — mede **"esta instrução melhora um agente competente?"**. É o
  default, porque é a pergunta que quase todo mundo está fazendo.
- **`'none'`** — nada é injetado: é o modo do `compare` de **modelos** como
  agentes, onde a única variável é o modelo.

Confundir esses três torna a comparação entre runs com modos diferentes
visivelmente inválida — por isso `promptMode` entra no cabeçalho do dossiê e no CSV.

## `models` — os papéis

Os mesmos papéis do `arena-config@1`, com um cuidado extra:

- **`competitors`** — os modelos que rodam como agentes. É neles (e no `agent`
  config) que as variantes competem.
- **`judges` / `reference`** — o modelo juiz/contagem. **Não pode ser o modelo do
  agente sob teste** (viés de auto-preferência).
- **`datagen`** — barato e decente; gera cenários (chat). Para agentes na v1 não
  há datagen de tarefa — os cenários são pinados.

### ERRO COMUM — modelos BYOK sem saldo

Se um modelo vem de provider **BYOK** (traga sua própria key) e essa key não tem
saldo, a execução do agente falha por cima do orçamento e todos os contestants
saem com aparência de erro de infra. Antes de culpar a config, troque por um
modelo com saldo garantido no provider do `pi`, ex.: **`google/gemini-2.5-flash`**.

## `scenarios[]` — a espinha (idêntica ao chat + `agentTask`)

Cada cenário reusa verbatim `question`, `productContext` e `rubric` do chat, e
ganha o bloco `agentTask` que descreve o **mundo** em que o agente acorda (nunca
o agente em si — isso é `agent.`). Separar os dois é o que permite rodar a mesma
tarefa com agentes diferentes.

| Campo | Obr. | Descrição |
|---|---|---|
| `question` | sim | A tarefa. Vai para o stdin do `pi` como prompt inicial. |
| `productContext` | não | Contexto/política → `--append-system-prompt` (ou `--system-prompt` em `replace`). |
| `rubric` | não | **NÃO vai para o agente.** É a régua do juiz — entregar é dar o gabarito (reward hacking). |
| `agentTask` | **sim quando runner `'agent'`** | Ver abaixo. Ausência = **erro de config**, não fallback para chat. |

### `scenario.agentTask`

| Campo | Obr. | Descrição |
|---|---|---|
| `repo` | não | Repositório-semente (ver abaixo). Ausente = workspace `git init` + commit vazio. |
| `setup` | não | Comandos rodados **antes** do agente acordar (`npm ci`, `pip install`, build). **Não contam como trabalho do agente e não entram na trajetória julgada.** Falha aqui = etapa `error` para todos. |
| `files` | não | Fixtures escritos no workspace depois do setup (entrada, casos de teste, mocks): `{path, content}[]`. |
| `verify` | não | **Oráculo determinístico** (ver abaixo). |
| `forbiddenPaths` | não | Caminhos que o agente **não pode tocar**. Violação ⇒ `nao` automático (score 0), sem juiz. **Semântica gitignore** (`*.test.ts` em qualquer nível, `/test/` na raiz, `**`, `!padrão`). Checado pelo diff (inclusive a **origem** de rename) **e** por SHA-256 contra o seed no filesystem — pega arquivo ignorado pelo `.gitignore`. |
| `rebuild` | não | Rebuild de dependências **antes** do `verify[]`: `lockfiles` (default `["package-lock.json"]`) voltam aos bytes do seed e `cmd` (default `npm ci --ignore-scripts --no-audit --no-fund` — sem os lifecycle scripts do pacote raiz, que o agente controla pelo `package.json`) reconstrói. Com rebuild, `lockfiles` e `protect` (default `["node_modules/"]`) entram no hash de protegidos: dependência adulterada é violação — e os checks rodam contra as deps limpas. Rebuild falho ⇒ checks não rodam e a repetição fica **sem veredito** (infra; nunca `nao`), salvo violação. Deps que exigem install script: declare `cmd` e proteja o `package.json` em `forbiddenPaths`. `timeoutMs` default 600000. |
| `detectors` | não | Detectores estáticos sobre o diff (`skip`/`only`/`todo`, `xfail`, `exit(0)`/`\|\| true` **só em arquivo de teste/config de runner**, teste apagado, config de runner editada — inclusive `preinstall`/`install`/`postinstall`/`prepare` no `package.json`). `warn` (default) só registra em `oracle.json`; `fail` transforma em violação (a explicação do `nao` distingue detector de caminho protegido); `off` desliga. |
| `contextFiles` | não | Autoriza o agente a ler `AGENTS.md`/`CLAUDE.md` do repo-semente. Default desligado (segurança contra prompt injection); quando ligado, o dossiê **destaca** que o repo instruiu o agente. |
| `limits` | não | Limites **por execução**; herda de `agent.limits`. Default: obrigatório (ver `maxCostUsd`). |
| `regression` `testsDir` `solution` `env` `metadata` | não | (@2) Ver `docs agents` → **Tarefa @2**. |

#### `agentTask.repo`

| Campo | Descrição |
|---|---|
| `kind` | `'git'`. |
| `url` | Clonável (https/ssh) **ou** caminho local. Um dos dois. |
| `path` | Caminho local, **relativo ao arquivo de config**. Um dos dois. |
| `ref` | Commit/tag/branch. **EXIGIDO quando há repo**: sem ref pinada não há reprodutibilidade. |
| `shallow` | Clone raso — barato e suficiente; `false` quando a tarefa envolve histórico. |

#### `agentTask.verify` — o oráculo

Comandos cujo exit code decide o veredito, rodados **depois** do agente, no mesmo
workspace, na mesma ordem. **Quando existe oráculo, ele MANDA** — é a única parte
do julgamento que não depende de um LLM ter um bom dia.

| Campo | Obr. | Default | Descrição |
|---|---|---|---|
| `cmd` | **sim** | — | O comando. |
| `label` | não | — | Rótulo curto para o dossiê e o CSV ("testes unitários", "typecheck"). |
| `expectExit` | não | 0 | Exit code esperado. |
| `timeoutMs` | não | — | Tempo máximo do próprio check. |
| `weight` | não | 1 | Ponderação quando há vários. |
| `kind` | não | `fail_to_pass` | `fail_to_pass` = o que a tarefa pede; `pass_to_pass` = **regressão** (passava no seed, tem de continuar passando). A nota é a dos F2P; **P2P quebrado zera a nota** (a execução falhou) — P2P que **trava** (timeout) ou **morre por sinal** conta como quebrado. P2P que não pôde rodar (comando ausente) fica `unverified`: a nota cheia não vira `resolve` (teto `parcial`). |

**Por que lista, não um "script de teste":** o veredito precisa ser *decomponível*
— "typecheck ✓ · testes ✗ (3 falhas) · lint ✓" em vez de 4000 linhas de test runner.

Mapeamento do oráculo para veredito:

| Situação | Veredito | Juiz LLM |
|---|---|---|
| `forbiddenPaths` violado (diff, rename, hash, deps do rebuild) | **`nao`** (score 0) | não roda (indiscutível) |
| `pass_to_pass` quebrado (inclui travado/morto por sinal) | **`nao`** (score 0) | não roda |
| `rebuild` falhou (sem violação) | **sem veredito** (fora do placar — infra) | não roda |
| check que **pendura ou morre** (passa do `timeoutMs` do check / morto por sinal) | o check conta como **falho** no `score` (sem re-verificação: é o código sob teste) | conforme o `score` resultante — nunca promove |
| check cujo comando **nem começa** (ausente / sem permissão) | re-verifica **só esse check** 2×; persistindo, conta como **falho** — se ele rodou em alguma outra execução da etapa (o agente quebrou o verificador) | conforme o `score` |
| … e não rodou em **nenhuma** execução da etapa | **etapa inválida para TODOS** os contestants (`stage.error`, fora do placar de todos) — defeito da tarefa | não conta |
| `score === 1` com P2P não aferido | **`parcial`** (candidato, teto) | roda; pode rebaixar para `nao` |
| `score === 1` | **`resolve`** (candidato) | roda só para graduar qualidade; **não pode rebaixar para `nao`** |
| `0 < score < 1` | **`parcial`** (candidato) | roda; pode confirmar ou rebaixar para `nao` — **nunca promover a `resolve`** |
| `score === 0` | **`nao`** | não roda |

Falha do juiz (exceção, timeout ou resposta que não é o JSON pedido — recusa
e texto livre incluídos —, mesmo após 2 retentativas) **não mexe na nota**: fica
o candidato do oráculo, com a flag `judgeError` contada por run
(`agentJudgeErrorCount`). Sem oráculo não há candidato — a execução fica sem nota
em vez de ganhar um `parcial` inventado.

Dica de autoria: prefira chamar a suíte por um programa que sempre existe no
ambiente (`sh run_tests.sh`, `npm test`) a executar o script direto
(`./run_tests.sh`): o comando sempre começa, e um script apagado pelo agente vira
falha limpa do check. A invalidação da etapa fica para o que não começa em
execução nenhuma (binário que falta na imagem/ambiente da tarefa).

## `judging`

| Campo | Tipo | Obr. | Default | Descrição |
|---|---|---|---|---|
| `reference` | bool | não | true (**false automático** quando toda etapa tem `verify[]`) | Julgamento por referência (gabarito). Etapa com `verify[]` **nunca** gera gabarito, mesmo com `true` explícito: o oráculo decide. |
| `passes` | int | não | 1 | Passadas do juiz. |
| `dossierTokens` | int | não | 12000 | Teto de tokens do **dossiê** — o que o juiz realmente lê (não a trajetória crua, que tem megabytes). É **config**, não constante: é ele que liga o custo do juiz ao tamanho da evidência. |

O gabarito de agente tem três encarnações, em ordem de preferência: **(a)** se a
tarefa tem `verify[]`, ela já tem gabarito ("os testes passam") — o gabarito
textual **não é gerado** (0 tokens; antes custava ~64% de uma run trivial sem
ninguém lê-lo) e as **finais dessa etapa são decididas pelo oráculo** (maior score
vence; score igual = empate, sem juiz LLM); **(b)** gabarito importado via
`reference` do scenario; **(c)** uma execução de referência (modelo forte, mesmos
limites) cujo dossiê vira o gabarito.

## `duels` / `finalists` — as finais

| Campo | Tipo | Obr. | Default | Descrição |
|---|---|---|---|---|
| `duels` | bool | não | true | Liga as finais. |
| `finalists` | int | não | **2** (agente) | Nº de finalistas por judge-score médio. **Menor que o de chat (3)** de propósito: um duelo de agentes é `2 × dossiê compact` no modelo mais caro do pipeline; com 3 são 3 pares × 2 ordens × N cenários. |

O duelo atual:
- Duelo decidido pelo **oráculo** sem LLM: se os dois lados têm oráculo e os
  `score` diferem, vence o maior. Só empate de oráculo vai para o LLM.
- Compara o par no **mesmo cenário e na mesma repetição** — repetição 0 de A vs 2
  de B introduz variância no lugar do sinal.

## Erros comuns

| Sintoma | Causa | Correção |
|---|---|---|
| `maxCostUsd` obrigatório (exit `3`) | `agent.limits.maxCostUsd` ausente | Preencha o teto por execução. Sem ele não há estimativa nem orçamento. |
| `scenario agentTask ausente` (exit `3`) | Cenário com runner `'agent'` sem `agentTask` | Adicione o bloco. Cair para chat em silêncio mediria outra coisa. |
| "datagen não suportado" / sem `stages` | Datagen de tarefa de agente não existe na v1 | Pinee os cenários. Não peça `stages` > nº de `scenarios`. |
| Agente falha pronto, todos `nao`, custo certo | Modelo **BYOK** sem saldo no provider do `pi` | Use modelo com saldo, ex. **`gemini-2.5-flash`**. |
| `variation`/`training` estranhos | PromptMode confundido | `replace` mede o prompt inteiro; `append` (default) mede a instrução sobre um agente competente; `none` isola o modelo. |
| `docker: comando não encontrado` (ou daemon indisponível) em `kind: "container"` | Docker CLI fora do PATH ou daemon inacessível **sem sudo** | Instale/ative o Docker e garanta acesso sem sudo. Confirme com `agents doctor --container` (falha com exit `3` quando o CLI/imagem faltam). |
| imagem docker `prompt-builder-pi:<ver>` ausente em `kind: "container"` | A imagem ainda não existe no daemon | A **primeira preparação de run em container** cria/cacheia automaticamente. Adiantar: `docker build` seguindo o Dockerfile documentado (em produção, o Dockerfile está **embutido em `src/agent/container.ts`**). |
| `0.061` visto com `maxCostUsd: 0.05` | Teto aproximado **por baixo** | É o teto funcionando: a chamada em voo já foi cobrada. |

Referência curta do que é o modo agente: `prompt-builder docs agents`.