// ----------------------------------------------------------------------------
// Benchmark de startup do sandbox endurecido (IMPL-036 / R-15 REC-1, métrica).
//
// Critério: startup p50 < 2 s E endurecido < +10% vs `docker run` padrão, no
// protocolo da pesquisa: `hyperfine --warmup 3 -r 50 'docker run --rm <flags>
// node:22-bookworm-slim node -e 0'`. Se o `hyperfine` estiver no PATH ele é
// usado; senão, um laço equivalente (mesmo warmup/runs, execuções INTERCALADAS
// padrão × endurecido para não confundir deriva da máquina com overhead).
//
// Uso (a imagem precisa já estar no daemon — o script nunca puxa):
//   npx tsx scripts/bench-sandbox-startup.ts [--runs 50] [--warmup 3] [--image node:22-bookworm-slim]
// Saída: resumo no stderr, UMA linha JSON no stdout. Exit 1 se o critério falhar.
// ----------------------------------------------------------------------------
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildSandboxRunArgv, hardeningProfile, resolveImageDigest } from '../src/agent/container.js';

const { values } = parseArgs({
  options: {
    runs: { type: 'string', default: '50' },
    warmup: { type: 'string', default: '3' },
    image: { type: 'string', default: 'node:22-bookworm-slim' },
  },
});
const runs = Number(values.runs);
const warmup = Number(values.warmup);
const imageRef = values.image as string;

const pinned = await resolveImageDigest(imageRef);
if (!pinned) {
  console.error(`imagem ${imageRef} ausente no daemon — rode \`docker pull ${imageRef}\` antes (o benchmark não puxa).`);
  process.exit(2);
}
const command = ['node', '-e', '0'];
const plain = ['run', '--rm', pinned.digest, ...command];
const hardened = buildSandboxRunArgv({ image: pinned.digest, profile: hardeningProfile({ env: {} }), command });

function quantile(sorted: number[], q: number): number {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
function summary(ms: number[]) {
  const s = [...ms].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { n: s.length, p50: quantile(s, 0.5), p95: quantile(s, 0.95), mean, min: s[0], max: s[s.length - 1] };
}

function once(argv: string[]): number {
  const t = process.hrtime.bigint();
  const r = spawnSync('docker', argv, { stdio: 'ignore' });
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  if (r.status !== 0) throw new Error(`docker ${argv.join(' ')} saiu com ${r.status}`);
  return ms;
}

const quote = (argv: string[]) => ['docker', ...argv].map((a) => (/^[\w./:=,@-]+$/.test(a) ? a : `'${a}'`)).join(' ');
let tool: 'hyperfine' | 'node-loop';
let plainMs: ReturnType<typeof summary>;
let hardMs: ReturnType<typeof summary>;

if (spawnSync('hyperfine', ['--version'], { stdio: 'ignore' }).status === 0) {
  tool = 'hyperfine';
  const dir = mkdtempSync(path.join(tmpdir(), 'pb-bench-'));
  const out = path.join(dir, 'hf.json');
  const r = spawnSync(
    'hyperfine',
    ['--warmup', String(warmup), '-r', String(runs), '-N', '--export-json', out, quote(plain), quote(hardened)],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  if (r.status !== 0) throw new Error('hyperfine falhou');
  const results = (JSON.parse(readFileSync(out, 'utf8')) as { results: { times: number[] }[] }).results;
  rmSync(dir, { recursive: true, force: true });
  plainMs = summary(results[0].times.map((s) => s * 1000));
  hardMs = summary(results[1].times.map((s) => s * 1000));
} else {
  tool = 'node-loop';
  for (let i = 0; i < warmup; i++) {
    once(plain);
    once(hardened);
  }
  const a: number[] = [];
  const b: number[] = [];
  for (let i = 0; i < runs; i++) {
    // Intercalado — e alternando quem vai primeiro — para a deriva não pesar num lado só.
    if (i % 2 === 0) {
      a.push(once(plain));
      b.push(once(hardened));
    } else {
      b.push(once(hardened));
      a.push(once(plain));
    }
  }
  plainMs = summary(a);
  hardMs = summary(b);
}

const overheadPct = ((hardMs.p50 - plainMs.p50) / plainMs.p50) * 100;
const pass = hardMs.p50 < 2000 && overheadPct < 10;
console.error(`ferramenta: ${tool} · imagem ${imageRef} (${pinned.digest}) · warmup ${warmup} · runs ${runs}`);
console.error(`padrão     p50 ${plainMs.p50.toFixed(0)} ms · p95 ${plainMs.p95.toFixed(0)} ms · média ${plainMs.mean.toFixed(0)} ms`);
console.error(`endurecido p50 ${hardMs.p50.toFixed(0)} ms · p95 ${hardMs.p95.toFixed(0)} ms · média ${hardMs.mean.toFixed(0)} ms`);
console.error(`overhead p50: ${overheadPct.toFixed(1)}% → ${pass ? 'OK' : 'FALHOU'} (critério: p50 < 2000 ms e < +10%)`);
process.stdout.write(
  JSON.stringify({ tool, image: pinned.digest, warmup, runs, plain: plainMs, hardened: hardMs, overheadPct, pass }) + '\n',
);
process.exit(pass ? 0 : 1);
