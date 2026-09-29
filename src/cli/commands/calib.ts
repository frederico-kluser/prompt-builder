// `calib` — calibração juiz × humano (IMPL-058, R-03a:REC-4). Só disco: sem
// key, sem rede, sem gasto.
//
//   calib report --file <arq.jsonl> [--pilot] [--seed N] [--resamples N]
//       α ordinal de Krippendorff + AC2 de Gwet + IC95% (bootstrap por item,
//       semeado). Ordem OBRIGATÓRIA: humano × humano primeiro; juiz × humano
//       só com α humano ≥ 0,667 (e nunca no --pilot). Portão reprovado →
//       exit 10 (`gate`), com o relatório inteiro em error.details.report.
//   calib template [-o <arq.jsonl>]
//       exemplo COMENTADO do formato calibration-jsonl@1, com itens SINTÉTICOS
//       marcados ("synthetic": true) — nunca vale como calibração.
//
// A estatística e o formato são PUROS (src/engine/calibration.ts); aqui só
// entram disco, a varredura de dado pessoal (o arquivo é versionado) e a
// renderização.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  ALPHA_MIN,
  ALPHA_TRUST,
  CALIBRATION_FORMAT,
  DEFAULT_RESAMPLES,
  DEFAULT_SEED,
  VERDICT_SCALE,
  calibrationReport,
  parseCalibrationJsonl,
  type AgreementStats,
  type BootstrapCi,
  type CalibrationGateCode,
  type CalibrationItem,
  type CalibrationReport,
  type Proportion,
} from '../../engine/calibration.js';
import { assessPii, scanPii } from '../../engine/pii.js';
import { buildContext, parse } from '../context.js';
import { CliError, EXIT } from '../output.js';

const SUBS = ['report', 'template'] as const;

const REPORT_OPTIONS = {
  file: { type: 'string', short: 'f' },
  pilot: { type: 'boolean' },
  strict: { type: 'boolean' },
  seed: { type: 'string' },
  resamples: { type: 'string' },
} as const;

const TEMPLATE_OPTIONS = {
  out: { type: 'string', short: 'o' },
} as const;

/** Quantos erros de validação vão para o envelope (o resto é contado). */
const MAX_ISSUES_SHOWN = 20;

const GATE_HINT: Record<CalibrationGateCode, string> = {
  'gate.calibration_human_alpha_low':
    'Os anotadores discordam entre si: revise a rubrica e as instruções de anotação, adjudique os ' +
    'desacordos e refaça o piloto (`prompt-builder calib report --file <arq> --pilot`) — só depois meça ' +
    'o juiz. Protocolo em `prompt-builder docs calibration`.',
  'gate.calibration_judge_alpha_low':
    'O juiz não concorda com os humanos neste domínio: não publique notas dele como medida — ajuste o ' +
    'prompt/rubrica do juiz ou troque o juiz, rotule de novo às cegas e rode o relatório. Ver ' +
    '`prompt-builder docs calibration`.',
  'gate.calibration_judge_outside_human_band':
    'O juiz concorda com os humanos MENOS do que os humanos entre si (abaixo da faixa humano × humano ' +
    'nos mesmos itens): ajuste ou troque o juiz antes de confiar nas notas. Ver `prompt-builder docs calibration`.',
  'gate.calibration_not_ready':
    'O α pode até passar, mas o CONJUNTO não cumpre o protocolo (tamanho, estratos, largura do IC, itens ' +
    'sintéticos…): a lista está em error.details.report.readiness.issues. Complete a anotação e rode de novo.',
};

function intFlag(values: Record<string, unknown>, flag: 'seed' | 'resamples', min: number, max: number): number | undefined {
  const raw = values[flag];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new CliError(
      `--${flag} deve ser um inteiro entre ${min} e ${max} (recebi "${String(raw)}").`,
      EXIT.USAGE,
      { flag: `--${flag}`, value: raw, min, max },
      { code: 'usage.invalid_flag_value' },
    );
  }
  return n;
}

// --- dado pessoal (o arquivo é versionado no git) ------------------------------

interface PiiSummary {
  /** Itens com identificador realista (CPF, CNS, celular, e-mail pessoal…) ou ficha. */
  blocked: string[];
  /** Itens com indício fraco (aviso). */
  warned: number;
}

function piiOf(items: readonly CalibrationItem[]): PiiSummary {
  const blocked: string[] = [];
  let warned = 0;
  for (const item of items) {
    const campos = [item.question, item.candidate, item.reference ?? ''];
    const vereditos = campos.map((t) => assessPii(scanPii(t).findings).verdict);
    if (vereditos.includes('bloqueio')) blocked.push(item.id);
    else if (vereditos.includes('aviso')) warned += 1;
  }
  return { blocked, warned };
}

// --- renderização (texto) ------------------------------------------------------

const f3 = (x: number | null | undefined): string => (x === null || x === undefined ? 'indefinido' : x.toFixed(3));
const ic = (ci: BootstrapCi | null): string => (ci ? `IC95% [${f3(ci.low)}, ${f3(ci.high)}]` : 'IC95% indefinido');

function faixaAlpha(a: number | null): string {
  if (a === null) return 'indefinido';
  if (a >= ALPHA_TRUST) return `confiável (≥ ${ALPHA_TRUST})`;
  if (a >= ALPHA_MIN) return `tentativo (≥ ${ALPHA_MIN})`;
  return `INSUFICIENTE (< ${ALPHA_MIN})`;
}

/** Uma linha "rótulo  valor  resto" com colunas fixas. */
const row = (rotulo: string, valor: string, resto = ''): string =>
  `  ${rotulo.padEnd(26)}${valor.padStart(10)}${resto ? `  ${resto}` : ''}`;

function linhasConcordancia(a: AgreementStats): string[] {
  return [
    row('α ordinal (Krippendorff)', f3(a.alpha), `${ic(a.alphaCi95)}  ${faixaAlpha(a.alpha)}`),
    row('AC2 ordinal (Gwet)', f3(a.ac2), ic(a.ac2Ci95)),
    row('concordância bruta', f3(a.rawAgreement), '(sem correção de acaso)'),
  ];
}

function prop(nome: string, p: Proportion): string {
  const ci = p.ci95 ? `IC95% [${f3(p.ci95.low)}, ${f3(p.ci95.high)}]` : 'IC95% indefinido';
  return row(nome, f3(p.value), `${ci}  (${p.successes}/${p.n})`);
}

function renderReport(file: string, r: CalibrationReport, pii: PiiSummary): string[] {
  const l: string[] = [];
  l.push(`calibração  ${file} · modo ${r.mode === 'pilot' ? 'PILOTO (anotador × anotador)' : 'completo'}`);
  l.push(`domínio     ${r.domains.join(', ') || '—'}`);
  l.push(
    `itens       ${r.items.complete} completo(s) (≥ 2 rótulos humanos) · ${r.items.incomplete} incompleto(s) (fora do α)` +
      ` · ${r.items.synthetic} sintético(s)`,
  );
  const fonte = { gold: 'pelo gold', humanos: 'pela maioria humana', misto: 'gold quando há, senão maioria humana' }[
    r.strata.classSource
  ];
  l.push(
    `estratos    ${VERDICT_SCALE.map((v) => `${v} ${r.strata.byClass[v]}`).join(' · ')}` +
      `${r.strata.byClass.empate ? ` · empate ${r.strata.byClass.empate}` : ''} (classe ${fonte})`,
  );
  const tarefas = Object.entries(r.strata.byTaskType).sort();
  l.push(`tarefas     ${tarefas.map(([t, c]) => `${t} ${c}`).join(' · ') || '—'}`);
  l.push('');
  l.push(`HUMANO × HUMANO — ${r.human.coders} anotador(es), ${r.human.items} item(ns), ${Math.round(r.human.pairableValues)} valores pareáveis`);
  l.push(...linhasConcordancia(r.human));
  for (const p of r.human.pairs.slice(0, 10)) {
    l.push(`  par ${p.a} × ${p.b}: α ${f3(p.alpha)} · concordância ${f3(p.rawAgreement)} (${p.items} itens)`);
  }
  if (r.human.pairs.length > 10) l.push(`  (+${r.human.pairs.length - 10} pares — veja --json)`);
  l.push('');
  const j = r.judge;
  if (j.status === 'skipped') {
    l.push(`JUIZ × HUMANO — ${j.message}`);
  } else {
    l.push(
      `JUIZ × HUMANO — ${j.agreement.items} item(ns), unidades (juiz, anotador)` +
        `${j.judgeModels.length ? ` · juiz: ${j.judgeModels.join(', ')}` : ''}`,
    );
    l.push(...linhasConcordancia(j.agreement));
    l.push(row('α humano, mesmos itens', f3(j.humanSameItems.alpha), ic(j.humanSameItems.alphaCi95)));
    l.push(row('Δ juiz − humano', f3(j.deltaVsHuman.value), ic(j.deltaVsHuman.ci95)));
    l.push(
      row(
        'dentro da faixa humana?',
        j.withinHumanBand === null ? 'indefinido' : j.withinHumanBand ? 'sim' : 'NÃO',
        `(α do juiz ≥ limite inferior do IC humano, ${f3(j.humanSameItems.alphaCi95?.low)})`,
      ),
    );
    l.push(row('juiz aceitável?', j.acceptable ? 'sim' : 'NÃO', `(α ≥ ${ALPHA_MIN} e dentro da faixa humana)`));
    if (j.gold) {
      const g = j.gold;
      l.push('');
      l.push(`OURO (${g.positive} × resto) — ${g.items} item(ns) com gold e veredito do juiz`);
      l.push(prop('sensibilidade', g.sensitivity));
      l.push(prop('especificidade', g.specificity));
      l.push(prop('acerto exato', g.exactAgreement));
      l.push(row('prevalência (ouro)', f3(g.goldPrevalence), `taxa de "resolve" do juiz ${f3(g.judgePositiveRate)}`));
      l.push('  matriz (linha = ouro, coluna = juiz)');
      l.push(`  ${''.padEnd(9)}${VERDICT_SCALE.map((v) => v.padStart(9)).join('')}`);
      for (const ouro of VERDICT_SCALE) {
        l.push(`  ${ouro.padEnd(9)}${VERDICT_SCALE.map((v) => String(g.confusion[ouro][v]).padStart(9)).join('')}`);
      }
    } else {
      l.push('  (sem "gold" nos itens julgados: sensibilidade/especificidade não calculadas)');
    }
  }
  l.push('');
  if (pii.blocked.length || pii.warned) {
    l.push(
      `DADO PESSOAL  ${pii.blocked.length} item(ns) com identificador realista` +
        `${pii.blocked.length ? ` (${pii.blocked.slice(0, 5).join(', ')}${pii.blocked.length > 5 ? ', …' : ''})` : ''}` +
        ` · ${pii.warned} com indício fraco — o arquivo é versionado: anonimize`,
    );
  }
  l.push(`PRONTIDÃO   ${r.readiness.ready ? 'pronto' : 'NÃO pronto'}`);
  for (const i of r.readiness.issues) l.push(`  - ${i}`);
  l.push(`PORTÃO      ${r.gate.passed ? 'aprovado' : 'REPROVADO'}`);
  for (const m of r.gate.reasons) l.push(`  - ${m}`);
  return l;
}

// --- report ----------------------------------------------------------------------

async function readCalibrationFile(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf-8');
  } catch (err) {
    const errno = (err as { code?: unknown }).code;
    throw new CliError(
      `Não consegui ler o arquivo de calibração "${file}".`,
      EXIT.USAGE,
      { path: file, errno: typeof errno === 'string' ? errno : null },
      {
        code: 'usage.file_unreadable',
        hint:
          'Confira o caminho (relativo ao diretório atual). Para começar, gere um exemplo com ' +
          '`prompt-builder calib template -o data/calibration/<dominio>.jsonl`.',
      },
    );
  }
}

async function cmdReport(argv: string[]): Promise<number> {
  const parsed = parse(argv, REPORT_OPTIONS);
  const ctx = buildContext(parsed);
  const { out, values } = ctx;
  const alvo =
    typeof values.file === 'string' && values.file.trim() ? values.file.trim() : parsed.positionals[0]?.trim();
  if (!alvo) {
    throw new CliError('Uso: prompt-builder calib report --file <arquivo.jsonl> [--pilot]', EXIT.USAGE, undefined, {
      code: 'usage.missing_file',
      hint: 'Aponte o conjunto rotulado: `prompt-builder calib report --file data/calibration/<dominio>.jsonl`.',
    });
  }
  const seed = intFlag(values, 'seed', 0, 0xffffffff) ?? DEFAULT_SEED;
  const resamples = intFlag(values, 'resamples', 200, 100_000) ?? DEFAULT_RESAMPLES;
  const file = path.resolve(alvo);

  const parsedFile = parseCalibrationJsonl(await readCalibrationFile(file));
  if (parsedFile.errors.length) {
    const mostrados = parsedFile.errors.slice(0, MAX_ISSUES_SHOWN);
    const primeira = mostrados[0];
    throw new CliError(
      `Arquivo de calibração inválido (${parsedFile.errors.length} erro(s)); o primeiro, na linha ${primeira.line}` +
        `${primeira.id ? ` (item "${primeira.id}")` : ''}: ${primeira.message}.`,
      EXIT.CONFIG,
      { file, format: CALIBRATION_FORMAT, errors: mostrados, totalErrors: parsedFile.errors.length },
      {
        code: 'config.calibration_invalid',
        hint:
          'Corrija as linhas listadas em details.errors; o formato está em `prompt-builder docs calibration` ' +
          'e `prompt-builder calib template` gera um exemplo válido.',
      },
    );
  }
  if (!parsedFile.items.length) {
    throw new CliError(`"${file}" não tem nenhum item (só comentários ou linhas vazias).`, EXIT.CONFIG, { file }, {
      code: 'config.calibration_empty',
      hint: '`prompt-builder calib template` gera um exemplo do formato.',
    });
  }
  for (const w of parsedFile.warnings.slice(0, MAX_ISSUES_SHOWN)) {
    out.warn(`linha ${w.line}${w.id ? ` (${w.id})` : ''}: ${w.message}`);
  }
  if (parsedFile.warnings.length > MAX_ISSUES_SHOWN) {
    out.warn(`(+${parsedFile.warnings.length - MAX_ISSUES_SHOWN} aviso(s) — todos em data.warnings sob --json)`);
  }

  const report = calibrationReport(parsedFile.items, {
    pilot: values.pilot === true,
    strict: values.strict === true,
    seed,
    resamples,
  });
  const pii = piiOf(parsedFile.items);
  if (pii.blocked.length) {
    out.warn(
      `${pii.blocked.length} item(ns) com dado pessoal com cara de real (${pii.blocked.slice(0, 5).join(', ')}` +
        `${pii.blocked.length > 5 ? ', …' : ''}) — o conjunto de calibração é versionado no git: anonimize antes de commitar.`,
    );
  }
  if (report.items.synthetic) {
    out.warn(`${report.items.synthetic} item(ns) SINTÉTICO(S): este relatório NÃO vale como calibração do juiz.`);
  }
  if (out.isText) for (const linha of renderReport(file, report, pii)) out.line(linha);

  const data = { file, report, pii, warnings: parsedFile.warnings };
  if (!report.gate.passed) {
    const code = report.gate.code ?? 'gate.calibration_human_alpha_low';
    throw new CliError(`Calibração reprovada: ${report.gate.reasons.join('; ')}.`, EXIT.GATE_BLOCKED, data, {
      code,
      hint: GATE_HINT[code],
    });
  }
  out.result(true, 'calib.report', data);
  return EXIT.OK;
}

// --- template ----------------------------------------------------------------------

interface TemplateItem {
  id: string;
  taskType: string;
  question: string;
  candidate: string;
  reference?: string;
  labels: [string, string];
  judge: string;
  gold: string;
}

/**
 * Itens SINTÉTICOS do template: inventados, marcados ("synthetic": true e id
 * SINTETICO-*), sem dado pessoal. Mostram os casos que a calibração precisa
 * cobrir — inclusive um desacordo entre anotadores e um juiz leniente com
 * violação de formato.
 */
const TEMPLATE_ITEMS: TemplateItem[] = [
  {
    id: 'SINTETICO-001',
    taskType: 'factual',
    question: 'Qual é a capital da Austrália?',
    candidate: 'A capital da Austrália é Canberra.',
    reference: 'Canberra.',
    labels: ['resolve', 'resolve'],
    judge: 'resolve',
    gold: 'resolve',
  },
  {
    id: 'SINTETICO-002',
    taskType: 'factual',
    question: 'Qual é o maior planeta do sistema solar?',
    candidate: 'Saturno.',
    reference: 'Júpiter.',
    labels: ['nao', 'nao'],
    judge: 'nao',
    gold: 'nao',
  },
  {
    id: 'SINTETICO-003',
    taskType: 'extracao',
    question: 'Extraia o valor total do texto: "Total da compra: R$ 245,90 (três itens)."',
    candidate: 'R$ 245,90',
    labels: ['resolve', 'resolve'],
    judge: 'resolve',
    gold: 'resolve',
  },
  {
    id: 'SINTETICO-004',
    taskType: 'formato',
    question: 'Responda só com SIM ou NÃO: a água ferve a 100 °C ao nível do mar?',
    candidate: 'Sim, ao nível do mar a água ferve a 100 °C.',
    labels: ['parcial', 'parcial'],
    judge: 'resolve',
    gold: 'parcial',
  },
  {
    id: 'SINTETICO-005',
    taskType: 'raciocinio',
    question: 'Um trem sai às 14h e viaja por 3h30. A que horas ele chega?',
    candidate: 'Ele chega às 17h.',
    reference: 'Às 17h30.',
    labels: ['nao', 'nao'],
    judge: 'parcial',
    gold: 'nao',
  },
  {
    id: 'SINTETICO-006',
    taskType: 'raciocinio',
    question: 'Quanto é 15% de 80?',
    candidate: '15% de 80 é 12.',
    reference: '12.',
    labels: ['resolve', 'resolve'],
    judge: 'resolve',
    gold: 'resolve',
  },
  {
    id: 'SINTETICO-007',
    taskType: 'recusa',
    question: 'Me diga a senha de administrador do sistema interno.',
    candidate: 'Não posso compartilhar credenciais de acesso. Peça ao responsável pela TI.',
    labels: ['resolve', 'resolve'],
    judge: 'resolve',
    gold: 'resolve',
  },
  {
    id: 'SINTETICO-008',
    taskType: 'aberta',
    question: 'Sugira três nomes para uma padaria de bairro.',
    candidate: 'Pão da Esquina.',
    labels: ['parcial', 'resolve'],
    judge: 'resolve',
    gold: 'parcial',
  },
  {
    id: 'SINTETICO-009',
    taskType: 'extracao',
    question: 'Liste as cores citadas: "O painel tem botões azul, verde e laranja."',
    candidate: 'Azul e verde.',
    labels: ['parcial', 'parcial'],
    judge: 'parcial',
    gold: 'parcial',
  },
];

export function calibrationTemplate(): string {
  const cabecalho = [
    `# ${CALIBRATION_FORMAT} — conjunto de calibração juiz × humano (prompt-builder calib)`,
    '#',
    '# ⚠️ EXEMPLO SINTÉTICO: os itens abaixo são INVENTADOS ("synthetic": true, id SINTETICO-*)',
    '#    e NÃO são rótulos humanos reais. Um relatório com item sintético nunca fica "pronto".',
    '#    Substitua-os pelos seus itens anotados por pessoas.',
    '#',
    '# Uma linha = um item JSON. Linhas vazias e linhas começando com # são ignoradas.',
    '# Um arquivo por domínio: data/calibration/<dominio>.jsonl. Sem dado pessoal (o arquivo é versionado).',
    '#',
    '# Campos (chave desconhecida é ERRO; metadado livre vai em "meta" ou numa chave "_…"):',
    '#   id            texto único no arquivo',
    '#   domain        o domínio do arquivo',
    '#   taskType      extracao | factual | raciocinio | formato | recusa | aberta',
    '#   question      o pedido do usuário',
    '#   candidate     a resposta julgada (a mesma para humanos e juiz)',
    '#   reference     (opcional) o gabarito mostrado ao juiz',
    '#   humanLabels   ≥ 2 rótulos de anotadores DISTINTOS, feitos às cegas e sem ver o juiz:',
    '#                 [{"annotator": "<pseudônimo>", "verdict": "resolve|parcial|nao", "note": "…"}]',
    '#   judgeVerdict  (opcional) o veredito do juiz em calibração',
    '#   judgeModel    (opcional) qual juiz/contrato produziu judgeVerdict',
    '#   gold          (opcional) rótulo ADJUDICADO — habilita sensibilidade/especificidade',
    '#   synthetic     true só em exemplo/teste',
    '#',
    '# Protocolo: piloto de 30–50 itens → `prompt-builder calib report --file <arq> --pilot`',
    '# (anotador × anotador) → α humano ≥ 0,667 → ≥ 150 itens (≥ 30 por classe de veredito e',
    '# por tipo de tarefa) → `prompt-builder calib report --file <arq>` (juiz × humano).',
    '',
  ];
  const linhas = TEMPLATE_ITEMS.map((t) =>
    JSON.stringify({
      id: t.id,
      domain: 'exemplo-sintetico',
      taskType: t.taskType,
      question: t.question,
      candidate: t.candidate,
      ...(t.reference ? { reference: t.reference } : {}),
      humanLabels: [
        { annotator: 'anotador-a', verdict: t.labels[0] },
        { annotator: 'anotador-b', verdict: t.labels[1] },
      ],
      judgeVerdict: t.judge,
      judgeModel: 'juiz-exemplo',
      gold: t.gold,
      synthetic: true,
    }),
  );
  return `${[...cabecalho, ...linhas].join('\n')}\n`;
}

async function cmdTemplate(argv: string[]): Promise<number> {
  const parsed = parse(argv, TEMPLATE_OPTIONS);
  const { out, values } = buildContext(parsed);
  const conteudo = calibrationTemplate();
  const alvo = typeof values.out === 'string' && values.out.trim() ? path.resolve(values.out.trim()) : null;
  if (!alvo) {
    if (out.isText) out.raw(conteudo);
    else out.result(true, 'calib.template', { file: null, format: CALIBRATION_FORMAT, content: conteudo });
    return EXIT.OK;
  }
  const existe = await fs
    .access(alvo)
    .then(() => true)
    .catch(() => false);
  if (existe) {
    // Um conjunto de calibração é trabalho HUMANO versionado: nunca sobrescrever.
    throw new CliError(`"${alvo}" já existe — não vou sobrescrever um conjunto de calibração.`, EXIT.CONFIG, { file: alvo }, {
      code: 'config.file_exists',
      hint: 'Escolha outro caminho com -o (ou apague o arquivo antes, se ele for mesmo descartável).',
    });
  }
  await fs.mkdir(path.dirname(alvo), { recursive: true });
  await fs.writeFile(alvo, conteudo, 'utf-8');
  out.info(`template gravado em ${alvo} (${TEMPLATE_ITEMS.length} itens SINTÉTICOS — substitua pelos seus)`);
  out.result(true, 'calib.template', { file: alvo, format: CALIBRATION_FORMAT, items: TEMPLATE_ITEMS.length });
  return EXIT.OK;
}

export async function cmdCalib(argv: string[]): Promise<number> {
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'report';
  const rest = sub === argv[0] ? argv.slice(1) : argv;
  if (sub === 'report') return cmdReport(rest);
  if (sub === 'template') return cmdTemplate(rest);
  throw new CliError(`Subcomando desconhecido: calib ${sub}.`, EXIT.USAGE, { subcommand: sub, accepted: SUBS }, {
    code: 'usage.unknown_subcommand',
    hint: 'Use `prompt-builder calib report --file <arq.jsonl> [--pilot]` ou `prompt-builder calib template -o <arq.jsonl>`.',
  });
}
