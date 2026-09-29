// IMPL-113 (R-08:REC-8) — persistência das amostras estimado × real entre
// PROCESSOS (só Node: CLI, servidor, MCP). O gateway registra uma amostra por
// chamada MEDIDA (`recordCostSample`, `usage.cost`); antes elas viviam só num
// anel em memória, cada `prompt-builder` nascia vazio e a faixa publicada pela
// estimativa era SEMPRE o prior (0,30/0,75 fixos). Aqui:
//   - no arranque, as amostras salvas (JSONL no diretório de dados) viram a
//     calibração padrão de `estimateRunCost` (`setCostCalibrationProvider`);
//   - as novas amostras do processo são anexadas ao arquivo (em lote, com
//     flush na saída), com teto de linhas — as últimas bastam para quantis.
// O arquivo não tem dado do usuário: papel, modelo, família, esforço, tokens
// de raciocínio e os dois valores em USD (estimado e cobrado).
//
// ⚠️ Não importe do web: toca `node:fs`. A SPA persiste no navegador pelo shim
// `web/src/engine/openrouter.ts`.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { subscribeCostSamples, type CostCalibrationSample } from './openrouter.js';
import { CostCalibration, setCostCalibrationProvider } from './estimate.js';
import { COST_ROLES } from './types.js';

/** Nome do arquivo de amostras dentro do diretório de dados. */
export const COST_SAMPLES_FILE = 'cost-samples.jsonl';
/** Teto de amostras mantidas (arquivo e memória). */
export const COST_SAMPLES_KEEP = 2000;

/** Amostra lida do disco é aceita só com a forma certa (linha lixo = ignorada). */
function isSample(v: unknown): v is CostCalibrationSample {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.role === 'string' &&
    (COST_ROLES as readonly string[]).includes(s.role) &&
    typeof s.modelId === 'string' &&
    typeof s.estimatedUsd === 'number' &&
    Number.isFinite(s.estimatedUsd) &&
    typeof s.actualUsd === 'number' &&
    Number.isFinite(s.actualUsd)
  );
}

/** Lê as amostras salvas (as últimas `keep`); arquivo ausente/ilegível = nenhuma. */
export function loadCostSamples(file: string, keep = COST_SAMPLES_KEEP): CostCalibrationSample[] {
  if (!existsSync(file)) return [];
  let txt: string;
  try {
    txt = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: CostCalibrationSample[] = [];
  for (const linha of txt.split('\n')) {
    const t = linha.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t) as unknown;
      if (isSample(v)) out.push(v);
    } catch {
      // linha corrompida (escrita interrompida): ignora só ela
    }
  }
  return out.slice(-keep);
}

export interface CostSamplesPersistence {
  /** Grava agora o que estiver pendente (idempotente). */
  flush(): void;
  /** Para de assinar/gravar e desliga o provedor de calibração. */
  dispose(): void;
  /** Quantas amostras a calibração padrão enxerga agora. */
  size(): number;
}

/**
 * Liga a persistência no diretório `dataDir`: carrega o histórico, registra a
 * calibração padrão da estimativa e anexa as novas amostras (lote de ~2 s e
 * flush síncrono na saída do processo). Falha de disco NUNCA derruba o CLI —
 * a calibração segue em memória.
 */
export function installCostSamplesPersistence(
  dataDir: string | (() => string),
  opts: { keep?: number; flushDelayMs?: number; exitHook?: boolean } = {},
): CostSamplesPersistence {
  const keep = Math.max(10, opts.keep ?? COST_SAMPLES_KEEP);
  // Diretório resolvido PREGUIÇOSAMENTE: o CLI instala no arranque, antes de
  // cada comando resolver o `--home` (buildContext → setDataDir).
  const fileOf = (): string => join(typeof dataDir === 'function' ? dataDir() : dataDir, COST_SAMPLES_FILE);
  let carregado = false;
  let amostras: CostCalibrationSample[] = [];
  const garantirCarga = (): void => {
    if (carregado) return;
    carregado = true;
    // O histórico do disco vem ANTES das amostras que este processo já viu.
    amostras = [...loadCostSamples(fileOf(), keep), ...amostras].slice(-keep);
  };
  let pendentes: CostCalibrationSample[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (pendentes.length === 0) return;
    // Carrega o histórico ANTES de anexar: senão a carga posterior leria de
    // novo (do disco) as amostras deste processo que já estão na memória.
    garantirCarga();
    const lote = pendentes;
    pendentes = [];
    const file = fileOf();
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, lote.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');
      // Compacta quando o arquivo passa do dobro do teto (reescreve as últimas).
      const noDisco = loadCostSamples(file, Number.MAX_SAFE_INTEGER);
      if (noDisco.length > keep * 2) {
        writeFileSync(file, noDisco.slice(-keep).map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');
      }
    } catch {
      // disco cheio/sem permissão: a calibração deste processo segue em memória
    }
  };

  const cancelar = subscribeCostSamples((s) => {
    amostras = [...amostras, s].slice(-keep);
    pendentes.push(s);
    if (timer === undefined) {
      timer = setTimeout(flush, opts.flushDelayMs ?? 2000);
      timer.unref?.();
    }
  });
  setCostCalibrationProvider(() => {
    garantirCarga();
    return amostras.length > 0 ? CostCalibration.fromJSON(amostras) : undefined;
  });
  const onExit = (): void => flush();
  if (opts.exitHook !== false) process.on('exit', onExit);

  return {
    flush,
    size: () => {
      garantirCarga();
      return amostras.length;
    },
    dispose: () => {
      flush();
      cancelar();
      process.off('exit', onExit);
      setCostCalibrationProvider(undefined);
    },
  };
}
