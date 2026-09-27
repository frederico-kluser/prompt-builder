#!/usr/bin/env node
// prompt-builder — entrypoint do CLI.
//
// Escrito para ser dirigido por um AGENTE de programacao: sem prompt
// interativo, `--json` em tudo, codigos de saida distintos e auto-documentacao
// versionada dentro do proprio pacote (`docs`).

import { pkgVersion } from '../paths.js';
import { configureGatewayFromEnv } from '../gatewayEnv.js';
import { CliError, EXIT, exitCodeForGatewayError, Output } from './output.js';
import { buildContext, parse } from './context.js';
import { cmdModels } from './commands/models.js';
import { cmdRun } from './commands/run.js';
import { cmdDocs, cmdInit, cmdSkill } from './commands/knowledge.js';
import { cmdMcp } from './commands/mcp.js';
import { cmdAgents } from './commands/agents.js';
import {
  cmdConfig,
  cmdDoctor,
  cmdEstimate,
  cmdKey,
  cmdLgpd,
  cmdRegistry,
  cmdRuns,
  cmdSessions,
  cmdTechniques,
} from './commands/misc.js';
import { cmdLibrary } from './commands/library.js';
import { cmdBaseline } from './commands/baseline.js';

const VERSION = pkgVersion();

const HELP = `prompt-builder ${VERSION} — benchmark de LLMs e evolução de system prompts.

USO
  prompt-builder <comando> [opções]

CONHECIMENTO (comece aqui)
  docs [tópico]            imprime a documentação embarcada nesta versão
  docs --list              todos os tópicos, com custo aproximado em tokens
  skill                    imprime o SKILL.md deste pacote
  init --agent <nome>      instala a skill em .claude/skills, .agents/skills, …

MODELOS
  models list [filtros]    lista o catálogo do OpenRouter
  models show <id>         o que aquele modelo aceita (think levels, temperatura)
  models export -o <arq>   exporta o catálogo com capacidades de ajuste
  models allowlist --check idade/contagem da allowlist LGPD por endpoint (sem key)

CUSTO
  estimate -c <arquivo>    estima o custo antes de gastar
  key check                valida a key e mostra o saldo
  key set --stdin          grava a key (leia da entrada padrão, nunca de argv)

RUNS
  compare --models a,b     compara modelos no mesmo desafio
  vary    --model <id>     testa variações de prompt num modelo
  train   --model <id>     treina um prompt ao longo de iterações
  <cmd> --config <arq>     usa um arena-config@1 (ver: docs config)
  <cmd> --dry-run          valida e estima SEM chamar nenhuma API

RESULTADOS
  runs list | show <id> | winner <id> [--prompt-only]
  runs reproduce <id>      config reconstruído + comando p/ re-rodar a run
  runs export <id> [-o <arq>]
                           artefato auto-contido (config, gabaritos, prompts, juiz)
  sessions list | show <id> | winner <id>
          [--prompt-only | --apply <arq> [--commit]]   handoff com backup + diff

BIBLIOTECA (dataset estável de cenários+gabaritos)
  library list | init | show | add | seed | verify | coverage | export | rm | drop
          veja \`prompt-builder library --help\`

OUTROS
  techniques · lgpd · config validate <arq> · config example · doctor
  registry validate [--file <arq>]   guarda de drift dos prompts de produção
  registry init [-o <arq>]           grava um registro-exemplo comentado
  baseline pin <runId> [-o <arq>]    pina juiz/gabarito/contrato de uma run (judge-baseline@1)
  baseline check [--file <arq>] [--config <arq>] [--catalog <models.json>]
                           gate de CI: sai 3 se juiz/gabarito mudou ou sumiu
                           sem re-baseline declarada (ver: docs lifecycle)
  baseline declare --reason "…" [--judge a,b] [--reference x]
  mcp                      servidor MCP por stdio (mesmo binário)

AGENTES (modo agente — mesmo motor, executor pi)
  agents doctor [--deep] [--container]   pré-voo do executor (canário real com --deep; valida Docker em --container)
  agents run --config <arq> --budget <usd|none> [--dry-run]
                           roda a arena de agentes até o fim
  agents show <runId>      record + execuções de agente
  agents list              varre <data-dir>/agent-runs
  agents logs <runId> --stage N --contestant <id>
          [--rep N] [--what dossier|diff|trajectory|events|session|stderr|oracle]
  agents replay <runId> --stage N --contestant <id> [--rep N]
                           imprime o comando EXATO (env redigido) p/ reproduzir
  agents gc [--older-than 30d] [--dry-run]
                           apaga artefatos de runs antigas (enche disco)

OPÇÕES GLOBAIS
  --budget <usd|none>      teto de gasto (OBRIGATÓRIO fora de um terminal)
  --json                   um objeto JSON no stdout
  --output-format ndjson   um evento JSON por linha (progresso ao vivo)
  --key <k>                key do OpenRouter (ou \$OPENROUTER_API_KEY)
  --data-dir <caminho>     onde gravar runs (padrão ~/.prompt-builder)
  --refresh-models         ignora o cache de catálogo (24h)
  --quiet · --verbose · --no-color · --help · --version

PARA AGENTES
  Toda saída estruturada vai para o STDOUT; progresso e avisos vão para o STDERR.
  Nunca chute um think level: \`models show <id> --json\` diz exatamente quais
  níveis o modelo aceita e o que vai no fio para cada um pedido.
  Comece por: prompt-builder docs quickstart

CÓDIGOS DE SAÍDA
  0 ok · 2 uso inválido · 3 config inválida · 4 auth · 5 sem crédito
  7 parcial (orçamento esgotado) · 8 rede · 130 interrompido
`;

/**
 * Dica de plugin para o Claude Code. Hoje ela e DESCARTADA em silencio (so vale
 * para marketplaces da Anthropic), mas e inofensiva, nao custa token — o Claude
 * Code remove a linha antes do modelo ver — e passa a funcionar sozinha se o
 * pacote for listado. Nao construa onboarding em cima dela.
 */
function emitClaudeHint(): void {
  if (process.env.CLAUDECODE === '1' || process.env.CLAUDE_CODE_CHILD_SESSION === '1') {
    process.stderr.write(
      '<claude-code-hint v="1" type="plugin" value="prompt-builder@claude-plugins-official" />\n',
    );
  }
}

async function dispatch(cmd: string | undefined, argv: string[]): Promise<number> {
  switch (cmd) {
    case 'docs':
      return cmdDocs(argv);
    case 'skill':
      return cmdSkill(argv);
    case 'init':
      return cmdInit(argv);
    case 'models':
      return cmdModels(argv);
    case 'estimate':
      return cmdEstimate(argv);
    case 'key':
      return cmdKey(argv);
    case 'compare':
      return cmdRun('compare', argv);
    case 'vary':
      return cmdRun('variation', argv);
    case 'train':
      return cmdRun('training', argv);
    case 'runs':
      return cmdRuns(argv);
    case 'sessions':
      return cmdSessions(argv);
    case 'library':
      return cmdLibrary(argv);
    case 'techniques':
      return cmdTechniques(argv);
    case 'lgpd':
      return cmdLgpd(argv);
    case 'config':
      return cmdConfig(argv);
    case 'registry':
      return cmdRegistry(argv);
    case 'baseline':
      return cmdBaseline(argv);
    case 'doctor':
      return cmdDoctor(argv);
    case 'mcp':
      return cmdMcp(argv);
    case 'agents':
      return cmdAgents(argv);
    default:
      throw new CliError(
        `Comando desconhecido: "${cmd}". Veja \`prompt-builder --help\`.`,
        EXIT.USAGE,
      );
  }
}

async function main(): Promise<void> {
  // Gateway de LLM a partir do ambiente (OPENROUTER_*), antes de qualquer
  // comando tocar a rede — o gateway em si nao le o processo (IMPL-021).
  configureGatewayFromEnv();
  const argv = process.argv.slice(2);
  const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : undefined;
  const rest = cmd ? argv.slice(1) : argv;

  // `--version` ANTES do help: sem comando, `!cmd` e verdadeiro e um
  // `prompt-builder --version` cairia no help.
  if (argv.includes('--version')) {
    process.stdout.write(`${VERSION}\n`);
    process.exit(EXIT.OK);
  }
  if (!cmd || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    emitClaudeHint();
    process.exit(EXIT.OK);
  }

  try {
    process.exitCode = await dispatch(cmd, rest);
  } catch (err) {
    // O formato de saida so e conhecido depois do parse; num erro de parse
    // caimos no texto simples, que e o que um humano e um agente conseguem ler.
    let out: Output;
    try {
      out = buildContext(parse(rest, {})).out;
    } catch {
      out = new Output({ format: 'text' });
    }
    // Falha do gateway que escapou do comando: 401 => auth (4), sem credito =>
    // 5, 403 de moderacao => 1 (bloqueio, NUNCA auth) — IMPL-010.
    const cliErr =
      err instanceof CliError
        ? err
        : new CliError((err as Error).message, exitCodeForGatewayError(err) ?? EXIT.ERROR);
    out.fail(cmd ?? '?', cliErr);
    if (cliErr.code === EXIT.USAGE) emitClaudeHint();
    process.exitCode = cliErr.code;
  }
}

void main();
