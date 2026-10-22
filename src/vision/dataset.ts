// BENCHMARK DE VISÃO — lado NODE do dataset: leitura do manifesto, verificação
// da imagem por sha256 e o data URL que vai ao modelo.
//
// O diretório é `src/data/vision/` (via `PKG_DATA_DIR`, nunca `process.cwd()`):
// o tarball publicado leva o manifesto, o HTML dos cenários, os assets dos
// frameworks e as imagens — o CLI instalado roda o MESMO dataset do repositório.
//
// A verificação é a mesma do `--dry-run` e do `vision dataset verify`: byte a
// byte, sem confiar em tamanho. Uma imagem divergente é dataset adulterado,
// não "cache velho".

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { PKG_DATA_DIR } from '../paths.js';
import {
  datasetHash,
  parseVisionDataset,
  selectScenes,
  summarizeDataset,
  VisionDatasetError,
  type DatasetFilters,
  type VisionDataset,
  type VisionDatasetSummary,
  type VisionScene,
} from '../engine/vision/index.js';

export const VISION_DATASET_DIRNAME = 'vision';
export const VISION_MANIFEST = 'dataset@1.json';

/** Raiz do dataset versionado que viaja no pacote. */
export function visionDataDir(): string {
  return path.join(PKG_DATA_DIR, VISION_DATASET_DIRNAME);
}

export interface LoadedVisionDataset {
  dataset: VisionDataset;
  root: string;
  hash: string;
  path: string;
}

/** Lê e valida o manifesto; lança `VisionDatasetError` com TODAS as issues. */
export async function loadVisionDataset(root: string = visionDataDir()): Promise<LoadedVisionDataset> {
  const arquivo = path.join(root, VISION_MANIFEST);
  let texto: string;
  try {
    texto = await fs.readFile(arquivo, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new VisionDatasetError(
        `manifesto do dataset de visão não encontrado em ${arquivo}.`,
        ['instale o pacote completo (src/data/vision/dataset@1.json) ou rode `npm run vision:build`.'],
      );
    }
    throw err;
  }
  let cru: unknown;
  try {
    cru = JSON.parse(texto) as unknown;
  } catch (err) {
    throw new VisionDatasetError(`manifesto do dataset de visão não é JSON válido: ${(err as Error).message}`);
  }
  const { dataset, issues } = parseVisionDataset(cru);
  if (parsedComErros(dataset, issues)) {
    throw new VisionDatasetError(
      `dataset de visão inválido (${issues.length} problema(s)): ${issues.slice(0, 3).join('; ')}`,
      issues,
    );
  }
  const ds = dataset!;
  return { dataset: ds, root, hash: datasetHash(ds), path: arquivo };
}

function parsedComErros(dataset: VisionDataset | null, issues: string[]): boolean {
  return dataset === null || issues.length > 0;
}

export interface VisionVerifyResult {
  ok: boolean;
  root: string;
  path: string;
  hash: string | null;
  summary: VisionDatasetSummary | null;
  issues: string[];
  /** Arquivos conferidos (imagem + código por cenário). */
  checked: number;
}

/** Confere schema, ids, caixas, tarefas, imagens (sha256) e código-fonte. */
export async function verifyVisionDataset(root: string = visionDataDir()): Promise<VisionVerifyResult> {
  const issues: string[] = [];
  let loaded: LoadedVisionDataset | null = null;
  try {
    loaded = await loadVisionDataset(root);
  } catch (err) {
    if (err instanceof VisionDatasetError) {
      return {
        ok: false,
        root,
        path: path.join(root, VISION_MANIFEST),
        hash: null,
        summary: null,
        issues: err.issues.length > 0 ? err.issues : [err.message],
        checked: 0,
      };
    }
    throw err;
  }
  let checked = 0;
  for (const scene of loaded.dataset.scenes) {
    const img = path.join(root, scene.image.file);
    try {
      const bytes = await fs.readFile(img);
      checked += 1;
      const sha = createHash('sha256').update(bytes).digest('hex');
      if (sha !== scene.image.sha256) {
        issues.push(`cenário "${scene.id}": sha256 da imagem diverge (manifesto ${scene.image.sha256.slice(0, 12)}…, disco ${sha.slice(0, 12)}…)`);
      }
      if (bytes.byteLength !== scene.image.bytes) {
        issues.push(`cenário "${scene.id}": tamanho da imagem diverge (manifesto ${scene.image.bytes}, disco ${bytes.byteLength})`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') issues.push(`cenário "${scene.id}": imagem ausente (${scene.image.file})`);
      else throw err;
    }
    try {
      const html = await fs.readFile(path.join(root, scene.code.file), 'utf8');
      checked += 1;
      if (!/<html/i.test(html)) issues.push(`cenário "${scene.id}": código não parece HTML (${scene.code.file})`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') issues.push(`cenário "${scene.id}": código ausente (${scene.code.file})`);
      else throw err;
    }
  }
  return {
    ok: issues.length === 0,
    root,
    path: loaded.path,
    hash: loaded.hash,
    summary: summarizeDataset(loaded.dataset),
    issues,
    checked,
  };
}

/** Cenários do dataset pelos filtros (mesma seleção determinística do engine). */
export function selectVisionScenes(
  dataset: VisionDataset,
  filters: DatasetFilters = {},
): { scenes: VisionScene[]; unknownSceneIds: string[]; unknownFamilies: string[] } {
  return selectScenes(dataset, filters);
}

const imageCache = new Map<string, Promise<string>>();

/** Imagem do cenário como data URL PNG (o formato que vai ao provedor). */
export function sceneImageDataUrl(root: string, scene: VisionScene): Promise<string> {
  const arquivo = path.join(root, scene.image.file);
  const cache = imageCache.get(arquivo);
  if (cache) return cache;
  const p = fs.readFile(arquivo).then((bytes) => `data:image/png;base64,${bytes.toString('base64')}`);
  imageCache.set(arquivo, p);
  return p;
}

/** Fonte HTML do cenário (para `vision dataset show --code`). */
export async function sceneSource(root: string, scene: VisionScene): Promise<string> {
  return fs.readFile(path.join(root, scene.code.file), 'utf8');
}

/** Limpa o cache de imagens (testes / troca de dataset). */
export function resetSceneImageCache(): void {
  imageCache.clear();
}
