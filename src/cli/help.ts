// Help POR COMANDO + a tabela de códigos de saída compartilhada (IMPL-092,
// R-12:REC-2). Antes a tabela só aparecia no help global: um agente que lia
// `prompt-builder runs --help` nunca via o contrato de exit codes do comando
// que ia chamar. Agora TODO `--help` de comando termina com o mesmo rodapé
// (contrato de saída + tabela de códigos), e a lista `COMMANDS` é a fonte
// única do dispatch e do "você quis dizer".
//
// ⚠️ Os testes de varredura de `src/cli` (test/cli-error-envelope.test.ts)
// leem este arquivo sem cortar strings: nada de `process.exit(`, `.fail(`,
// `.result(`, `console.*`, `return EXIT.` ou `stderr.write(…Erro…)` dentro dos
// textos — nem como exemplo de uso.

/** Comandos do dispatch — base do "você quis dizer" (mantenha em par com o switch do index). */
export const COMMANDS = [
  'docs',
  'skill',
  'init',
  'models',
  'estimate',
  'key',
  'compare',
  'vary',
  'train',
  'runs',
  'sessions',
  'library',
  'techniques',
  'lgpd',
  'config',
  'registry',
  'baseline',
  'calib',
  'prompts',
  'doctor',
  'limits',
  'mcp',
  'agents',
  'telemetry',
  'jev',
] as const;

/** Rodapé comum de TODO help: contrato de saída + a tabela de códigos. */
export const HELP_TAIL = `PARA AGENTES
  Toda saída estruturada vai para o STDOUT; progresso e avisos vão para o STDERR.
  Erro sob --json/ndjson: {ok:false, command, error:{code, kind, message, hint,
  details}} no STDOUT (em ndjson, a última linha: type "result"). Decida pelo
  error.kind; error.hint traz o próximo comando.
  JSON sai COMPACTO por padrão; --pretty formata com 2 espaços.
  Listas (\`models list\`, \`runs list\`, \`sessions list\`, \`agents list\`,
  \`library list\`) têm teto default de 50 itens: --limit <N> muda o teto e
  --all devolve a lista inteira — truncar avisa no stderr.
  Nunca chute um think level: \`models show <id> --json\` diz exatamente quais
  níveis o modelo aceita e o que vai no fio para cada um pedido.
  Comece por: prompt-builder docs quickstart

CÓDIGOS DE SAÍDA (error.kind entre parênteses)
  0 ok · 1 falha inesperada (internal) · 2 uso inválido (usage)
  3 config inválida (config) · 4 auth (auth) · 5 sem crédito (credit)
  6 run inconclusiva (inconclusive: vereditos perdidos > 10% ou < 5 cenários julgados)
  7 parcial, orçamento esgotado (control) · 8 rede (network)
  9 espera esgotada — \`runs wait --timeout\` (timeout) · 10 portão recusou (gate)
  130 interrompido — Ctrl-C, SIGTERM, \`runs cancel\` (control)
`;

/** Resumo de 1 linha por comando (usado no help global). */
const RESUMO: Record<string, string> = {
  docs: 'documentação embarcada nesta versão',
  skill: 'SKILL.md deste pacote',
  init: 'instala a skill no diretório de skills do seu agente',
  models: 'catálogo do OpenRouter e capacidades de ajuste',
  estimate: 'estima o custo de uma run antes de gastar',
  key: 'key do OpenRouter (validar/gravar/remover)',
  compare: 'compara modelos no mesmo desafio',
  vary: 'testa variações de prompt num modelo',
  train: 'treina um prompt ao longo de iterações',
  runs: 'lista, mostra, exporta e cancela runs',
  sessions: 'sessões de treino e handoff do campeão',
  library: 'dataset estável de cenários + gabaritos',
  techniques: 'técnicas de variação disponíveis',
  lgpd: 'áreas de dado pessoal e regras de tratamento',
  config: 'valida, exemplifica e explica configs de run',
  registry: 'guarda de drift dos prompts de produção',
  baseline: 'pina e confere juiz/gabarito/contrato de uma run',
  calib: 'calibração juiz × humano (α de Krippendorff, AC2 de Gwet, IC95%)',
  prompts: 'regressão dos meta-prompts internos (reescritor, reflexão, datagen, gabarito, juiz)',
  doctor: 'diagnostica key, limites e o ambiente do modo agente',
  limits: 'teto diário de gasto da máquina',
  mcp: 'servidor MCP por stdio (mesmo binário)',
  agents: 'modo agente: arena de agentes com executor pi',
  telemetry: 'telemetria opt-in e os headers de atribuição enviados ao OpenRouter',
  jev: 'modo JEV: mede e evolui decisões tipadas (noul/choice/score) em casos rotulados',
};

/**
 * Uso de cada comando. Listas com `--limit/--all` (IMPL-092): teto default de
 * 50 itens, `--all` devolve a lista inteira e o truncamento avisa no stderr.
 */
const USO: Record<string, string> = {
  docs: `  docs [tópico]            imprime um tópico da documentação
  docs --list              todos os tópicos, com custo aproximado em tokens`,
  skill: `  skill [models]           imprime o SKILL.md (ou o models.md ao lado dele)`,
  init: `  init --agent <nome>      copia a pasta da skill (SKILL.md + models.md) para
                           .claude/skills, .agents/skills, … (--dry-run, --force)
  init --global            o mesmo no HOME; não mexe em AGENTS.md/CLAUDE.md e
                           mantém pasta instalada por symlink`,
  models: `  models list [filtros]    lista o catálogo (teto 50; --all/--limit N)
  models show <id>         o que aquele modelo aceita (think levels, temperatura)
  models export -o <arq>   exporta o catálogo INTEIRO com capacidades de ajuste
                           (export e -o não levam o teto de 50; --limit vale)
  models allowlist --check idade/contagem da allowlist LGPD por endpoint (sem key)

  Filtros de list: --search --provider --effort --supports --reasoning
  --no-reasoning --min-context --max-prompt-price --max-completion-price
  --free --lgpd-area --expiring --format table|json|ndjson|csv|ids
  Listas: --limit <N> (default 50) · --all (lista inteira)`,
  estimate: `  estimate -c <arquivo>    estima o custo antes de gastar (sem key)
  O arquivo pode ser arena-config@1 ou RunConfig cru.
  estimate -c <arq> --pilot-run <runId> | --pilot-session <id>
                           plano de poder com σd calibrado pelo IC95% MEDIDO do
                           piloto gravado (sem a flag: σd de tabela, não calibrado)`,
  key: `  key check                valida a key e mostra o saldo
  key set --stdin          grava a key (leia da entrada padrão, nunca de argv)
  key path | rm            onde está a key gravada | remove`,
  compare: `  compare --models a,b     compara modelos no mesmo desafio
  compare --config <arq>   usa um arena-config@1 (ver: docs config)
  Comuns: --theme --stages --judge --budget <usd|none> --dry-run
  --output-format ndjson --idempotency-key <k> --allow-concurrent --detach
  --require-approved       biblioteca: item não aprovado recusa (exit 3)
  --languages pt-BR,en     idiomas do datagen (opt-in; sem a flag, 100% pt-BR —
                           cenário fora da política vira aviso no record)
  --judge-cascade b1,b2:forte  modo econômico: 2 juízes baratos; o forte só
                           nos vereditos em dúvida (fração escalonada no record)
  --judge-engine jev|llm   motor do juiz (DEFAULT jev: modelo de decisão tipada
                           com cascata para os juízes nas bandas de baixa
                           confiança; llm = painel de juízes puro)
  --jev-judge-model <id>   modelo de decisão do juiz JEV (default typesafe/jev-1.13)
  --semantic-dedup         dedup semântico dos cenários (embeddings, papel datagen)`,
  vary: `  vary --model <id>        testa variações de prompt num modelo
  vary --config <arq>      usa um arena-config@1 (ver: docs config)
  Comuns: --theme --stages --judge --techniques --budget --dry-run --detach
  --judge-engine jev|llm   motor do juiz (default jev, com cascata — ver docs compare)
  --reference <id>         quem escreve o gabarito — OBRIGATÓRIO (≠ juiz, ≠ --model)
  --require-approved       biblioteca: item não aprovado recusa (exit 3)
  --languages pt-BR,en     idiomas do datagen (opt-in; sem a flag, 100% pt-BR)`,
  train: `  train --model <id>       treina um prompt ao longo de iterações
  train --config <arq>     usa um arena-config@1 (ver: docs config)
  Comuns: --iterations --holdout-ratio --budget --dry-run --detach
  --judge-engine jev|llm   motor do juiz (default jev, com cascata — ver docs compare)
  --reference <id>         quem escreve o gabarito — OBRIGATÓRIO (≠ juiz, ≠ --model)
  --require-approved       biblioteca: item não aprovado recusa (exit 3); sem a flag
                           a run relata curatedKofN e avisa (run.warning); o holdout
                           exige 100% aprovados quando o perfil usa curadoria
  --languages pt-BR,en     idiomas do datagen (opt-in; sem a flag, 100% pt-BR)
  --stages N               default 10 no treino: com poucos cenários o gate não
                           consegue promover (o pré-voo avisa)
  --auditable              juiz, duelo e gabarito com provedor travado (sem fallback)
  Campeão só é DECLARADO com ≥ N itens curados (âncora humana: gabarito/rótulo
  escrito por gente — gabarito gerado por IA não conta). N = training.minCuratedItems,
  default 20 — proposta SEM fonte (calibrar). Abaixo disso o resultado traz
  championDeclaration.declared=false e o prompt sai como melhor do bootstrap.`,
  runs: `  runs list [--status X]   lista runs (teto 50; --all/--limit N)
  runs show <id>           record completo + diagnóstico do juiz
  runs winner <id> [--prompt-only]
  runs reproduce <id>      config reconstruído + comando p/ re-rodar
  runs reproduce <id> --replay  re-pontua as respostas gravadas a US$ 0 (exit 3 se divergir)
  runs export <id> [-o <arq>]  artefato auditável (record + gabaritos + vereditos)
  runs export <id> --format exchange [-o <dir|arq.json>]
                           pacote prompt-builder-exchange@1 (record VERBATIM)
  runs import <dir|arq.json> [--overwrite]
                           importa runs/sessões de um pacote exchange@1; conflito
                           (mesmo id, outro conteúdo) recusa (exit 3) sem --overwrite
  runs delete <id…>        apaga de verdade: record + job + journal + chaves +
                           agent-runs/<id>/ (zero resíduo)
  runs prune [--older-than 30d] [--dry-run]
                           TTL agora; o TTL (90 dias, PB_RETENTION_DAYS; 0 desliga)
                           também roda sozinho no \`runs list\` e antes de cada run
  runs status|wait|cancel <id>  job (--detach), run ou sessão
  runs resume <id> [--budget <usd>|none]
                           retoma a run parada (órfã/cancelada/orçamento/erro): as
                           chamadas já pagas voltam do journal a US$ 0; teto = o
                           que sobrou do original (--budget = teto da continuação)`,
  sessions: `  sessions list            lista sessões (teto 50; --all/--limit N)
  sessions show <id>
  sessions winner <id> [--prompt-only | --apply <arq> [--commit] [--override "<motivo>"]]
           handoff com backup + diff; holdout regredido BLOQUEIA (exit 10)
           salvo --override com motivo (gravado na auditoria + trailer)
  sessions winner <id> --apply <arq> [--record] [--record-dir <dir>] [--commit]
           [--approver "Nome <email>"]
           registro prompt-approval@1 (hashes do prompt/dataset/config +
           evidência) em <repo>/.prompt-approvals/ (ou em --record-dir, que
           implica --record); --commit implica --record e leva os trailers
           Approved-by:/Prompt-Approval: no mesmo commit (--record-dir, então,
           dentro do repo do destino)
  sessions export <id> [-o <dir|arq.json>]
           pacote prompt-builder-exchange@1 com a sessão E as runs dela
  sessions import <dir|arq.json> [--overwrite]
  sessions delete <id…> [--keep-runs]
           apaga a sessão (e as runs dela, salvo --keep-runs)
  sessions report <id> [--html <arq>] [--markdown <arq>] [--calls-per-month N] [--annotate]
           relatório de ciclos: quanto melhorou (original × campeão, por ciclo
           e no holdout) e quanto a mudança muda o custo por chamada; --html
           grava a página no tema do Plannotator, --annotate abre na UI dele`,
  library: `  library list [--profile <id>]      perfis (ou itens de um perfil; teto 50; --all/--limit N)
  library init --profile <id> [--name <n>] [--description <d>]
               [--rules <arq.json>] [--targets <arq.json>]
                                     cria/atualiza o perfil (regras de geração com
                                     grounding e matriz de cobertura)
  library show <itemId> --profile <id>
                                     item completo (JSON)
  library add --profile <id> --file <arq|dir> [--origin official|ai|manual|import]
              [--allow-pii]          importa itens: lista, {items:[…]}, pacote pack@1
                                     ou prompt-builder-exchange@1 (diretório ou .json);
                                     campo desconhecido é PRESERVADO e toda perda sai
                                     em lostFields (stderr e resultado)
  library seed --profile <id> --file <arq|dir> [--allow-pii]
                                     seed IDEMPOTENTE por id (o que existe não é
                                     sobrescrito)
  library seed --profile <id> --generate <N> --theme <t> --model <id>
               [--budget <usd|none>] [--languages pt-BR,en] [--semantic-dedup]
                                     gera N itens via datagen + gabarito por item
                                     (tier, dimensionTags, persona… preservados);
                                     sem --languages, 100% pt-BR. O banco atual é
                                     âncora do dedup (par exato; --semantic-dedup
                                     liga embeddings, custo no papel datagen);
                                     o relatório sai em datagenReport
  library seed --profile <id> --generate <N> --tier adversarial
               --base-prompt-file <arq> --model <id> [--budget <usd|none>]
                                     cenários adversariais condicionados ao prompt-
                                     base: 6 categorias, ≥ 4 cada (N mínimo 24),
                                     single-turn (ASR@1 = limite inferior); cobertura
                                     por categoria e custo por cenário no resultado
  library verify --profile <id>      itens SEM gabarito ou rótulo curto sem labelSet
                                     (recusados no evolve; exit 3)
  library review --profile <id>      fila de curadoria: k de n curados e o que não
                                     conta (sem estado, rejeitado, aprovação velha)
  library review --profile <id> --approve <ids> [--reject <ids> --reason <tipo>
               [--note <t>]] [--adjust <ids>] [--reopen <ids>] --reviewer "Nome <email>"
                                     revisão amarrada ao contentHash (editou, caduca);
                                     aprovado conta como âncora humana no treino.
                                     Sem TTY, --reviewer é obrigatório. Tudo ou nada:
                                     id ruim = exit 2, aprovar sem gabarito = exit 3
  library coverage --profile <id>    cobertura tier × dimensão + lacunas
  library export --profile <id> [-o <dir|arq.json>] [--format exchange|pack]
                                     exchange (default): prompt-builder-exchange@1
                                     (manifest.json + library.jsonl; -o *.json = um
                                     arquivo só), reimportável por \`library add\`
                                     sem perda; pack: prompt-builder-pack@1 (seed de
                                     run, lossy — o que se perde sai em lostFields)
  library rm --profile <id> <itemId> remove um item
  library drop --profile <id>        remove o perfil inteiro

  A biblioteca mora em <data-dir>/library/<profileId>/ (um JSON por item).
  --generate gasta LLM: fora de um terminal exige --budget <usd|none>.
  Regras de geração (--rules): { templates: { system, user? }, grounding?: {
  context?, fewShot?, setupKeys?[] } } — placeholders {{context}}, {{fewShot}},
  {{setupKeys}}, {{theme}}, {{count}}. Grounding que nenhum template usa NÃO
  chega ao gerador (o init e o seed avisam).
  Item: title, tier (mft|invariance|adversarial|edge|benign-twin), persona,
  context, successCriteria[], rationale, dimensionTags[], question,
  productContext, maxTokens, rubric, reference | expected (+ labelSet), origin.
  Rótulo curto em expected (≤ 5 palavras) exige labelSet com TODOS os rótulos
  válidos da etapa (ex.: "labelSet": ["positivo","negativo","neutro"]).
  Veja também: \`docs quickstart\``,
  techniques: `  techniques               lista as técnicas de variação (id — o que faz)`,
  lgpd: `  lgpd                     áreas de dado pessoal, allowlist LGPD e cobertura
           da pseudonimização (IMPL-042)`,
  config: `  config validate <arq>    valida arena-config@1, arena-agent-config@1|@2 ou RunConfig cru (exit 3 se inválido)
  config example [--mode compare|variation|training] [-o <arq>]
           gera um exemplo VÁLIDO para o modo pedido (aliases: train, vary)
  config schema [--dialect arena|run] [-o <arq>]
           publica o JSON Schema do formato ($schema draft 2020-12 e $id com a
           versão), gerado pelo MESMO zod que valida`,
  registry: `  registry validate [--file <arq>]
           guarda de drift dos prompts de produção (exit 3 com drift)
  registry init [-o <arq>]  grava um registro-exemplo comentado`,
  baseline: `  baseline pin <runId> [-o <arq>]
           pina juiz/gabarito/contrato de uma run (judge-baseline@1)
  baseline check [--file <arq>] [--config <arq>] [--catalog <models.json>]
           gate de CI: sai 3 se juiz/gabarito mudou ou sumiu sem re-baseline
  baseline declare --reason "…" [--judge a,b] [--reference x]`,
  calib: `  calib report --file <arq.jsonl> [--pilot] [--strict] [--seed N] [--resamples N]
           α ordinal de Krippendorff + AC2 de Gwet (pesos ordinais) + IC95%
           (bootstrap por item, semeado). Humano × humano PRIMEIRO; juiz ×
           humano só fora do --pilot e com α humano ≥ 0,667; sensibilidade/
           especificidade quando há "gold". Reprovado (α < 0,667 ou juiz fora
           da faixa humana) = exit 10, relatório em error.details.report.
           --strict: pendência de prontidão (< 150 itens, estrato < 30, IC > 0,2,
           item sintético) também reprova
  calib template [-o <arq.jsonl>]
           exemplo comentado do formato calibration-jsonl@1 (itens SINTÉTICOS)
  Formato e protocolo do piloto: \`prompt-builder docs calibration\``,
  prompts: `  prompts regression --model <id> --judge <id> [--roles a,b] [--budget <usd|none>] [--dry-run]
           roda a suíte FIXA dos meta-prompts: 80 reescritas × técnicas + 40
           canários de contrato + reflexão, datagen, gabarito e juiz rotulados.
           Limiares: inválidas ≤ 10%, diversidade (1 − 8-gramas) ≥ 0,4, juiz
           ≥ 85%, κ do gabarito ≥ 0,6 — abaixo = exit 10 (gate), relatório em
           error.details.report. --dry-run estima o TETO pelo catálogo (sem
           key); rodada ≤ US$ 2. Ganho por técnica NÃO é medido (use \`vary\`).
           Rode de novo quando o fingerprint dos prompts mudar.`,
  doctor: `  doctor [--deep] [--container] [--config <arq>]
           key (exit 4 se ausente/recusada), teto diário, runs ativas e a
           sala do modo agente (canário real com --deep)`,
  limits: `  limits show              teto diário da máquina (UTC) e quem gastou hoje
  limits set --daily <usd|none>   teto somando TODOS os processos (default US$ 20)`,
  mcp: `  mcp [--data-dir <caminho>]
           servidor MCP por stdio (mesmo binário). Tools longas viram jobs
           (start_run → run_status → cancel_run); o modo agente passa pelo
           MESMO portão de execução do \`agents run\` (allowExecConfig + pin
           SHA-256 do config)`,
  agents: `  agents doctor [--deep] [--container] [--config <arq>]
           pré-voo do executor (canário real com --deep)
  agents run --config <arq> --budget <usd|none> [--allow-exec-config]
           roda a arena de agentes até o fim. ⚠️ arena-agent-config É
           CONFIGURÁVEL/EXECUTÁVEL (setup[]/verify[] rodam comandos): sem um
           hash SHA-256 aprovado o comando RECUSA (exit 3). A aprovação é
           única por conteúdo: \`--allow-exec-config\` grava o pin; conteúdo
           diferente revê a aprovação. \`--dry-run\` recusa com o MESMO
           código (config.exec_not_approved/exec_hash_changed) e nunca pina.
  agents task validate <arq> [--repetitions N] [--allow-exec-config]
           as 6 checagens da tarefa — EXECUTA setup[]/solution/checks no
           host: passa pelo MESMO portão (pin SHA-256 inclui o testsDir)
  agents task compile <arq> --out-dir <dir> [--instruction <txt>] [--scenario N]
           layout Harbor (task.toml, solution/, tests/test.sh → reward.json);
           o material do testsDir vai em tests/files/ e entra depois do agente
  agents show <runId> | list (teto 50; --all/--limit N) | logs | replay | gc`,
  telemetry: `  telemetry [status]       estado do opt-in e da atribuição (padrão)
  telemetry schema         schema PÚBLICO do payload + allowlist de eventos
  telemetry counters       contadores locais (sem id de usuário/máquina): docs --list,
                           runs export, 1ª run concluída e saída 7 — só com opt-in

  Ambiente: PROMPT_BUILDER_TELEMETRY=on liga a telemetria (DESLIGADA por
  padrão, e nunca ativa em CI/agente sem esse opt-in explícito);
  PROMPT_BUILDER_TELEMETRY_URL é o destino do upload.
  PROMPT_BUILDER_NO_ATTRIBUTION=on suprime HTTP-Referer e X-Title — headers de
  atribuição que o gateway envia ao OpenRouter (dado partilhado com terceiro).`,
  jev: `  jev validate <arq> [--strict] [--spec <cfg>]
           lint offline de jev-config@1, DecisionsRequest cru ou dataset (sem key, sem custo)
  jev example [--kind triagem|guardrail|roteamento] [--mode eval|compare|train] [-o <arq>]
  jev models               catálogo de modelos de decisão (público; preço de entrada)
  jev import --from <csv|jsonl|json> [--spec <cfg>] [-o <casos.jsonl>]
  jev run -c <arq> --budget <usd|none> [--mode eval|compare|train] [--repeats N]
          [--dry-run] [--emit-cells] [--allow-pii] [--allow-concurrent] [--strict]
  jev eval -c <arq> | jev compare -c <arq> | jev train -c <arq>
           atalhos de \`run\` que fixam --mode (mesmas flags)
  jev list [--kind run|session] (teto 50; --all/--limit N) | show <id> [--full]
  jev report <id> [--json | --markdown <arq>] [--requests-per-month N]
  jev export <id> [--request] [-o <arq>] [--override "<motivo>"]
           handoff da definição campeã (DecisionsRequest + política por pergunta);
           holdout regredido BLOQUEIA (exit 10) salvo --override
  jev techniques           operadores do modo + as 19 técnicas de prompt LLM no Jev
  Alias: \`decisions\`. Exit 6 = inconclusiva; 7 = parcial por orçamento; 3 = config,
  lint, dataset, recusa LGPD/PII ou definição recusada pela API (400).`,
};

export function renderCommandHelp(cmd: string): string {
  const resumo = RESUMO[cmd] ?? '';
  const uso = USO[cmd] ?? `  prompt-builder ${cmd}`;
  return `prompt-builder ${cmd}${resumo ? ` — ${resumo}` : ''}

USO
${uso}

${HELP_TAIL}`;
}
