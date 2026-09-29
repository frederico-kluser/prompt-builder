#!/usr/bin/env node
// prompt-builder — entrypoint do CLI.
//
// Escrito para ser dirigido por um AGENTE de programacao: sem prompt
// interativo, `--json` em tudo, codigos de saida distintos e auto-documentacao
// versionada dentro do proprio pacote (`docs`).

import { pkgVersion } from '../paths.js';
import { configureGatewayFromEnv } from '../gatewayEnv.js';
import { CliError, EXIT, Output, failAndExit } from './output.js';
import { closestMatch, commandLabel, sniffOutputFormat, sniffPretty } from './context.js';
import { COMMANDS, HELP_TAIL, renderCommandHelp } from './help.js';
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
import { cmdLimits } from './commands/limits.js';

const VERSION = pkgVersion();

const HELP = `prompt-builder ${VERSION} — benchmark de LLMs e evolução de system prompts.

USO
  prompt-builder <comando> [opções]

CONHECIMENTO (comece aqui)
  docs [tópico]            imprime a documentação embarcada nesta versão
  docs --list              todos os tópicos, com custo aproximado em tokens
  skill                    imprime o SKILL.md deste pacote
  init --agent <nome>      instala a skill em .claude/skills, .agents/skills, …

MODELOS (catálogo público: não exigem key)
  models list [filtros]    lista o catálogo do OpenRouter
  models show <id>         o que aquele modelo aceita (think levels, temperatura)
  models export -o <arq>   exporta o catálogo com capacidades de ajuste
  models allowlist --check idade/contagem da allowlist LGPD por endpoint (sem key)

CUSTO
  estimate -c <arquivo>    estima o custo antes de gastar (sem key)
  key check                valida a key e mostra o saldo
  key set --stdin          grava a key (leia da entrada padrão, nunca de argv)
  limits show              teto diário da máquina (UTC) e quem gastou hoje
  limits set --daily <usd|none>
                           teto diário somando TODOS os processos (padrão US$ 20)

RUNS
  compare --models a,b     compara modelos no mesmo desafio
  vary    --model <id>     testa variações de prompt num modelo
  train   --model <id>     treina um prompt ao longo de iterações
  <cmd> --config <arq>     usa um arena-config@1 (ver: docs config)
  <cmd> --dry-run          pré-voo inteiro SEM gastar: recusa com o MESMO
                           error.code/exit da run real (wouldRefuse/requires)
  <cmd> --idempotency-key <k>
                           repetir a MESMA key reusa a run (espera ou devolve
                           o resultado dela) em vez de gastar de novo
  <cmd> --allow-concurrent réplica intencional: sem o lock da config
                           (2º processo com a mesma config → run.locked)
  <cmd> --detach           roda num processo destacado (NDJSON em arquivo) e sai

RESULTADOS
  runs list | show <id> | winner <id> [--prompt-only]
  runs status <id>         estado de um job (--detach), run ou sessão
  runs wait <id> [--timeout <s>]
                           espera o fim (padrão 600 s; exit 9 se esgotar)
  runs cancel <id>         parada graciosa: record 'aborted' com o parcial
  runs reproduce <id>      config reconstruído + comando p/ re-rodar a run
  runs export <id> [-o <arq>]
                           artefato auto-contido (config, gabaritos, prompts, juiz)
  sessions list | show <id> | winner <id>
          [--prompt-only | --apply <arq> [--commit] [--override "<motivo>"]]
                           handoff com backup + diff; holdout regredido
                           BLOQUEIA (exit 10) salvo --override com motivo
                           (gravado em <data-dir>/handoffs.jsonl + trailer)
  sessions report <id> [--html <arq>] [--calls-per-month N] [--annotate]
                           relatório de CICLOS: quanto melhorou (original ×
                           campeão) e quanto a mudança muda o custo por chamada

BIBLIOTECA (dataset estável de cenários+gabaritos)
  library list | init | show | add | seed | verify | coverage | export | rm | drop
          veja \`prompt-builder library --help\`

OUTROS
  techniques · lgpd · config validate <arq> · config example
  doctor                   key (exit 4 se ausente/recusada), limite da key,
                           teto diário e runs ativas
  registry validate [--file <arq>]   guarda de drift dos prompts de produção
  registry init [-o <arq>]           grava um registro-exemplo comentado
  baseline pin <runId> [-o <arq>]    pina juiz/gabarito/contrato de uma run (judge-baseline@1)
  baseline check [--file <arq>] [--config <arq>] [--catalog <models.json>]
                           gate de CI: sai 3 se juiz/gabarito mudou ou sumiu
                           sem re-baseline declarada (ver: docs lifecycle)
  baseline declare --reason "…" [--judge a,b] [--reference x]
  mcp                      servidor MCP por stdio (mesmo binário)

AGENTES (modo agente — mesmo motor, executor pi)
  agents doctor [--deep] [--container] [--config <arq>]
                           pré-voo do executor (canário real com --deep; valida Docker/sandbox em
                           --container; --config mede a imagem/runtime daquela run)
  agents run --config <arq> --budget <usd|none> [--dry-run] [--allow-concurrent]
                           roda a arena de agentes até o fim (mesmo teto
                           diário e lock por config dos comandos de run)
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
  --json                   um objeto JSON no stdout (compacto; --pretty formata)
  --output-format ndjson   um evento JSON por linha (progresso ao vivo)
  --key <k>                key do OpenRouter (ou \$OPENROUTER_API_KEY)
  --data-dir <caminho>     onde gravar runs (padrão ~/.prompt-builder)
  --refresh-models         ignora o cache de catálogo (24h)
  --quiet · --verbose · --no-color · --pretty · --help · --version

  \`<comando> --help\` mostra o help daquele comando — todos terminam com a
  tabela de códigos de saída (IMPL-092).
${HELP_TAIL}`;

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

/** Comandos do `dispatch` — a lista canônica é `COMMANDS` (src/cli/help.ts). */

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
    case 'limits':
      return cmdLimits(argv);
    case 'mcp':
      return cmdMcp(argv);
    case 'agents':
      return cmdAgents(argv);
    default: {
      const sugestao = cmd ? closestMatch(cmd, COMMANDS) : undefined;
      throw new CliError(
        `Comando desconhecido: "${cmd}".`,
        EXIT.USAGE,
        { command: cmd ?? null, suggestion: sugestao ?? null, commands: COMMANDS },
        {
          code: 'usage.unknown_command',
          hint:
            (sugestao ? `Você quis dizer \`prompt-builder ${sugestao}\`? ` : '') +
            'A lista de comandos está em `prompt-builder --help` (e em details.commands).',
        },
      );
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : undefined;
  const rest = cmd ? argv.slice(1) : argv;

  // IMPL-028: o formato de saida e fixado AQUI, por varredura do argv, ANTES de
  // qualquer outra coisa. Antes ele so era descoberto depois do parse — e um
  // erro DE parse (flag desconhecida) caia no texto: sob --json o stdout saia
  // com 0 bytes e o consumidor-maquina nao via nada (Furo 1, R-12).
  const out = new Output({ format: sniffOutputFormat(argv), pretty: sniffPretty(argv) });
  const label = commandLabel(argv);
  // Excecao sem dono (callback, rejeicao solta) tambem termina no envelope —
  // o NDJSON nunca fica sem a linha `result`.
  process.on('uncaughtException', (err) => failAndExit(out, label, err));
  process.on('unhandledRejection', (err) => failAndExit(out, label, err));

  try {
    // Gateway de LLM a partir do ambiente (OPENROUTER_*), antes de qualquer
    // comando tocar a rede — o gateway em si nao le o processo (IMPL-021).
    // Dentro do try: nem a configuracao escapa do envelope.
    configureGatewayFromEnv();

    // `--version` ANTES do help: sem comando, `!cmd` e verdadeiro e um
    // `prompt-builder --version` cairia no help.
    if (argv.includes('--version')) {
      process.stdout.write(`${VERSION}\n`);
      process.exit(EXIT.OK);
    }
    if (!cmd || argv.includes('--help') || argv.includes('-h')) {
      // IMPL-092: `--help` COM comando = help DO comando (todo help termina com
      // a tabela de códigos de saída); sem comando (ou comando desconhecido) =
      // visão geral, como sempre.
      const texto =
        cmd && (COMMANDS as readonly string[]).includes(cmd) ? renderCommandHelp(cmd) : HELP;
      process.stdout.write(texto);
      emitClaudeHint();
      process.exit(EXIT.OK);
    }

    process.exitCode = await dispatch(cmd, rest);
  } catch (err) {
    // O UNICO ponto de renderizacao de erro do CLI: qualquer coisa lancada vira
    // o envelope {ok:false, command, error:{code,kind,message,hint,details}}.
    const cliErr = out.fail(label, err);
    if (cliErr.code === EXIT.USAGE) emitClaudeHint();
    process.exitCode = cliErr.code;
  }
}

void main();
