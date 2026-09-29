// left#15 — code-splitting do SPA. Antes o `vite build` gerava UM chunk de
// ~1,73 MB (gzip ~556 KB): quem abria só a Nova Run baixava o relatório de
// ciclos, o modo JEV inteiro, o pipeline (orchestrator/trainer) e todas as
// telas. Medido no fechamento (web/dist): chunk de entrada 1.734,87 kB →
// 1.067,28 kB (gzip 555,67 → 350,23 kB).
//
// Contratos (fonte + comportamento, sem build — o build real roda no
// test/web-views-e2e.test.ts):
//  (1) main.tsx: as rotas pesadas são `React.lazy`; o Suspense (esqueleto)
//      fica DENTRO da fronteira de erro da rota, que fica dentro do gate da
//      key — chunk que falha cai na tela de erro com "Recarregar";
//  (2) o JEV não entra no chunk de entrada: `/new` lê o seletor de um módulo
//      leve e carrega o formulário JEV sob demanda; o histórico JEV também;
//  (3) api.ts não importa o pipeline estaticamente — carrega na hora de
//      iniciar; cancelar/"dá para cancelar?" seguem SÍNCRONOS e respondem
//      `false` quando nada roda nesta aba (módulo nem carregado);
//  (4) o zod é UMA cópia no bundle (dedupe no vite.config).

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf-8');

describe('left#15 (1) rotas pesadas sob demanda, com esqueleto e fronteira de erro', () => {
  const main = read('web/src/main.tsx');

  it('as telas além da Nova Run e do first-run são lazy (nenhum import estático delas)', () => {
    const lazies: Array<[string, string]> = [
      ['RunView', './pages/RunView'],
      ['RunsList', './pages/RunsList'],
      ['TrainingView', './pages/TrainingView'],
      ['TrainingReport', './pages/TrainingReport'],
      ['SettingsPage', './pages/Settings'],
      ['PromptsPage', './pages/PromptsPage'],
      ['JevRunView', './pages/jev/JevRunView'],
      ['JevTrainingView', './pages/jev/JevTrainingView'],
      ['JevReportPage', './pages/jev/JevReportPage'],
    ];
    for (const [nome, mod] of lazies) {
      expect(main, nome).toContain(`const ${nome} = lazyPage(() => import('${mod}'), '${nome}');`);
      expect(main, nome).not.toMatch(new RegExp(`^import \\{[^}]*\\b${nome}\\b[^}]*\\} from '${mod.replace(/[./]/g, '\\$&')}';`, 'm'));
    }
    // A rota de entrada (/ → /new) e o first-run seguem no chunk principal.
    expect(main).toMatch(/^import \{ NewBenchmark \} from '\.\/pages\/NewBenchmark';$/m);
    expect(main).toMatch(/^import \{ FirstRun, keyAskSkipped \} from '\.\/components\/FirstRun';$/m);
  });

  it('gate da key > fronteira de erro > Suspense com esqueleto > Outlet', () => {
    expect(main).toMatch(
      /<KeyFirstGate>\s*<RouteErrorBoundary>[\s\S]*?<Suspense fallback=\{<RouteSkeleton \/>\}>\s*<Outlet \/>\s*<\/Suspense>\s*<\/RouteErrorBoundary>\s*<\/KeyFirstGate>/,
    );
    expect(main).toMatch(/function RouteSkeleton\(\)[\s\S]*?<Skeleton /);
  });

  it('deploy novo com a aba aberta: recarrega UMA vez no vite:preloadError (sem laço)', () => {
    expect(main).toMatch(/addEventListener\('vite:preloadError'/);
    expect(main).toMatch(/pb\.chunkReloadAt/);
  });
});

describe('left#15 (2) o modo JEV fica fora do chunk de entrada', () => {
  it('/new: seletor de um módulo leve; formulário JEV lazy', () => {
    const nb = read('web/src/pages/NewBenchmark.tsx');
    expect(nb).toMatch(/from '\.\.\/jev\/benchKind'/);
    expect(nb).not.toMatch(/from '\.\.\/jev\/form'/);
    expect(nb).toMatch(/const NewJevRun = lazy\(/);
    expect(nb).not.toMatch(/^import \{ NewJevRun \}/m);
    const leve = read('web/src/jev/benchKind.ts');
    expect(leve).not.toMatch(/^import /m); // nada do motor
  });

  it('histórico: o JEV só baixa quando a aba JEV abre; a varredura de órfãs JEV é import dinâmico', () => {
    expect(read('web/src/pages/RunsList.tsx')).toMatch(/const JevHistory = lazy\(/);
    const main = read('web/src/main.tsx');
    expect(main).toMatch(/import\('\.\/jev\/api'\)[\s\S]*?startJevOrphanWatch\(\)/);
    expect(main).not.toMatch(/^import .* from '\.\/jev\/api';$/m);
  });

  it('o seletor leve decide igual ao que o form re-exporta', async () => {
    const leve = await import('../web/src/jev/benchKind.js');
    const form = await import('../web/src/jev/form.js');
    expect(form.initialBenchKind).toBe(leve.initialBenchKind);
    expect(form.BENCH_KIND_KEY).toBe(leve.BENCH_KIND_KEY);
  });
});

describe('left#15 (3) o pipeline carrega na hora de iniciar', () => {
  it('api.ts: orchestrator/trainer/variator só como tipo ou import dinâmico', () => {
    const api = read('web/src/api.ts');
    for (const m of ['orchestrator', 'trainer', 'variator']) {
      expect(api, m).not.toMatch(new RegExp(`^import (?!type)[^;]*from '\\./engine/${m}';`, 'm'));
    }
    expect(api).toMatch(/const \{ startRun \} = await loadOrchestrator\(\);/);
    expect(api).toMatch(/const \{ startTraining \} = await loadTrainer\(\);/);
  });

  it('nada rodando nesta aba: cancelar e "dá para cancelar?" respondem false sem carregar o motor', async () => {
    vi.resetModules();
    const api = await import('../web/src/api.js');
    expect(api.canCancelRun('run-x')).toBe(false);
    expect(api.canCancelSession('sessao-x')).toBe(false);
    expect(api.cancelRun('run-x')).toBe(false);
    expect(api.cancelSession('sessao-x')).toBe(false);
    vi.resetModules();
  });
});

describe('left#15 (4) uma cópia do zod no bundle', () => {
  it('vite.config deduplica o zod (o motor em src/ resolvia a cópia da raiz)', () => {
    expect(read('web/vite.config.ts')).toMatch(/dedupe: \['zod'\]/);
  });
});
