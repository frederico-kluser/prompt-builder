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
  'doctor',
  'limits',
  'mcp',
  'agents',
  'telemetry',
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
  doctor: 'diagnostica key, limites e o ambiente do modo agente',
  limits: 'teto diário de gasto da máquina',
  mcp: 'servidor MCP por stdio (mesmo binário)',
  agents: 'modo agente: arena de agentes com executor pi',
  telemetry: 'telemetria opt-in e os headers de atribuição enviados ao OpenRouter',
};

/**
 * Uso de cada comando. Listas com `--limit/--all` (IMPL-092): teto default de
 * 50 itens, `--all` devolve a lista inteira e o truncamento avisa no stderr.
 */
const USO: Record<string, string> = {
  docs: `  docs [tópico]            imprime um tópico da documentação
  docs --list              todos os tópicos, com custo aproximado em tokens`,
  skill: `  skill                    imprime o SKILL.md deste pacote`,
  init: `  init --agent <nome>      instala a skill em .claude/skills, .agents/skills, …`,
  models: `  models list [filtros]    lista o catálogo (teto 50; --all/--limit N)
  models show <id>         o que aquele modelo aceita (think levels, temperatura)
  models export -o <arq>   exporta o catálogo com capacidades de ajuste
  models allowlist --check idade/contagem da allowlist LGPD por endpoint (sem key)

  Filtros de list: --search --provider --effort --supports --reasoning
  --no-reasoning --min-context --max-prompt-price --max-completion-price
  --free --lgpd-area --expiring --format table|json|ndjson|csv|ids
  Listas: --limit <N> (default 50) · --all (lista inteira)`,
  estimate: `  estimate -c <arquivo>    estima o custo antes de gastar (sem key)
  O arquivo pode ser arena-config@1 ou RunConfig cru.`,
  key: `  key check                valida a key e mostra o saldo
  key set --stdin          grava a key (leia da entrada padrão, nunca de argv)
  key path | rm            onde está a key gravada | remove`,
  compare: `  compare --models a,b     compara modelos no mesmo desafio
  compare --config <arq>   usa um arena-config@1 (ver: docs config)
  Comuns: --theme --stages --judge --budget <usd|none> --dry-run
  --output-format ndjson --idempotency-key <k> --allow-concurrent --detach
  --languages pt-BR,en     idiomas do datagen (opt-in; sem a flag, 100% pt-BR —
                           cenário fora da política vira aviso no record)`,
  vary: `  vary --model <id>        testa variações de prompt num modelo
  vary --config <arq>      usa um arena-config@1 (ver: docs config)
  Comuns: --theme --stages --judge --techniques --budget --dry-run --detach
  --languages pt-BR,en     idiomas do datagen (opt-in; sem a flag, 100% pt-BR)`,
  train: `  train --model <id>       treina um prompt ao longo de iterações
  train --config <arq>     usa um arena-config@1 (ver: docs config)
  Comuns: --iterations --holdout-ratio --budget --dry-run --detach
  --languages pt-BR,en     idiomas do datagen (opt-in; sem a flag, 100% pt-BR)
  --stages N               default 10 no treino: com poucos cenários o gate não
                           consegue promover (o pré-voo avisa)
  --auditable              juiz e gabarito com provedor travado (sem fallback)
  Campeão só é DECLARADO com ≥ N itens curados (âncora humana: gabarito/rótulo
  escrito por gente — gabarito gerado por IA não conta). N = training.minCuratedItems,
  default 20 — proposta SEM fonte (calibrar). Abaixo disso o resultado traz
  championDeclaration.declared=false e o prompt sai como melhor do bootstrap.`,
  runs: `  runs list [--status X]   lista runs (teto 50; --all/--limit N)
  runs show <id>           record completo + diagnóstico do juiz
  runs winner <id> [--prompt-only]
  runs reproduce <id>      config reconstruído + comando p/ re-rodar
  runs reproduce <id> --replay  re-pontua as respostas gravadas a US$ 0 (exit 3 se divergir)
  runs export <id> [-o <arq>]
  runs status|wait|cancel <id>  job (--detach), run ou sessão`,
  sessions: `  sessions list            lista sessões (teto 50; --all/--limit N)
  sessions show <id>
  sessions winner <id> [--prompt-only | --apply <arq> [--commit] [--override "<motivo>"]]
           handoff com backup + diff; holdout regredido BLOQUEIA (exit 10)
           salvo --override com motivo (gravado na auditoria + trailer)
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
               [--budget <usd|none>] [--languages pt-BR,en]
                                     gera N itens via datagen + gabarito por item
                                     (tier, dimensionTags, persona… preservados);
                                     sem --languages, 100% pt-BR
  library seed --profile <id> --generate <N> --tier adversarial
               --base-prompt-file <arq> --model <id> [--budget <usd|none>]
                                     cenários adversariais condicionados ao prompt-
                                     base: 6 categorias, ≥ 4 cada (N mínimo 24),
                                     single-turn (ASR@1 = limite inferior); cobertura
                                     por categoria e custo por cenário no resultado
  library verify --profile <id>      itens SEM gabarito ou rótulo curto sem labelSet
                                     (recusados no evolve; exit 3)
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
  config: `  config validate <arq>    valida arena-config@1 ou RunConfig cru (exit 3 se inválido)
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
  agents show <runId> | list (teto 50; --all/--limit N) | logs | replay | gc`,
  telemetry: `  telemetry [status]       estado do opt-in e da atribuição (padrão)
  telemetry schema         schema PÚBLICO do payload + allowlist de eventos
  telemetry counters       contadores locais (sem id de usuário/máquina; ganchos de
                           funil ainda não ligados — hooksWired: false, nada é contado)

  Ambiente: PROMPT_BUILDER_TELEMETRY=on liga a telemetria (DESLIGADA por
  padrão, e nunca ativa em CI/agente sem esse opt-in explícito);
  PROMPT_BUILDER_TELEMETRY_URL é o destino do upload.
  PROMPT_BUILDER_NO_ATTRIBUTION=on suprime HTTP-Referer e X-Title — headers de
  atribuição que o gateway envia ao OpenRouter (dado partilhado com terceiro).`,
};

export function renderCommandHelp(cmd: string): string {
  const resumo = RESUMO[cmd] ?? '';
  const uso = USO[cmd] ?? `  prompt-builder ${cmd}`;
  return `prompt-builder ${cmd}${resumo ? ` — ${resumo}` : ''}

USO
${uso}

${HELP_TAIL}`;
}
