// Benchmark de visão — DATASET no navegador.
//
// O manifesto e as imagens são servidos de `/vision/…` (cópia sincronizada de
// `src/data/vision/` pelo `scripts/vision-web-assets.mjs`). O parse/validação é
// o MESMO do Node (`parseVisionDataset`, fonte única em src/engine/vision).
// A imagem vira data URL (o gateway aceita `data:image/…`) com cache por cena.

import {
  datasetHash,
  parseVisionDataset,
  type VisionDataset,
  type VisionScene,
} from '../engine/vision';

export const VISION_WEB_ROOT = '/vision';

export class VisionDatasetLoadError extends Error {
  readonly code = 'vision-dataset-load';
  constructor(message: string) {
    super(message);
    this.name = 'VisionDatasetLoadError';
  }
}

let cache: Promise<{ dataset: VisionDataset; hash: string }> | null = null;

/** Carrega e VALIDA o manifesto de `/vision/dataset@1.json` (cacheado). */
export function loadVisionDataset(): Promise<{ dataset: VisionDataset; hash: string }> {
  cache ??= (async () => {
    let res: Response;
    try {
      res = await fetch(`${VISION_WEB_ROOT}/dataset@1.json`, { cache: 'no-cache' });
    } catch {
      throw new VisionDatasetLoadError('não consegui buscar o dataset de visão (rede?).');
    }
    if (!res.ok) {
      throw new VisionDatasetLoadError(
        `dataset de visão não está no build (HTTP ${res.status}). Rode \`npm run vision:build\` e recarregue.`,
      );
    }
    const cru = (await res.json()) as unknown;
    const { dataset, issues } = parseVisionDataset(cru);
    if (!dataset || issues.length > 0) {
      throw new VisionDatasetLoadError(`dataset de visão inválido: ${issues.slice(0, 3).join('; ')}`);
    }
    return { dataset, hash: datasetHash(dataset) };
  })();
  return cache;
}

/** Limpa o cache (testes / novo build). */
export function resetVisionDatasetCache(): void {
  cache = null;
  imagens.clear();
}

export function sceneImageUrl(scene: VisionScene): string {
  return `${VISION_WEB_ROOT}/${scene.image.file}`;
}

const imagens = new Map<string, Promise<string>>();

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('falha ao ler a imagem'));
    reader.readAsDataURL(blob);
  });
}

/** Imagem do cenário como data URL (cache por caminho — a run não rebaixa). */
export function sceneImageDataUrl(scene: VisionScene): Promise<string> {
  const url = sceneImageUrl(scene);
  let p = imagens.get(url);
  if (!p) {
    p = fetch(url, { cache: 'force-cache' })
      .then((res) => {
        if (!res.ok) throw new Error(`imagem do cenário ${scene.id} não encontrada (HTTP ${res.status})`);
        return res.blob();
      })
      .then(blobToDataUrl);
    imagens.set(url, p);
  }
  return p;
}
