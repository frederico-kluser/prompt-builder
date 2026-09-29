// ----------------------------------------------------------------------------
// Compilador `agentTask` → layout Harbor (IMPL-098 / R-14b:REC-1).
//
// Harbor (Terminal-Bench 2.0) é a referência de tarefa executável de agente:
// cada tarefa = `task.toml` (metadados/recursos/timeouts) + `instruction.md` +
// `environment/Dockerfile` + `tests/test.sh` + `solution/solve.sh`, com saída
// `reward.json` (score parcial nomeado). O produto NÃO amarra o runtime ao
// Harbor (DEC-6: API instável 0.6.x→0.22) — o compilador exporta o LAYOUT, e a
// versão compat fica PINADA em `HARBOR_VERSION` (bump manual, com revalidação).
//
// Regras:
// - perda de campos canônicos na compilação = 0: tudo o que o `AgentTaskSpec`
//   declara tem casa na árvore e volta em `readHarborTask` (leitura POR ARQUIVO,
//   sem API Python);
// - `tests/test.sh` pontua EXATAMENTE como o oráculo (`scoreChecks`):
//   Σ(ok·peso)/Σ(peso) dos F2P (ou P2P se não há F2P); P2P quebrado ⇒ 0;
// - `tests/` só chega ao workspace DEPOIS do agente (isolamento, IMPL-098); o
//   material do `testsDir` vai em `tests/files/` (com o `baseDir` da config) e
//   o `test.sh` o materializa na raiz do workspace antes dos checks — a mesma
//   semântica de `materializeTestsDir` na run local;
// - `solution/solve.sh` é a golden do Harbor ("golden solve must pass all tests").
// ----------------------------------------------------------------------------
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { splitCommandLine } from './workspace.js';
import { listTestsDirFiles, resolveTestsDir } from './taskValidate.js';
import type { AgentTaskCheck, AgentTaskSolution, AgentTaskSpec } from './types.js';

/**
 * Versão do layout Harbor compatível com o que emitimos — PINADA (R-14b:REC-1:
 * churn alto 0.6.x→0.22 em ~1 ano; bump manual, nunca automático).
 */
export const HARBOR_VERSION = '0.22.0';

/** Marcador do reward que `tests/test.sh` escreve. */
export const HARBOR_REWARD_FORMAT = 'prompt-builder-reward@1';

/** O `reward.json` que `tests/test.sh` produz (score parcial nomeado). */
export interface HarborReward {
  format: typeof HARBOR_REWARD_FORMAT;
  /** Score em [0,1] — igual ao `score` do oráculo local (tolerância 1e-9). */
  score: number;
  /** Por check (nome → 1.0/0.0) — score parcial nomeado, como o Harbor espera. */
  checks: Record<string, number>;
  f2p: { passed: number; total: number };
  p2p: { passed: number; total: number; broken: boolean };
}

export interface HarborCompileResult {
  /** Raiz da árvore Harbor gerada. */
  outDir: string;
  /** Arquivos escritos (relativos a `outDir`). */
  files: string[];
  /** O reward que a `solution` produziria — igual ao score local. */
  rewardSpec: HarborReward;
  /**
   * left#12: material do `testsDir` copiado para `tests/files/` (caminhos
   * relativos ao testsDir). `null` = tarefa sem testsDir OU compilada sem
   * `baseDir` (o testsDir fica só declarado no task.toml).
   */
  testsMaterial: string[] | null;
}

/** O que `readHarborTask` devolve: o `AgentTaskSpec` reconstruído + o enunciado. */
export interface HarborTaskRead {
  task: AgentTaskSpec;
  instruction: string;
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Valor TOML booleano: `true` (parse) ou `"true"` (string crua) — os dois já saíram. */
function asBool(v: unknown): boolean {
  return v === true || v === 'true';
}

function jsonEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** O `solve.sh` de uma solution por diff: aplica o patch embutido. */
function solveScriptFor(solution: AgentTaskSolution): { script: string; patch?: string } {
  if (solution.kind === 'script') return { script: solution.script };
  return {
    script: [
      '#!/bin/sh',
      '# Solução de referência (diff) — gerado por prompt-builder (IMPL-098).',
      'set -e',
      'cd "$(dirname "$0")/.."',
      'git apply --whitespace=nowarn "$(dirname "$0")/solution.diff"',
      '',
    ].join('\n'),
    patch: solution.diff,
  };
}

/**
 * Gera o `tests/test.sh` — checks EMBUTIDs (sem parser de JSON em shell) que
 * pontuam exatamente como `scoreChecks` e escrevem `reward.json` no cwd.
 * Os nomes/itens viajam por ENV (o `awk -v` interpretaria escapes do JSON).
 */
function testScriptFor(checks: AgentTaskCheck[], material: readonly string[] = []): string {
  const lines: string[] = [
    '#!/bin/sh',
    '# Gerado por prompt-builder (IMPL-098) — NÃO editar.',
    '# Pontua como o oráculo do produto (scoreChecks): Σ(ok·peso)/Σ(peso) dos F2P',
    '# (ou P2P se não há F2P); P2P quebrado ⇒ 0. Escreve ./reward.json.',
    'set -u',
  ];
  if (material.length === 0) {
    lines.push('cd "$(dirname "$0")/.."');
  } else {
    // left#12: o material do `testsDir` (em tests/files/) entra na RAIZ do
    // workspace AQUI — depois do agente, como `materializeTestsDir` faz na run
    // local (os checks o referenciam relativo à raiz). O que o agente deixou no
    // mesmo caminho é SUBSTITUÍDO (rm antes do cp: symlink plantado não
    // redireciona a escrita).
    lines.push(
      'TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"',
      'cd "$TESTS_DIR/.."',
      'materialize() {',
      '  rm -f -- "$1"',
      '  mkdir -p -- "$(dirname -- "$1")"',
      '  cp -- "$TESTS_DIR/files/$1" "$1"',
      '}',
      '# --- material do testsDir (chega DEPOIS do agente) ------------------------',
      ...material.map((rel) => `materialize ${shQuote(rel.split(path.sep).join('/'))}`),
      '',
    );
  }
  lines.push(
    'ITEMS=""',
    'NAMES=""',
    'run_check() {',
    '  kind="$1"; weight="$2"; expect="$3"; name="$4"; shift 4',
    '  "$@" >/dev/null 2>&1',
    '  code=$?',
    '  ok=0; [ "$code" -eq "$expect" ] && ok=1',
    '  ITEMS="$ITEMS $kind:$ok:$weight"',
    '  NAMES="$NAMES,\\"$name\\":$ok"',
    '}',
    '',
    '# --- checks (ordem canônica: verify[] e depois regression[]) --------------',
  );
  for (const c of checks) {
    const kind = c.kind ?? 'fail_to_pass';
    const weight = c.weight ?? 1;
    const expect = c.expectExit ?? 0;
    const name = jsonEscape(c.label ?? c.cmd);
    const argv = splitCommandLine(c.cmd).map(shQuote).join(' ');
    lines.push(`run_check ${shQuote(kind)} ${shQuote(String(weight))} ${shQuote(String(expect))} ${shQuote(name)} ${argv}`);
  }
  lines.push(
    '',
    '# --- score (a MESMA conta de src/agent/checkScore.ts) ---------------------',
    'REWARD_ITEMS="${ITEMS# }"',
    'REWARD_NAMES="${NAMES#,}"',
    'export REWARD_ITEMS REWARD_NAMES',
    `awk 'BEGIN{`,
    `  n = split(ENVIRON["REWARD_ITEMS"], arr, " ")`,
    `  f2pw=0; f2pok=0; f2pn=0; f2ppassed=0`,
    `  p2pw=0; p2pok=0; p2pn=0; p2ppassed=0; broken=0`,
    `  for (i=1;i<=n;i++) {`,
    `    split(arr[i], p, ":")`,
    `    kind=p[1]; ok=p[2]+0; w=p[3]+0`,
    `    if (kind=="pass_to_pass") { p2pn++; p2pw+=w; if(ok){ p2pok+=w; p2ppassed++ } else broken=1 }`,
    `    else { f2pn++; f2pw+=w; if(ok){ f2pok+=w; f2ppassed++ } }`,
    `  }`,
    `  if (broken) score=0`,
    `  else if (f2pw>0) score=f2pok/f2pw`,
    `  else if (p2pw>0) score=p2pok/p2pw`,
    `  else score=0`,
    `  printf "{\\"format\\":\\"prompt-builder-reward@1\\",\\"score\\":%.17g,\\"checks\\":{%s},\\"f2p\\":{\\"passed\\":%d,\\"total\\":%d},\\"p2p\\":{\\"passed\\":%d,\\"total\\":%d,\\"broken\\":%s}}\\n", score, ENVIRON["REWARD_NAMES"], f2ppassed, f2pn, p2ppassed, p2pn, (broken?"true":"false")`,
    `}' > reward.json`,
    'cat reward.json',
    'exit 0',
    '',
  );
  return lines.join('\n');
}

/**
 * Compila um `AgentTaskSpec` para a árvore Harbor. Pura quanto a semântica (o
 * I/O é só escrita dos arquivos). Campos canônicos ficam TODOS na árvore.
 */
export function compileAgentTaskToHarbor(
  task: AgentTaskSpec,
  opts: {
    outDir: string;
    instruction: string;
    name?: string;
    /**
     * left#12: diretório da CONFIGURAÇÃO — base do `testsDir` relativo. Com
     * ele, o material do `testsDir` é copiado para `tests/files/` e o
     * `tests/test.sh` o materializa na raiz do workspace antes dos checks (a
     * mesma semântica da run local). Sem ele (chamador que só quer o layout),
     * `tests_dir` fica só declarado no `task.toml` e `testsMaterial` sai `null`.
     */
    baseDir?: string;
  },
): HarborCompileResult {
  const outDir = opts.outDir;
  const files: string[] = [];
  const write = (rel: string, content: string): void => {
    const abs = path.join(outDir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
    files.push(rel);
  };

  // left#12 — material do testsDir: mesma contenção (relativo, sem `..`, sem
  // symlink para fora) e o MESMO walk da run local/portão (`listTestsDirFiles`).
  // Diretório declarado que não existe é ERRO: compilar sem ele geraria um
  // test.sh que referencia arquivos ausentes (reward 0 calado).
  let material: string[] | null = null;
  if (task.testsDir !== undefined && opts.baseDir !== undefined) {
    const src = resolveTestsDir(task.testsDir, opts.baseDir);
    if (!existsSync(src) || !statSync(src).isDirectory()) {
      throw new Error(`testsDir "${task.testsDir}" não encontrado em ${path.resolve(opts.baseDir)}`);
    }
    material = listTestsDirFiles(src);
    for (const rel of material) {
      const alvo = path.join(outDir, 'tests', 'files', rel);
      mkdirSync(path.dirname(alvo), { recursive: true });
      // Bytes exatos (o material pode ser binário: fixture, snapshot).
      copyFileSync(path.join(src, rel), alvo);
      files.push(path.join('tests', 'files', rel).split(path.sep).join('/'));
    }
  }

  const checks = [...(task.verify ?? []), ...(task.regression ?? []).map((c) => ({ ...c, kind: 'pass_to_pass' as const }))];

  // --- instruction.md --------------------------------------------------------
  write('instruction.md', `${opts.instruction.trimEnd()}\n`);

  // --- task.toml (metadados + limites + proveniência + pin do Harbor) --------
  const md = task.metadata ?? {};
  const tomlLines = [
    '# Gerado por prompt-builder (IMPL-098) — layout Harbor.',
    `harbor_version = ${JSON.stringify(HARBOR_VERSION)}`,
    `name = ${JSON.stringify(opts.name ?? 'agent-task')}`,
  ];
  // `context_files`/`detectors` só saem quando DEFINIDOS — escrever o default
  // fabricava um campo no round-trip (`readHarborTask` devolvia `false`/`warn`
  // para um task que não os tinha) e a perda canônica deixava de ser 0.
  if (task.contextFiles !== undefined) {
    tomlLines.push(`context_files = ${task.contextFiles ? 'true' : 'false'}`);
  }
  if (task.detectors !== undefined) {
    tomlLines.push(`detectors = ${JSON.stringify(task.detectors)}`);
  }
  if (task.metadata) {
    tomlLines.push('[metadata]');
    if (md.origin !== undefined) tomlLines.push(`origin = ${JSON.stringify(md.origin)}`);
    if (md.commit !== undefined) tomlLines.push(`commit = ${JSON.stringify(md.commit)}`);
    if (md.difficulty !== undefined) tomlLines.push(`difficulty = ${JSON.stringify(md.difficulty)}`);
    if (md.canary !== undefined) tomlLines.push(`canary = ${md.canary ? 'true' : 'false'}`);
    if (md.tags !== undefined) tomlLines.push(`tags = [${md.tags.map((t) => JSON.stringify(t)).join(', ')}]`);
  }
  if (task.repo) {
    tomlLines.push('[repo]');
    tomlLines.push(`kind = ${JSON.stringify(task.repo.kind)}`);
    if (task.repo.url !== undefined) tomlLines.push(`url = ${JSON.stringify(task.repo.url)}`);
    if (task.repo.path !== undefined) tomlLines.push(`path = ${JSON.stringify(task.repo.path)}`);
    tomlLines.push(`ref = ${JSON.stringify(task.repo.ref)}`);
    if (task.repo.shallow !== undefined) tomlLines.push(`shallow = ${task.repo.shallow ? 'true' : 'false'}`);
  }
  if (task.setup?.length) {
    tomlLines.push('[setup]');
    task.setup.forEach((s, i) => {
      tomlLines.push(`cmd_${i} = ${JSON.stringify(s.cmd)}`);
      if (s.timeoutMs !== undefined) tomlLines.push(`timeout_ms_${i} = ${s.timeoutMs}`);
    });
  }
  if (task.limits) {
    tomlLines.push('[limits]');
    if (task.limits.maxTurns !== undefined) tomlLines.push(`max_turns = ${task.limits.maxTurns}`);
    if (task.limits.maxCostUsd !== undefined) tomlLines.push(`max_cost_usd = ${task.limits.maxCostUsd}`);
    if (task.limits.timeoutMs !== undefined) tomlLines.push(`timeout_ms = ${task.limits.timeoutMs}`);
    if (task.limits.maxOutputBytes !== undefined) tomlLines.push(`max_output_bytes = ${task.limits.maxOutputBytes}`);
    if (task.limits.maxDiffBytes !== undefined) tomlLines.push(`max_diff_bytes = ${task.limits.maxDiffBytes}`);
  }
  if (task.testsDir !== undefined) {
    tomlLines.push('[tests]');
    tomlLines.push(`tests_dir = ${JSON.stringify(task.testsDir)}`);
  }
  if (task.env) {
    tomlLines.push('[env]');
    tomlLines.push(`digest = ${JSON.stringify(task.env.digest)}`);
    if (task.env.path !== undefined) tomlLines.push(`path = ${JSON.stringify(task.env.path)}`);
  }
  write('task.toml', `${tomlLines.join('\n')}\n`);

  // --- environment/ ---------------------------------------------------------
  const dockerFrom = task.env ? task.env.digest : '# sem ambiente fixado (env.digest ausente)';
  write('environment/Dockerfile', `# Gerado por prompt-builder (IMPL-098).\nFROM ${dockerFrom}\n`);
  for (const f of task.files ?? []) {
    write(path.join('environment', 'files', f.path), f.content);
  }

  // --- solution/ ------------------------------------------------------------
  const solved = solveScriptFor(task.solution ?? { kind: 'script', script: '# sem solution\nexit 1' });
  write('solution/solve.sh', solved.script);
  if (solved.patch !== undefined) write('solution/solution.diff', solved.patch);

  // --- tests/ (test.sh + reward-spec.json; o material do testsDir já foi ---
  //     copiado para tests/files/ acima, quando há baseDir) --------------------
  write('tests/test.sh', testScriptFor(checks, material ?? []));
  // Campos guardados CRUS (JSON.stringify omite o `undefined`): é o que torna o
  // `readHarborTask` uma volta EXATA (perda canônica 0) — o `checks` fundido
  // fica como documentação/consumo externo (a ordem canônica do test.sh).
  write(
    'tests/reward-spec.json',
    `${JSON.stringify(
      {
        format: HARBOR_REWARD_FORMAT,
        checks,
        verify: task.verify,
        regression: task.regression,
        forbiddenPaths: task.forbiddenPaths,
        rebuild: task.rebuild,
        detectors: task.detectors,
        files: task.files,
        solution: task.solution,
      },
      null,
      2,
    )}\n`,
  );

  const rewardSpec: HarborReward = {
    format: HARBOR_REWARD_FORMAT,
    score: 1,
    checks: Object.fromEntries(checks.map((c) => [c.label ?? c.cmd, 1])),
    f2p: { passed: 0, total: checks.filter((c) => (c.kind ?? 'fail_to_pass') === 'fail_to_pass').length },
    p2p: { passed: 0, total: checks.filter((c) => c.kind === 'pass_to_pass').length, broken: false },
  };

  return { outDir, files, rewardSpec, testsMaterial: material };
}

/**
 * Lê um `reward.json` de artefato POR ARQUIVO (sem API Python) — a ponte com
 * `harbor traces`/datasets externos (R-14c:REC-8).
 */
export function readHarborReward(dir: string): HarborReward {
  const raw = JSON.parse(readFileSync(path.join(dir, 'reward.json'), 'utf8')) as HarborReward;
  if (raw.format !== HARBOR_REWARD_FORMAT) {
    throw new Error(`reward.json com formato inesperado: ${String(raw.format)}`);
  }
  return raw;
}

/**
 * Reconstrói o `AgentTaskSpec` a partir da árvore Harbor (leitura por arquivo).
 * É a prova da "perda 0": `readHarborTask(compile(task))` devolve os campos
 * canônicos idênticos aos do `task` original. Os campos vão e voltam CRUS
 * (`verify`/`regression`/`files`/… no reward-spec; repo/setup/limits/tests/env/
 * metadata no task.toml) — nada é normalizado no caminho de volta.
 */
export function readHarborTask(outDir: string): HarborTaskRead {
  const instruction = readFileSync(path.join(outDir, 'instruction.md'), 'utf8').replace(/\n$/, '');
  const spec = JSON.parse(readFileSync(path.join(outDir, 'tests', 'reward-spec.json'), 'utf8')) as {
    checks: AgentTaskCheck[];
    // Campos crus (árvores novas). Ausentes = árvore antiga → fallback do `checks`.
    verify?: AgentTaskCheck[];
    regression?: AgentTaskCheck[];
    forbiddenPaths?: string[];
    rebuild?: AgentTaskSpec['rebuild'] | null;
    detectors?: AgentTaskSpec['detectors'];
    files?: { path: string; content: string }[];
    solution?: AgentTaskSolution | null;
  };
  const toml = readFileSync(path.join(outDir, 'task.toml'), 'utf8');

  // Fallback de compatibilidade (árvore gerada antes dos campos crus): separa o
  // `checks` fundido por kind e devolve `regression` sem o `kind` derivado.
  const f2p = spec.checks.filter((c) => (c.kind ?? 'fail_to_pass') === 'fail_to_pass');
  const p2p = spec.checks.filter((c) => c.kind === 'pass_to_pass');
  const verify = spec.verify ?? f2p;
  const regression =
    spec.regression ??
    p2p.map((c) => {
      const { kind: _kind, ...resto } = c;
      void _kind;
      return resto;
    });

  const contextFilesRaw = readTomlTopKey(toml, 'context_files');
  const detectors =
    spec.detectors ?? (readTomlTopKey(toml, 'detectors') as AgentTaskSpec['detectors'] | undefined);

  const task: AgentTaskSpec = {
    ...(readTomlSection(toml, 'repo') ? { repo: readRepo(toml) } : {}),
    ...(readSetup(toml).length > 0 ? { setup: readSetup(toml) } : {}),
    ...(spec.files !== undefined ? { files: spec.files } : {}),
    ...(spec.verify !== undefined ? { verify } : verify.length > 0 ? { verify } : {}),
    ...(spec.regression !== undefined ? { regression } : regression.length > 0 ? { regression } : {}),
    ...(spec.solution ? { solution: spec.solution } : {}),
    ...(readTomlKey(toml, 'tests', 'tests_dir') ? { testsDir: readTomlKey(toml, 'tests', 'tests_dir') } : {}),
    ...(readTomlKey(toml, 'env', 'digest')
      ? {
          env: {
            digest: readTomlKey(toml, 'env', 'digest')!,
            ...(readTomlKey(toml, 'env', 'path') ? { path: readTomlKey(toml, 'env', 'path')! } : {}),
          },
        }
      : {}),
    ...(readTomlSection(toml, 'metadata') ? { metadata: readMetadata(toml) } : {}),
    ...(spec.forbiddenPaths !== undefined ? { forbiddenPaths: spec.forbiddenPaths } : {}),
    ...(spec.rebuild ? { rebuild: spec.rebuild } : {}),
    ...(detectors !== undefined ? { detectors } : {}),
    ...(contextFilesRaw !== undefined ? { contextFiles: asBool(contextFilesRaw) } : {}),
    ...(readTomlSection(toml, 'limits') ? { limits: readLimits(toml) } : {}),
  };
  return { task, instruction };
}

// --- leitura TOML MÍNIMA (só o que o compilador escreve — sem dependência) ----

/** Chave de topo (antes da primeira seção) — `context_files`, `detectors`, … */
function readTomlTopKey(toml: string, key: string): string | boolean | undefined {
  for (const line of toml.split('\n')) {
    if (line.startsWith('[')) return undefined;
    const m = line.match(/^([a-z_0-9]+)\s*=\s*(.+)$/);
    if (m && m[1] === key) return parseTomlValue(m[2]) as string | boolean;
  }
  return undefined;
}

function readTomlSection(toml: string, name: string): string[] | null {
  const lines = toml.split('\n');
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (line.startsWith('[') ) {
      inside = line.trim() === `[${name}]`;
      continue;
    }
    if (inside && line.trim() !== '' && !line.trim().startsWith('#')) out.push(line.trim());
  }
  return out.length > 0 || toml.includes(`[${name}]`) ? out : null;
}

function readTomlKey(toml: string, section: string, key: string): string | undefined {
  const rows = readTomlSection(toml, section);
  if (!rows) return undefined;
  for (const row of rows) {
    const m = row.match(/^([a-z_0-9]+)\s*=\s*(.+)$/);
    if (m && m[1] === key) return parseTomlValue(m[2]) as string;
  }
  return undefined;
}

function parseTomlValue(raw: string): string | number | boolean | string[] {
  const v = raw.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v.startsWith('"')) return JSON.parse(v) as string;
  if (v.startsWith('[')) {
    // O compilador escreve ARRAYS em JSON (`JSON.stringify`) — parse direto
    // preserva strings com vírgula/aspas (o split por ',' as fatiaria).
    try {
      return JSON.parse(v) as string[];
    } catch {
      const inner = v.slice(1, -1);
      if (inner.trim() === '') return [];
      return inner.split(',').map((s) => JSON.parse(s.trim()) as string);
    }
  }
  return Number(v);
}

function readRepo(toml: string): NonNullable<AgentTaskSpec['repo']> {
  const kind = (readTomlKey(toml, 'repo', 'kind') ?? 'git') as 'git';
  const url = readTomlKey(toml, 'repo', 'url');
  const repoPath = readTomlKey(toml, 'repo', 'path');
  const ref = readTomlKey(toml, 'repo', 'ref') ?? '';
  const shallowRaw = readTomlKey(toml, 'repo', 'shallow');
  return {
    kind,
    ...(url ? { url } : {}),
    ...(repoPath ? { path: repoPath } : {}),
    ref,
    ...(shallowRaw !== undefined ? { shallow: asBool(shallowRaw) } : {}),
  };
}

function readSetup(toml: string): NonNullable<AgentTaskSpec['setup']> {
  const rows = readTomlSection(toml, 'setup') ?? [];
  const byIndex = new Map<number, { cmd: string; timeoutMs?: number }>();
  for (const row of rows) {
    const m = row.match(/^cmd_(\d+)\s*=\s*(.+)$/);
    if (m) {
      const i = Number(m[1]);
      byIndex.set(i, { cmd: JSON.parse(m[2]) as string, ...(byIndex.get(i) ?? {}) });
      continue;
    }
    const t = row.match(/^timeout_ms_(\d+)\s*=\s*(.+)$/);
    if (t) {
      const i = Number(t[1]);
      const prev = byIndex.get(i) ?? { cmd: '' };
      byIndex.set(i, { ...prev, timeoutMs: Number(t[2]) });
    }
  }
  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}

function readMetadata(toml: string): NonNullable<AgentTaskSpec['metadata']> {
  const tags = readTomlKey(toml, 'metadata', 'tags');
  const canary = readTomlKey(toml, 'metadata', 'canary');
  return {
    ...(readTomlKey(toml, 'metadata', 'origin') ? { origin: readTomlKey(toml, 'metadata', 'origin')! } : {}),
    ...(readTomlKey(toml, 'metadata', 'commit') ? { commit: readTomlKey(toml, 'metadata', 'commit')! } : {}),
    ...(readTomlKey(toml, 'metadata', 'difficulty')
      ? { difficulty: readTomlKey(toml, 'metadata', 'difficulty') as 'easy' | 'medium' | 'hard' }
      : {}),
    ...(Array.isArray(tags) ? { tags } : {}),
    ...(canary !== undefined ? { canary: asBool(canary) } : {}),
  };
}

function readLimits(toml: string): NonNullable<AgentTaskSpec['limits']> {
  const num = (k: string): number | undefined => {
    const v = readTomlKey(toml, 'limits', k);
    return v === undefined ? undefined : Number(v);
  };
  return {
    ...(num('max_turns') !== undefined ? { maxTurns: num('max_turns') } : {}),
    ...(num('max_cost_usd') !== undefined ? { maxCostUsd: num('max_cost_usd') } : {}),
    ...(num('timeout_ms') !== undefined ? { timeoutMs: num('timeout_ms') } : {}),
    ...(num('max_output_bytes') !== undefined ? { maxOutputBytes: num('max_output_bytes') } : {}),
    ...(num('max_diff_bytes') !== undefined ? { maxDiffBytes: num('max_diff_bytes') } : {}),
  };
}
