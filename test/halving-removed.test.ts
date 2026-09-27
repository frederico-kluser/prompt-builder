// IMPL-012 (R-02b:REC-3) — o sequential halving saiu do laço de treino.
//
// A triagem cobrava uma run completa por iteração, eliminava 0 variantes
// (keep = V na rodada 1) e descartava o rascunho; as simulações H4/H5/H6 da
// R-02b vetam religá-la como estava. Estes testes travam a remoção:
//   1. nenhum código de produção (src/, web/src/) chama/lê o halving;
//   2. arquivo de config antigo com `training.halving` continua VÁLIDO
//      (qualquer valor), a chave é ignorada e sai um aviso de descontinuado;
//   3. a flag não chega ao RunConfig nem ao motor;
//   4. a decisão fica documentada no laço (H4/H5/H6 com os números);
//   5. nenhum teste espera planHalving/survivorsOf.
import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { HALVING_DEPRECATED_WARNING, parseArenaConfig } from '../src/configFile.js';
import {
  HALVING_DEPRECATED_WARNING as HALVING_DEPRECATED_WARNING_WEB,
  parseArenaConfig as parseArenaConfigWeb,
} from '../web/src/engine/configFile.js';
import { arenaConfigToRunConfig } from '../src/arenaConfig.js';
import { cmdConfig } from '../src/cli/commands/misc.js';
import { getDataDir, setDataDir } from '../src/storage.js';

const RAIZ = join(__dirname, '..');

function arquivosTs(dir: string): string[] {
  const out: string[] = [];
  for (const nome of readdirSync(dir)) {
    if (nome === 'node_modules' || nome === 'dist') continue;
    const p = join(dir, nome);
    if (statSync(p).isDirectory()) out.push(...arquivosTs(p));
    else if (/\.(ts|tsx)$/.test(nome)) out.push(p);
  }
  return out;
}

/** Tira comentários e literais de string: sobra só o código executável. */
function soCodigo(fonte: string): string {
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

const arquivo = (training: Record<string, unknown>) => ({
  format: 'arena-config@1',
  mode: 'training',
  theme: 'suporte',
  stages: 8,
  prompt: { text: 'Você é um assistente de suporte.' },
  models: { datagen: 'openai/gpt-5-mini', judges: ['anthropic/claude-sonnet-5'], contestant: 'openai/gpt-5-mini' },
  variation: { optimize: true, techniques: ['persona', 'constraints'] },
  training,
});

describe('IMPL-012 — halving fora do código de produção', () => {
  const producao = [...arquivosTs(join(RAIZ, 'src')), ...arquivosTs(join(RAIZ, 'web/src'))];

  it('o módulo src/engine/halving.ts não existe mais', () => {
    expect(existsSync(join(RAIZ, 'src/engine/halving.ts'))).toBe(false);
    expect(existsSync(join(RAIZ, 'web/src/engine/halving.ts'))).toBe(false);
  });

  it('nenhum arquivo de src/ ou web/src/ importa/chama planHalving, survivorsOf ou engine/halving', () => {
    const achados = producao.filter((f) =>
      /planHalving|survivorsOf|HalvingPlan|HalvingEntry|engine\/halving/.test(readFileSync(f, 'utf-8')),
    );
    expect(achados.map((f) => relative(RAIZ, f))).toEqual([]);
  });

  it('nenhum código (fora comentário/string) lê a flag `.halving` nem a declara no schema/tipo', () => {
    const achados: string[] = [];
    for (const f of producao) {
      const codigo = soCodigo(readFileSync(f, 'utf-8'));
      codigo.split('\n').forEach((linha, i) => {
        // `x.halving`, `x?.halving`, `halving:` (schema zod/tipo/objeto), `halving?:` (tipo).
        if (/\??\.\s*halving\b|\bhalving\s*\??\s*:/.test(linha)) achados.push(`${relative(RAIZ, f)}:${i + 1}: ${linha.trim()}`);
      });
    }
    expect(achados).toEqual([]);
  });

  it('a decisão está documentada no laço de treino dos dois lados (H4/H5/H6 com os números)', () => {
    for (const p of ['src/trainer.ts', 'web/src/engine/trainer.ts']) {
      const fonte = readFileSync(join(RAIZ, p), 'utf-8');
      expect(fonte, p).toContain('IMPL-012');
      expect(fonte, p).toMatch(/H4[^\n]*21,7–24,3%/);
      expect(fonte, p).toMatch(/H5[^\n]*20%/);
      expect(fonte, p).toMatch(/H6[^\n]*\n?[^\n]*4,9–8,7 p\.p\./);
    }
  });

  it('nenhum teste espera planHalving/survivorsOf (o antigo test/halving.test.ts saiu)', () => {
    expect(existsSync(join(RAIZ, 'test/halving.test.ts'))).toBe(false);
    const alvo = new RegExp(['plan', 'Halving|survivors', 'Of'].join(''));
    const achados = readdirSync(join(RAIZ, 'test'))
      .filter((n) => n.endsWith('.ts') && n !== 'halving-removed.test.ts')
      .filter((n) => alvo.test(readFileSync(join(RAIZ, 'test', n), 'utf-8')));
    expect(achados).toEqual([]);
  });
});

describe('IMPL-012 — config antigo com `training.halving` nunca quebra', () => {
  for (const [lado, parse, aviso] of [
    ['src', parseArenaConfig, HALVING_DEPRECATED_WARNING],
    ['web', parseArenaConfigWeb, HALVING_DEPRECATED_WARNING_WEB],
  ] as const) {
    it(`${lado}: halving: true é aceito, descartado do config e gera aviso de descontinuado`, () => {
      const r = parse(arquivo({ iterations: 3, halving: true }));
      expect(r.ok ? 'ok' : r.error).toBe('ok');
      if (!r.ok) return;
      expect(r.warnings).toEqual([aviso]);
      expect(aviso).toMatch(/descontinuado/);
      expect(r.config.training).not.toHaveProperty('halving');
    });

    it(`${lado}: qualquer valor de halving (antes: 'deve ser boolean') continua válido`, () => {
      for (const valor of [false, 'sim', 3, null, { rounds: 2 }]) {
        const r = parse(arquivo({ iterations: 3, halving: valor }));
        expect(r.ok ? 'ok' : r.error, `halving=${JSON.stringify(valor)}`).toBe('ok');
        if (r.ok) expect(r.warnings).toEqual([aviso]);
      }
    });

    it(`${lado}: arquivo sem halving não ganha aviso (resultado idêntico ao de antes)`, () => {
      const r = parse(arquivo({ iterations: 3 }));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r).not.toHaveProperty('warnings');
    });
  }

  it('a flag não chega ao RunConfig do treino (conversor não a repassa)', () => {
    const r = parseArenaConfig(arquivo({ iterations: 3, halving: true, holdoutRatio: 0.3 }));
    if (!r.ok) throw new Error(r.error);
    const conv = arenaConfigToRunConfig(r.config);
    if (!conv.ok || conv.config.mode !== 'training') throw new Error('esperava training');
    expect(conv.config).not.toHaveProperty('halving');
    // controle: o campo vizinho continua passando (o conversor não foi amputado)
    expect(conv.config.holdoutRatio).toBe(0.3);
  });

  it('CLI `config validate`: exit 0 e o aviso vai para o stderr (stdout é payload)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pb-impl012-'));
    const file = join(dir, 'cfg.json');
    writeFileSync(file, JSON.stringify(arquivo({ iterations: 3, halving: true })));
    const anterior = getDataDir();
    const err: string[] = [];
    const out: string[] = [];
    const spyErr = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      err.push(String(c));
      return true;
    });
    const spyOut = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      out.push(String(c));
      return true;
    });
    try {
      const code = await cmdConfig(['validate', file, '--json', '--data-dir', dir]);
      expect(code).toBe(0);
    } finally {
      spyErr.mockRestore();
      spyOut.mockRestore();
      setDataDir(anterior);
    }
    expect(err.join('')).toContain(HALVING_DEPRECATED_WARNING);
    expect(out.join('')).not.toContain('halving');
  });
});
