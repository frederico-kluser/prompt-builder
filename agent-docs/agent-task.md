# O contrato `arena-agent-config@1` (a configuração do modo agente)

Este é o arquivo de configuração inteiro do modo agente, campo a campo. Seu
formato é **`arena-agent-config@1`** — um formato novo, não um campo a mais no
`arena-config@1`. O parser despacha por `format`, e o `arena-config@1` também é
lido pelo motor do navegador; aceitar campos de agente lá faria a UI validar com
sucesso uma configuração que ela nunca poderia executar.

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
| `format` | string | **sim** | Sempre o literal `"arena-agent-config@1"`. Qualquer outro valor é rejeitado. |
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
| `kind` | string | não | `worktree` | `'worktree'` (default) \| `'clone'` \| `'container'`. **`worktree`** = `git worktree` raiz de mundo, artefatos no workspace local, nada de Docker. **`clone`** = clone descartável por execução (o executor o clona/descarta ao fim). **`container`** = cada execução do `pi` roda num **container Docker efêmero** (ver `#### Modo container` abaixo) — o agente fica isolado do host além da parede de processo; `setup[]`/`verify[]` (oráculo) seguem no **host** (ver nota). |
| `keepWorkspace` | bool | não | `false` | Guardar o workspace ao fim ocupa disco rápido; o default é **não guardar** (descarta quando o modo permitir) — só ligue para debug. |
| `image` | string | não | `prompt-builder-pi:<executorVersion>` | Só tem efeito quando `kind === 'container'`. **Sobrescreve a tag** da imagem do `pi` (default `prompt-builder-pi:<executorVersion>`). Aceita tag **ou** referência por digest (`repo@sha256:…`/`sha256:…`). A tag só serve para achar a imagem: a preparação a resolve para o **digest sha256** e **todo `docker run` usa o digest** (gravado no `argv.json`). Digest ausente no daemon = erro pedindo `docker pull` (nada é puxado em silêncio). |
| `runtime` | string | não | — (runc) | Só em `kind === 'container'`. Runtime OCI **opt-in** do Docker, ex. `"runsc"` (gVisor) — opção de **alto risco operacional**, fora do default (~2× em syscalls, muito pior em I/O de arquivos pequenos como `npm ci`). Validado no daemon **antes** da run. |

#### `Modo container` (`kind: "container"`)

Quando `isolation.kind` é `'container'`, a **execução** do agente (e só ela — `setup[]`
e `verify[]`/oráculo continuam no host) roda num container Docker **efêmero** por
repetição:

- **Imagem default:** `prompt-builder-pi:<executorVersion>` (ex. `prompt-builder-pi:0.84.2`),
  derivada da versão pinada do executor. Ela é **criada na primeira preparação de run
  em container** (via `ensurePiImage`, com o Dockerfile embutido em `src/agent/container.ts`)
  e **cacheada por tag** — o `doctor` **não** builda; `isolation.image` sobrescreve a tag.
  Dockerfile em produção: `node:22-bookworm-slim` + `git`/`ca-certificates`/`bash` +
  `npm i -g @earendil-works/pi-coding-agent@<versão>`.
- **Execução efêmera por rep:** `docker run -i --rm` com o container nomeado
  `pb-agent-<execId>`, binds `<workspace>` → `/ws` (cwd), `<execDir>/session` →
  `/exec/session` e `<execDir>/pi-home` → `/exec/pi-home`. Os artefatos que o agente
  grava **aparecem no host** sem `docker cp`; o resto do `<execDir>` (argv.json, logs
  crus) **não** é montado — o agente não alcança a própria auditoria.
- **Perfil endurecido FIXO (sem knob no arquivo):** `--cap-drop ALL --security-opt
  no-new-privileges --read-only` + `--tmpfs /tmp` e `--tmpfs /exec`, `--network none`,
  `--pids-limit 512`, `--cpus` ≤ 2, `--memory 2g --memory-swap 2g`, `--pull never` e imagem por
  **digest**. O `argv.json` da execução registra o digest e o perfil efetivo
  (`hardening`) para conferir contra o `docker inspect`. Graváveis dentro do container:
  só `/ws`, `/tmp`, `/exec/session` e `/exec/pi-home` (= `$HOME`).
- **Usuário:** `--user <uid>:<gid>` = o **usuário do host**, **nunca root** — os
  artefatos criados no container são legíveis pelo host **sem sudo**. Rodar o
  prompt-builder como root com `kind: "container"` é recusado (use um usuário comum ou
  Docker rootless).
- **Key do OpenRouter:** entra por um **`--env-file` tmp 0600 no HOST** (fora dos
  volumes, via `os.tmpdir()`), que é **apagado ao fim** do run. Nunca em arquivo de
  volume/container, nunca em `argv` (o `argv.json` de auditoria mascara o caminho como
  `<env-file-tmp-0600>`); a key só existe no env do processo do container.
- **Timeout/cancelamento:** mata o container **por nome** → `docker kill <nome>` +
  `docker rm -f <nome>` (fire-and-forget, idempotente). Nenhum órfão no host.
- **Rede:** `--network none` por default — o agente **não** tem rota para fora. Até o
  proxy de inferência local existir, o `pi` não alcança o OpenRouter nesse modo, e o
  `agents doctor --container` **falha (exit `3`)** dizendo isso — rode-o antes da run.
  Se a run seguir mesmo assim, cada execução termina como **erro de infraestrutura**:
  `stopReason: "error"` com `execution.infraError` (a mensagem do provedor) e a dica no
  `stderr.log` — a repetição fica **sem veredito, fora do placar e das médias; nunca
  `nao`** (a falha é da rede, não do agente). Válvula **do operador** (variável de
  ambiente, nunca campo do arquivo): `PROMPT_BUILDER_UNSAFE_CONTAINER_NETWORK=bridge`
  devolve a rede padrão — a key fica ao alcance do agente; o uso é avisado no stderr,
  no `agents doctor` e registrado em `hardening.unsafe` do `argv.json`.
- **`--cpus`** é encaixado nas CPUs do **daemon** (`docker info` → `NCPU`), não nas da
  máquina que roda o CLI — `DOCKER_HOST` remoto e a VM do Docker Desktop têm menos.
- **Pré-requisito:** Docker **CLI** no PATH **e** daemon acessível (sem sudo). Confira
  com `agents doctor --container --config x.json` (mostra a tag → digest que a run
  usaria; com `--config`, mede a `image`/`runtime` do arquivo — sem ele, a imagem
  default em runc).

**Nota de escopo (TODO de fase futura):** hoje só a **execução** do agente é isolada
pelo container. `setup[]` e `verify[]` (oráculo) rodam no HOST. Isolar esses também via
`dockerExec` está no roadmap de uma fase futura.

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
| `forbiddenPaths` | não | Caminhos que o agente **não pode tocar**. Violação ⇒ veredito `nao` automático, sem gastar juiz. Globs simples (prefixo + `*`). É a barreira determinística contra editable o teste. |
| `contextFiles` | não | Autoriza o agente a ler `AGENTS.md`/`CLAUDE.md` do repo-semente. Default desligado (segurança contra prompt injection); quando ligado, o dossiê **destaca** que o repo instruiu o agente. |
| `limits` | não | Limites **por execução**; herda de `agent.limits`. Default: obrigatório (ver `maxCostUsd`). |

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

**Por que lista, não um "script de teste":** o veredito precisa ser *decomponível*
— "typecheck ✓ · testes ✗ (3 falhas) · lint ✓" em vez de 4000 linhas de test runner.

Mapeamento do oráculo para veredito:

| Situação | Veredito | Juiz LLM |
|---|---|---|
| `forbiddenPaths` violado | **`nao`** | não roda (indiscutível) |
| `score === 1` | **`resolve`** (candidato) | roda só para graduar qualidade; **não pode rebaixar para `nao`** |
| `0 < score < 1` | **`parcial`** (candidato) | roda; pode confirmar ou rebaixar para `nao` |
| `score === 0` | **`nao`** | não roda |

## `judging`

| Campo | Tipo | Obr. | Default | Descrição |
|---|---|---|---|---|
| `reference` | bool | não | true | Julgamento por referência (gabarito). |
| `passes` | int | não | 1 | Passadas do juiz. |
| `dossierTokens` | int | não | 12000 | Teto de tokens do **dossiê** — o que o juiz realmente lê (não a trajetória crua, que tem megabytes). É **config**, não constante: é ele que liga o custo do juiz ao tamanho da evidência. |

O gabarito de agente tem três encarnações, em ordem de preferência: **(a)** se a
tarefa tem `verify[]`, ela já tem gabarito ("os testes passam") — não pague uma
execução de referência; **(b)** gabarito importado via `reference` do scenario;
**(c)** uma execução de referência (modelo forte, mesmos limites) cujo dossiê vira
o gabarito.

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