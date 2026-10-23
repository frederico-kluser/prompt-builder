// BENCHMARK DE VISÃO — gerador do dataset (passo de MANUTENÇÃO, não do CLI).
//
// Uso: `npm run vision:build` (ou `npx tsx src/vision/build/index.ts --only bootstrap`).
// Precisa de um Chromium (o do `playwright-core` ou `VISION_CHROME=<executável>`).
//
// O que ele faz, por cenário:
//   1. grava o HTML em `src/data/vision/scenes/<família>/<id>.html` (o "código
//      em si" que o dataset promete guardar);
//   2. renderiza em 1920×1080 e grava `images/<id>.png`;
//   3. extrai do DOM a verdade (caixa, nome, tipo) e valida a cobertura —
//      qualquer controle interativo sem `data-vision-id` ABORTA o build;
//   4. monta o manifesto `dataset@1.json` com sha256/tamanho de cada imagem.
//
// O dataset NÃO é gerado em tempo de run: ele é versionado, pinado por hash e
// cresce por commits. Aqui é onde ele nasce.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PKG_DATA_DIR } from '../../paths.js';
import {
  labelMatches,
  normalizeType,
  VISION_DATASET_FORMAT,
  VISION_VIEWPORT,
  type VisionAssetRef,
  type VisionDataset,
  type VisionScene,
  type VisionActionTask,
} from '../../engine/vision/index.js';
import { SCENES } from './scenes/index.js';
import { ASSETS } from './assets.js';
import { openBrowserForBuild, renderScene } from './render.js';
import { buildSceneProbes } from './probes.js';
import type { SceneSpec } from './scene-types.js';

export const VISION_DATA_ROOT = path.join(PKG_DATA_DIR, 'vision');
const BUILD_DIR = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = 'dataset@1.json';
const GENERATOR = 'vision-build@2';

interface Flags {
  only: string[] | null;
  version: string | null;
  fresh: boolean;
  checkDrift: boolean;
}

function flags(argv: string[]): Flags {
  const only = valor(argv, '--only');
  const version = valor(argv, '--version');
  return {
    only: only ? only.split(',').map((s) => s.trim()).filter(Boolean) : null,
    version: version ?? null,
    fresh: argv.includes('--fresh'),
    checkDrift: argv.includes('--check-drift'),
  };
}

function valor(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function lerManifestAtual(root: string): Promise<VisionDataset | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(root, MANIFEST), 'utf8')) as VisionDataset;
  } catch {
    return null;
  }
}

/** Fonte única do build: escreve, renderiza, extrai e monta o manifesto. */
export async function buildVisionDataset(argv: string[] = process.argv.slice(2), root = VISION_DATA_ROOT): Promise<VisionDataset> {
  const opts = flags(argv);
  const especificadas = SCENES.filter((s) => !opts.only || opts.only.includes(s.family));
  if (especificadas.length === 0) {
    throw new Error(`nenhuma família em --only (${opts.only?.join(', ')}) casa as definidas: ${[...new Set(SCENES.map((s) => s.family))].join(', ')}`);
  }
  const ids = new Set<string>();
  for (const s of especificadas) {
    if (ids.has(s.id)) throw new Error(`cenário duplicado no build: ${s.id}`);
    ids.add(s.id);
  }

  await fs.mkdir(path.join(root, 'scenes'), { recursive: true });
  await fs.mkdir(path.join(root, 'images'), { recursive: true });

  // 1) HTML (o código do cenário vai para o dataset ANTES do render).
  for (const spec of especificadas) {
    const destino = path.join(root, 'scenes', spec.family, `${spec.id}.html`);
    await fs.mkdir(path.dirname(destino), { recursive: true });
    const html = spec.html ?? (await fs.readFile(path.join(BUILD_DIR, spec.htmlFile!), 'utf8'));
    await fs.writeFile(destino, html, 'utf8');
  }

  // 2+3) render + extração.
  const browser = await openBrowserForBuild();
  const scenes: VisionScene[] = [];
  const problemas: string[] = [];
  try {
    for (const spec of especificadas) {
      const htmlPath = path.join(root, 'scenes', spec.family, `${spec.id}.html`);
      const pngPath = path.join(root, 'images', `${spec.id}.png`);
      process.stderr.write(`· ${spec.id}: renderizando…\n`);
      const extraido = await renderScene(browser, htmlPath, pngPath, { autoPrefix: spec.autoAnnotate });
      const issues = [...extraido.issues];
      if (issues.length > 0) {
        problemas.push(...issues.map((i) => `${spec.id}: ${i}`));
        continue;
      }
      const imagens = await fs.readFile(pngPath);
      const scene = montarCena(spec, extraido.elements, imagens, issues);
      // Variantes pinadas junto com a tela: downscales (resolução) e
      // overlays/crops (grade). A prova continua sendo a imagem base.
      const probes = await buildSceneProbes(browser, pngPath, root, spec.id, scene.image);
      scene.probes = probes;
      problemas.push(...issues.map((i) => `${spec.id}: ${i}`));
      scenes.push(scene);
      process.stderr.write(
        `   ${scene.elements.length} elemento(s) · ${scene.tasks.length} tarefa(s) · ${(imagens.byteLength / 1024).toFixed(0)} KiB` +
          ` · ${probes.resolutions.length} resolução(ões) · ${probes.overlays.length} overlay(s)\n`,
      );
    }
  } finally {
    await browser.close();
  }
  if (problemas.length > 0) {
    throw new Error(`build abortado — ${problemas.length} problema(s) de anotação/cobertura:\n  ${problemas.slice(0, 40).join('\n  ')}`);
  }

  // 4) manifesto (versão/createdAt preservados, salvo --version/--fresh).
  const anterior = opts.fresh ? null : await lerManifestAtual(root);
  // Build incremental (`--only`): mantém os cenários das famílias não
  // re-renderizadas — o dataset é a UNIÃO, nunca o último build.
  const ordem = new Map(SCENES.map((s, i) => [s.id, i]));
  const idsNovos = new Set(scenes.map((s) => s.id));
  const mantidos = (anterior?.scenes ?? []).filter(
    (s) => !idsNovos.has(s.id) && ordem.has(s.id),
  );
  const merged = [...mantidos, ...scenes].sort((a, b) => (ordem.get(a.id) ?? 0) - (ordem.get(b.id) ?? 0));
  const familias = new Set(merged.map((s) => s.family));
  const assets: VisionAssetRef[] = ASSETS.filter((a) => familias.has(a.family));
  const dataset: VisionDataset = {
    format: VISION_DATASET_FORMAT,
    version: opts.version ?? anterior?.version ?? '0.1.0',
    generator: GENERATOR,
    createdAt: opts.fresh || !anterior ? new Date().toISOString() : anterior.createdAt,
    viewport: { ...VISION_VIEWPORT },
    scenes: merged,
    assets,
  };
  await fs.writeFile(path.join(root, MANIFEST), `${JSON.stringify(dataset, null, 2)}\n`, 'utf8');
  return dataset;
}

/** Remove o nome da ligadura do ícone no início do rótulo (Material Web). */
function limparLigadura(s: string | null): string | null {
  if (!s) return s;
  const m = /^[a-z][a-z0-9_]{0,24}(?=\p{Lu})/u.exec(s);
  return m ? s.slice(m[0].length) : s;
}

function montarCena(
  spec: SceneSpec,
  extraidos: Awaited<ReturnType<typeof renderScene>>['elements'],
  imagem: Buffer,
  issues: string[],
): VisionScene {
  const elementos = extraidos.map((e, i) => ({
    id: e.visionId,
    type: e.type,
    // A ligadura do ícone só existe no Material Web; em outras famílias um
    // rótulo como "iCloud Drive" perderia o "i".
    label: spec.family === 'material' ? limparLigadura(e.label) : e.label,
    iconDescription: e.iconDescription,
    ...(e.aliases.length > 0 ? { aliases: e.aliases } : {}),
    bbox: e.bbox,
    center: e.center,
    ...(e.state ? { state: e.state } : {}),
    ...(e.hint ? { hint: e.hint } : {}),
  }));
  const porId = new Map(elementos.map((e) => [e.id, e]));
  if (porId.size !== elementos.length) issues.push('ids duplicados na extração');
  for (const el of elementos) {
    if (el.type === 'other') issues.push(`${el.id}: tipo "other" — anote data-vision-type`);
    if (el.label === null && el.iconDescription === null) issues.push(`${el.id}: sem nome`);
  }
  const tasks: VisionActionTask[] = spec.tasks.map((t, i) => {
    let targetId = t.targetId;
    if (!targetId && t.target) {
      const candidatos = elementos.filter(
        (el) =>
          labelMatches(el.label, t.target!.label) ||
          (el.aliases ?? []).some((a) => labelMatches(a, t.target!.label)) ||
          labelMatches(el.iconDescription, t.target!.label),
      ).filter((el) => !t.target!.type || normalizeType(el.type) === normalizeType(t.target!.type));
      const idx = t.target.nth ?? 0;
      if (candidatos.length === 0) {
        issues.push(`tarefa ${i + 1}: alvo "${t.target.label}" não casou nenhum elemento`);
      } else if (candidatos.length > 1 && t.target.nth === undefined) {
        issues.push(
          `tarefa ${i + 1}: alvo "${t.target.label}" casou ${candidatos.length} (${candidatos
            .slice(0, 4)
            .map((c) => c.id)
            .join(', ')}); use nth`,
        );
      } else if (idx >= candidatos.length) {
        issues.push(`tarefa ${i + 1}: nth ${idx} fora do alcance de "${t.target.label}"`);
      } else {
        targetId = candidatos[idx]!.id;
      }
    }
    if (targetId && !porId.has(targetId)) {
      issues.push(`tarefa ${i + 1} aponta para "${targetId}", que não está no cenário`);
    }
    const semAlvo = t.action === 'scroll' || t.action === 'key';
    if (!semAlvo && !targetId) issues.push(`tarefa ${i + 1} (${t.action}) sem alvo`);
    if (semAlvo && (targetId || t.target)) issues.push(`tarefa ${i + 1} (${t.action}) não deve ter alvo`);
    return {
      id: `${spec.id}-a${i + 1}`,
      sceneId: spec.id,
      kind: 'action',
      instruction: t.instruction,
      expect: {
        action: t.action,
        ...(targetId ? { targetId } : {}),
        ...(t.text !== undefined ? { text: t.text } : {}),
      },
      ...(t.difficulty ? { difficulty: t.difficulty } : {}),
    } satisfies VisionActionTask;
  });
  return {
    id: spec.id,
    family: spec.family,
    title: spec.title,
    theme: spec.theme,
    viewport: { ...VISION_VIEWPORT },
    image: { file: `images/${spec.id}.png`, sha256: sha256(imagem), bytes: imagem.byteLength },
    code: { file: `scenes/${spec.family}/${spec.id}.html` },
    elements: elementos,
    tasks,
    ...(spec.tags ? { tags: spec.tags } : {}),
  };
}

/** `npm run vision:build` — imprime o resumo e o hash do manifesto. */
async function main(): Promise<void> {
  const dataset = await buildVisionDataset();
  const { datasetHash } = await import('../../engine/vision/dataset.js');
  const bytes = dataset.scenes.reduce((a, s) => a + s.image.bytes, 0);
  process.stderr.write(
    `\ndataset de visão ${dataset.version} — ${dataset.scenes.length} cenário(s) · ` +
      `${dataset.scenes.reduce((a, s) => a + s.elements.length, 0)} elemento(s) · ` +
      `${(bytes / 1024 / 1024).toFixed(2)} MiB de imagem\n` +
      `hash: ${datasetHash(dataset)}\n`,
  );
}

if (process.argv[1] && /vision[\\/]build[\\/]index\.(ts|js)$/u.test(process.argv[1])) {
  main().catch((err) => {
    process.stderr.write(`\nErro: ${(err as Error).message}\n`);
    process.exitCode = 1;
  });
}
