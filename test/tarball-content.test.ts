// Teste de CONTEÚDO do tarball npm (IMPL-044 / R-19:REC-10).
//
// O `skills/prompt-builder/SKILL.md` carregou por meses uma seção pessoal do
// mantenedor ("Agentes desta máquina") com contas locais, caminhos de home,
// um proxy em 127.0.0.1:4000 e nomes de arquivo de key. Ela ia no tarball e o
// `init` a copiava para o repo de cada usuário. Este teste fecha a porta:
//
//  1. a lista de arquivos vem do PRÓPRIO npm (`npm pack --dry-run --json`), não
//     de uma cópia do `files` — o que o npm embarcaria é o que é varrido;
//  2. cada arquivo de texto embarcado passa por uma taxonomia de marcadores
//     sensíveis; o código embarcado (dist/, compilado de src/) é varrido pela
//     FONTE, para o teste não depender de um build prévio;
//  3. teto de tamanho: corpo de SKILL.md ≤ 2.048 bytes (vai inteiro para o
//     contexto do agente a cada ativação) e cada doc embarcado ≤ 20 KiB;
//  4. prova negativa: um pacote temporário com os marcadores plantados PRECISA
//     reprovar pelo mesmo caminho (npm pack real + varredura).
//
// Segredos de verdade são assunto do gitleaks (`.gitleaks.toml` + CI); aqui o
// alvo é dado pessoal/de máquina que nenhum scanner de segredo pega.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Teto do CORPO (sem frontmatter) de cada SKILL.md embarcada. */
const SKILL_BODY_MAX_BYTES = 2048;
/** Teto por doc embarcado (agent-docs/*.md) — anti-inchaço; o maior hoje tem ~17 KiB. */
const DOC_MAX_BYTES = 20 * 1024;

// ---------------------------------------------------------------------------
// Taxonomia de marcadores sensíveis
// ---------------------------------------------------------------------------

interface Rule {
  id: 'secao-pessoal' | 'conta-local' | 'caminho-home' | 'host-interno' | 'rotulo-de-key';
  re: RegExp;
  /** Variante para código (fonte do dist); `null` = regra só vale para docs. */
  codeRe: RegExp | null;
}

/** Portas de dev DO PRODUTO (README): API 3001, Vite 5173, referer 3000. */
const PRODUCT_PORTS = '3000|3001|5173';

const SECAO = /Agentes desta m[áa]quina|configura[çc][ãa]o local do autor/iu;
const CONTA =
  /\b[a-z0-9]{1,8}\.(?:frederico|rodrigo|kluser)\b|\b(?:deepseek-claude|azureclaude|deepclaude|claude-contas|asd-functions|_claude_deepseek)\b/iu;
// `~/<algo>` exige um segmento depois (o regex `/^~/` do código não é caminho)
const HOME =
  /(?:^|[^\w.])~\/(?!\.prompt-builder\b)[\w.-]|\$HOME\/(?!\.prompt-builder\b)[\w.-]|\/home\/[a-z_][\w.-]*|\/Users\/[A-Za-z][\w.-]*|[A-Z]:\\Users\\/u;
const KEY_LABEL = String.raw`\bsk-[\w-]*?[A-Za-z0-9]{3,}(?:\.{3}|…)[A-Za-z0-9]{2,}|\bsk-(?:or-v1-|ant-|proj-)?[A-Za-z0-9]{24,}`;

const RULES: Rule[] = [
  // a seção removida, por nome — regressão direta
  { id: 'secao-pessoal', re: SECAO, codeRe: SECAO },
  // contas locais: `<tag>.<nome do mantenedor>` e os wrappers pessoais de agente
  { id: 'conta-local', re: CONTA, codeRe: CONTA },
  // caminhos de home: `~/…` (exceto o data-dir documentado do produto), $HOME/…, /home/<user>, /Users/<user>
  { id: 'caminho-home', re: HOME, codeRe: HOME },
  // hosts internos: loopback COM porta fora das do produto, IPv4 privado, TLDs internos
  {
    id: 'host-interno',
    re: new RegExp(
      `\\b(?:127(?:\\.\\d{1,3}){3}|localhost|0\\.0\\.0\\.0):(?!(?:${PRODUCT_PORTS})\\b)\\d{2,5}\\b` +
        '|\\b(?:10(?:\\.\\d{1,3}){3}|192\\.168(?:\\.\\d{1,3}){2}|172\\.(?:1[6-9]|2\\d|3[01])(?:\\.\\d{1,3}){2})\\b' +
        '|\\b[\\w-]+(?:\\.[\\w-]+)*\\.(?:internal|lan|corp|intranet|home\\.arpa)\\b',
      'u',
    ),
    // no código, `127.0.0.1`/`localhost` são bind/checagem de origem legítimos (agentRoutes)
    codeRe: null,
  },
  // rótulos de key: truncados (`sk-or-v1-3f2…a91`), inteiros, e arquivos `*.key`.
  // O placeholder `sk-or-v1-...` dos docs NÃO casa (não há alfanumérico antes das reticências).
  {
    id: 'rotulo-de-key',
    re: new RegExp(`${KEY_LABEL}|(?:^|[\\s\`'"(/])[\\w*-]+\\.key\\b`, 'u'),
    // no código `rec.key` é acesso a propriedade: arquivo `*.key` só dentro de string/caminho
    codeRe: new RegExp(`${KEY_LABEL}|(?:/|['"\`])[\\w*-]+\\.key(?=['"\`])`, 'u'),
  },
];

interface Finding {
  file: string;
  line: number;
  rule: Rule['id'];
  match: string;
}

function scanText(file: string, text: string, kind: 'doc' | 'code'): Finding[] {
  const out: Finding[] = [];
  text.split(/\r?\n/u).forEach((line, i) => {
    for (const rule of RULES) {
      const re = kind === 'code' ? rule.codeRe : rule.re;
      if (!re) continue;
      const m = re.exec(line);
      if (m) out.push({ file, line: i + 1, rule: rule.id, match: m[0].trim() });
    }
  });
  return out;
}

/** Corpo da SKILL.md = tudo depois do frontmatter `---…---`. */
function skillBody(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/u.exec(text);
  return m ? text.slice(m[0].length) : text;
}

// ---------------------------------------------------------------------------
// O que o npm embarcaria
// ---------------------------------------------------------------------------

/** Lista REAL do `npm pack --dry-run --json` (sem scripts de ciclo de vida). */
function packedFiles(pkgDir: string): string[] {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: pkgDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  const parsed = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
  return parsed[0]!.files.map((f) => f.path).sort();
}

const TEXT_EXT = /\.(?:md|markdown|json|txt|ya?ml|toml)$|^(?:README|LICENSE|CHANGELOG)(?:\.\w+)?$/iu;

/** Código que o tarball leva: `dist/` sai de `src/**` menos o que o `files` nega (server/routes). */
function shippedSources(pkgDir: string): string[] {
  const srcDir = path.join(pkgDir, 'src');
  if (!fs.existsSync(srcDir)) return [];
  return (fs.readdirSync(srcDir, { recursive: true }) as string[])
    .map((rel) => path.join('src', rel))
    .filter((rel) => rel.endsWith('.ts') && !/^src[\\/](?:server|routes)\.ts$/u.test(rel))
    .sort();
}

interface PackageReport {
  packed: string[];
  findings: Finding[];
  oversize: Array<{ file: string; bytes: number; max: number }>;
}

function auditPackage(pkgDir: string): PackageReport {
  const packed = packedFiles(pkgDir);
  const findings: Finding[] = [];
  const oversize: PackageReport['oversize'] = [];

  for (const rel of packed) {
    // dist/ é varrido pela fonte (abaixo): o teste não pode depender de build.
    if (rel.startsWith('dist/')) continue;
    if (!TEXT_EXT.test(path.basename(rel))) continue;
    const text = fs.readFileSync(path.join(pkgDir, rel), 'utf8');
    findings.push(...scanText(rel, text, 'doc'));

    if (path.basename(rel) === 'SKILL.md') {
      const bytes = Buffer.byteLength(skillBody(text), 'utf8');
      if (bytes > SKILL_BODY_MAX_BYTES) oversize.push({ file: rel, bytes, max: SKILL_BODY_MAX_BYTES });
    } else if (/^agent-docs\/.+\.md$/u.test(rel)) {
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > DOC_MAX_BYTES) oversize.push({ file: rel, bytes, max: DOC_MAX_BYTES });
    }
  }
  for (const rel of shippedSources(pkgDir)) {
    findings.push(...scanText(rel, fs.readFileSync(path.join(pkgDir, rel), 'utf8'), 'code'));
  }
  return { packed, findings, oversize };
}

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

describe('tarball npm: conteúdo embarcado (IMPL-044)', () => {
  const real = auditPackage(ROOT);

  it('a varredura não é vazia: SKILL.md e agent-docs estão na lista do npm pack', () => {
    expect(real.packed).toContain('skills/prompt-builder/SKILL.md');
    expect(real.packed.filter((f) => f.startsWith('agent-docs/')).length).toBeGreaterThan(5);
    expect(real.packed).toContain('package.json');
  });

  it('nenhum marcador sensível no que o npm embarcaria (docs, skill e fonte do dist)', () => {
    expect(real.findings).toEqual([]);
  });

  it('a seção pessoal "Agentes desta máquina" não existe na SKILL.md', () => {
    const skill = fs.readFileSync(path.join(ROOT, 'skills/prompt-builder/SKILL.md'), 'utf8');
    expect(skill).not.toMatch(/Agentes desta m[áa]quina/iu);
  });

  it(`corpo da SKILL.md ≤ ${SKILL_BODY_MAX_BYTES} bytes e cada agent-doc ≤ ${DOC_MAX_BYTES} bytes`, () => {
    expect(real.oversize).toEqual([]);
    const body = skillBody(fs.readFileSync(path.join(ROOT, 'skills/prompt-builder/SKILL.md'), 'utf8'));
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(SKILL_BODY_MAX_BYTES);
    // enxuta, mas ainda aponta para a documentação embarcada
    expect(body).toMatch(/docs --list/u);
    expect(body).toMatch(/--budget/u);
    expect(body).toMatch(/--idempotency-key/u);
  });
});

describe('prova negativa: marcador plantado reprova pelo mesmo caminho', () => {
  const tmpDirs: string[] = [];
  afterAll(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  /** Pacote mínimo real (npm pack roda nele) com uma SKILL.md e um doc arbitrários. */
  function plantPackage(skillMd: string, extra: Record<string, string> = {}): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-tarball-'));
    tmpDirs.push(dir);
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'pb-tarball-probe', version: '0.0.0', files: ['skills', 'agent-docs'] }),
    );
    fs.mkdirSync(path.join(dir, 'skills/prompt-builder'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'agent-docs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills/prompt-builder/SKILL.md'), skillMd);
    for (const [rel, body] of Object.entries(extra)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
    return dir;
  }

  const FM = '---\nname: probe\ndescription: probe\n---\n';

  // Um marcador sintético por categoria — espelha o formato do que vazou.
  const PLANTED: Array<[Rule['id'], string]> = [
    ['secao-pessoal', '## Agentes desta máquina (configuração local do autor)'],
    ['conta-local', '| `zz` | conta `x9.rodrigo` → dir próprio |'],
    ['conta-local', 'dispare com `azureclaude --proxy-status`'],
    ['caminho-home', 'as chaves vivem em `~/.secrets-probe`'],
    ['caminho-home', 'node em /home/fulano/.nvm/versions/node/bin'],
    ['host-interno', 'LiteLLM local (127.0.0.1:4000) → deployment'],
    ['host-interno', 'painel em http://build.corp/status'],
    ['rotulo-de-key', 'key ativa: sk-or-v1-3f2ab…a91c'],
    ['rotulo-de-key', 'o arquivo `probe.key` (0600)'],
  ];

  it.each(PLANTED)('%s: "%s" é pego no tarball', (rule, marker) => {
    const dir = plantPackage(`${FM}# probe\n\ntexto limpo\n${marker}\n`);
    const rep = auditPackage(dir);
    expect(rep.packed).toContain('skills/prompt-builder/SKILL.md');
    expect(rep.findings.map((f) => f.rule)).toContain(rule);
    expect(rep.findings[0]!.file).toBe('skills/prompt-builder/SKILL.md');
  });

  it('marcador num agent-doc também reprova (não só na skill)', () => {
    const dir = plantPackage(`${FM}# probe\n`, { 'agent-docs/extra.md': 'rode em ~/.config/probe/config.yaml\n' });
    expect(auditPackage(dir).findings).toEqual([
      expect.objectContaining({ file: 'agent-docs/extra.md', rule: 'caminho-home' }),
    ]);
  });

  it('marcador em código embarcado (fonte do dist) reprova', () => {
    const dir = plantPackage(`${FM}# probe\n`, {
      'src/agent/probe.ts': [
        "const NODE_BIN_DIR = '/home/fulano/.nvm/versions/node/v24/bin';",
        "const k = readFileSync('probe.key', 'utf8');",
        // falsos positivos conhecidos do código real: acesso a propriedade, regex, bind local
        "const same = rec.key === checks.key && head.replace(/^~/, '') && ip === '127.0.0.1';",
      ].join('\n'),
      'src/server.ts': "const X = '/home/fulano/fora-do-tarball';\n", // negado no `files` real → ignorado
    });
    const probe = path.join('src', 'agent', 'probe.ts');
    expect(auditPackage(dir).findings).toEqual([
      expect.objectContaining({ file: probe, line: 1, rule: 'caminho-home' }),
      expect.objectContaining({ file: probe, line: 2, rule: 'rotulo-de-key' }),
    ]);
  });

  it('placeholders e valores do produto NÃO reprovam (sem falso positivo)', () => {
    const clean = [
      'dados em `~/.prompt-builder` (data-dir do CLI)',
      'curl http://localhost:3001/v1/benchmark/runs -H "x-openrouter-key: sk-or-v1-..."',
      'Vite em http://localhost:5173',
      'retentativa com `--idempotency-key`',
      'Copyright (c) 2026 Frederico Kluser',
      '`record.stages.length === cenários × repeats`',
    ].join('\n');
    const dir = plantPackage(`${FM}# probe\n${clean}\n`);
    expect(auditPackage(dir).findings).toEqual([]);
  });

  it(`corpo de SKILL.md acima de ${SKILL_BODY_MAX_BYTES} bytes reprova; o frontmatter não conta`, () => {
    const longFm = `---\nname: probe\ndescription: ${'d'.repeat(3000)}\n---\n`;
    expect(auditPackage(plantPackage(`${longFm}${'a'.repeat(SKILL_BODY_MAX_BYTES)}`)).oversize).toEqual([]);
    const fat = auditPackage(plantPackage(`${FM}${'á'.repeat(SKILL_BODY_MAX_BYTES / 2 + 1)}`)); // 2 bytes cada
    expect(fat.oversize).toEqual([
      { file: 'skills/prompt-builder/SKILL.md', bytes: SKILL_BODY_MAX_BYTES + 2, max: SKILL_BODY_MAX_BYTES },
    ]);
  });

  it(`agent-doc acima de ${DOC_MAX_BYTES} bytes reprova`, () => {
    const dir = plantPackage(`${FM}# probe\n`, { 'agent-docs/big.md': 'x'.repeat(DOC_MAX_BYTES + 1) });
    expect(auditPackage(dir).oversize).toEqual([
      { file: 'agent-docs/big.md', bytes: DOC_MAX_BYTES + 1, max: DOC_MAX_BYTES },
    ]);
  });
});

// gitleaks é opcional localmente (o CI sempre roda — `.github/workflows/gitleaks.yml`).
const hasGitleaks = spawnSync('gitleaks', ['version'], { stdio: 'ignore' }).status === 0;

describe.runIf(hasGitleaks)('gitleaks (binário local presente)', () => {
  it('arquivos versionados (working tree) sem vazamento, com a allowlist do repo', () => {
    // cópia só do que o git rastreia: node_modules/scratchpad não entram (o CI faz o mesmo via checkout)
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-gitleaks-'));
    try {
      const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
        .split('\0')
        .filter(Boolean);
      for (const rel of tracked) {
        const src = path.join(ROOT, rel);
        if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue; // removido no working tree
        fs.mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true });
        fs.copyFileSync(src, path.join(tree, rel));
      }
      const r = spawnSync(
        'gitleaks',
        ['dir', tree, '--config', path.join(ROOT, '.gitleaks.toml'), '--redact', '--no-banner'],
        { encoding: 'utf8', timeout: 120_000 },
      );
      expect(r.status, r.stdout + r.stderr).toBe(0);
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
    }
  }, 180_000);
});
