// Config FAIL-CLOSED (IMPL-093, R-12:REC-2) — a parte PURA, sem CLI nem disco.
//
// Os schemas zod são `strip`: chave desconhecida é descartada EM SILÊNCIO e um
// typo como "trainig" sumia do config sem ninguém saber (nota/custo mudavam).
// O circuito fecha comparando a ÁRVORE LIDA com a árvore PARSEADA: toda chave
// de entrada que não sobrevive ao parse foi descartada pelo schema — quem
// chama recusa citando o caminho JSON e o "você quis dizer".
//
// Mora fora de `src/cli/` porque a API HTTP (`src/routes.ts`, POST /runs e
// /sessions) aplica a MESMA regra do CLI e do MCP — um único lugar decide o
// que é chave desconhecida e o que se sugere.
//
// Sugestão (extra#0): o candidato sai das chaves VÁLIDAS do MESMO objeto,
// lidas do JSON Schema do dialeto (o mesmo `toJSONSchema` do `config schema`)
// — nunca a própria chave errada ecoada de volta. Antes, `effort.contestant`
// sugeria "contestant" (a chave existe em `models`, não em `effort`).

import { z } from 'zod';
import { arenaConfigSchema, ARENA_CONFIG_FORMAT } from './configFile.js';
import { runConfigSchema } from './runConfigSchema.js';

/**
 * Distância de edição — Damerau-Levenshtein restrita (OSA): inserção,
 * remoção, troca E TRANSPOSIÇÃO de vizinhas custam 1. A transposição é o typo
 * mais comum (`shwo` → `show`, `trainnig`); na Levenshtein pura ela custava 2
 * e a palavra de 4 letras ficava sem sugestão. Entradas curtas (nomes de
 * flag/comando/chave): O(n·m) em memória é irrelevante.
 */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const custo = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + custo);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/**
 * Candidato mais próximo de `input`, ou `undefined` se nenhum é plausível
 * (tolerância: 1 edição até 4 letras, 2 acima; ou prefixo com 3+ letras).
 */
export function closestMatch(input: string, candidates: readonly string[]): string | undefined {
  const alvo = input.toLowerCase();
  if (!alvo) return undefined;
  let melhor: { c: string; d: number } | undefined;
  for (const c of candidates) {
    const d = editDistance(alvo, c.toLowerCase());
    if (!melhor || d < melhor.d) melhor = { c, d };
  }
  if (!melhor) return undefined;
  const tolerancia = alvo.length <= 4 ? 1 : 2;
  if (melhor.d <= tolerancia) return melhor.c;
  const prefixo = alvo.length >= 3 ? candidates.find((c) => c.toLowerCase().startsWith(alvo)) : undefined;
  return prefixo;
}

export interface UnknownKeyIssue {
  /** Caminho JSON da chave (ex.: `training.trainig`). */
  path: string;
  key: string;
  /** Chave VÁLIDA do mesmo objeto mais plausível (did-you-mean), quando existe. */
  suggestion: string | null;
}

/**
 * Chaves aceitas e IGNORADAS de propósito pelo parser (não são typo):
 * descontinuada com aviso (IMPL-012) e alias legado renomeado pelo preprocess.
 */
export const CHAVES_LEGADO_ACEITAS: readonly string[] = ['training.halving', 'judgeModelId'];

/**
 * Chaves canônicas dos três dialetos — FALLBACK da sugestão quando o objeto
 * não tem schema conhecido (ex.: arena-agent-config@1). A recusa vem da
 * comparação entrada × saída do parse, então uma chave de menos aqui apenas
 * deixa a sugestão mais pobre, nunca aprova nada errado.
 */
const CHAVES_CANONICAS: readonly string[] = [
  // raiz (arena-config@1 / arena-agent-config@1 / RunConfig cru)
  'format', 'mode', 'theme', 'scenarioBrief', 'languages', 'stages', 'scenarios', 'prompt', 'models', 'effort',
  'variation', 'training', 'judging', 'limits', 'compliance', 'piiMode', 'allowPii', 'agent',
  'duels', 'repeats', 'finalists', 'budgetUsd',
  // RunConfig cru
  'datagenModelId', 'judgeModelIds', 'judgeModelId', 'contestantModelId', 'basePrompt',
  'techniqueIds', 'manualVariants', 'temperature', 'promptGroup', 'promptId', 'competitorModelIds',
  'competitorConfigs', 'competitorAnchor', 'customStages', 'scenarioSeed', 'reasoning', 'referenceModelId',
  'referenceJudging', 'promptOptimization', 'optimizerModelId', 'judgePasses', 'maxPricePerMTok',
  'maxOutputTokens', 'timeoutMs', 'concurrency',
  // juiz JEV (motor de julgamento + config do modelo de decisão)
  'judgeEngine', 'jevJudge', 'engine', 'jev', 'decisionModelId', 'autoBand', 'hitlBand',
  'rubricQuestions',
  // cenário / etapa
  'id', 'question', 'productContext', 'maxTokens', 'rubric', 'reference', 'expected', 'labelSet',
  'origin', 'agentTask', 'tier', 'dimensionTags', 'language', 'persona', 'difficultyEstimate',
  'invarianceGroup', 'adversarialCategory', 'turnLabel', 'basePromptHash',
  // biblioteca / prompt
  'from', 'profile', 'ids', 'text', 'generateFrom', 'contracts', 'group',
  // models
  'datagen', 'judges', 'contestant', 'competitors', 'rewriter', 'model', 'modelId', 'reasoningLevel',
  // effort / variation / training / judging
  'competitor', 'judge', 'optimize', 'techniques', 'iterations', 'minGain',
  'holdoutRatio', 'feedbackDriven', 'reflection', 'paretoPool', 'passes', 'dossierTokens',
  // agente
  'executor', 'executorVersion', 'install', 'provider', 'promptMode', 'thinking', 'tools',
  'repetitions', 'maxParallel', 'isolation', 'kind', 'keepWorkspace', 'image', 'runtime',
  'maxTurns', 'maxCostUsd', 'maxOutputBytes', 'maxDiffBytes',
  'repo', 'setup', 'files', 'verify', 'forbiddenPaths', 'rebuild', 'detectors', 'contextFiles',
  'url', 'path', 'ref', 'shallow', 'cmd', 'content', 'label', 'expectExit', 'weight',
  'lockfiles', 'protect',
  // contracts (IMPL-011) + preço
  'neverBreak', 'placeholders', 'minLengthRatio', 'judgeDiff', 'canaries', 'input', 'completion',
];

/**
 * Sinônimos do domínio que a distância de edição não pega: o papel "sob
 * teste" é `contestant` em `models` e `competitor` em `effort`/`reasoning`;
 * `judges` (lista) × `judge` (esforço). Só vale quando o alvo é chave VÁLIDA
 * do objeto em questão.
 */
const SINONIMOS: Readonly<Record<string, readonly string[]>> = {
  contestant: ['competitor', 'contestantModelId'],
  contestants: ['competitor', 'competitors'],
  competitor: ['contestant', 'competitors'],
  competitors: ['competitor', 'competitorModelIds'],
  judges: ['judge', 'judgeModelIds'],
  judge: ['judges', 'judgeModelIds'],
  generator: ['datagen'],
  dataset: ['scenarios'],
  cenarios: ['scenarios'],
  gabarito: ['reference'],
  optimizer: ['rewriter', 'optimizerModelId'],
};

// --- JSON Schema do dialeto: chaves válidas por objeto ------------------------

type JsonSchemaNode = Record<string, unknown>;

interface SchemaCtx {
  root: JsonSchemaNode;
}

let cacheArena: SchemaCtx | null | undefined;
let cacheRun: SchemaCtx | null | undefined;

function gerar(schema: z.ZodType): SchemaCtx | null {
  try {
    const root = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchemaNode;
    return { root };
  } catch {
    // Sem JSON Schema a sugestão cai no fallback — a recusa não depende disto.
    return null;
  }
}

/** JSON Schema do dialeto do JSON lido (`format` decide; sem `format` = RunConfig cru). */
function schemaDoDialeto(raw: unknown): SchemaCtx | null {
  const formato = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).format : undefined;
  if (formato === ARENA_CONFIG_FORMAT) {
    if (cacheArena === undefined) cacheArena = gerar(arenaConfigSchema);
    return cacheArena;
  }
  if (formato === undefined) {
    if (cacheRun === undefined) cacheRun = gerar(runConfigSchema);
    return cacheRun;
  }
  // arena-agent-config@1/@2 (schema não exportado) ou formato estranho: fallback.
  return null;
}

function resolverRef(ctx: SchemaCtx, node: JsonSchemaNode): JsonSchemaNode {
  let atual = node;
  for (let guarda = 0; guarda < 16; guarda++) {
    const ref = atual.$ref;
    if (typeof ref !== 'string') return atual;
    if (ref === '#') {
      atual = ctx.root;
      continue;
    }
    const m = /^#\/\$defs\/(.+)$/u.exec(ref);
    const defs = ctx.root.$defs as Record<string, JsonSchemaNode> | undefined;
    const alvo = m && defs ? defs[m[1]] : undefined;
    if (!alvo) return atual;
    atual = alvo;
  }
  return atual;
}

/** O nó e todos os ramos de união/intersecção (anyOf/oneOf/allOf), com $ref resolvido. */
function ramos(ctx: SchemaCtx, node: JsonSchemaNode | undefined, out: JsonSchemaNode[] = [], prof = 0): JsonSchemaNode[] {
  if (!node || prof > 12) return out;
  const n = resolverRef(ctx, node);
  out.push(n);
  for (const k of ['anyOf', 'oneOf', 'allOf'] as const) {
    const lista = n[k];
    if (Array.isArray(lista)) for (const b of lista) ramos(ctx, b as JsonSchemaNode, out, prof + 1);
  }
  return out;
}

/** Chaves declaradas no objeto (união de todos os ramos). */
function chavesDoNo(ctx: SchemaCtx, node: JsonSchemaNode | undefined): string[] {
  const chaves = new Set<string>();
  for (const r of ramos(ctx, node)) {
    const props = r.properties;
    if (props && typeof props === 'object') for (const k of Object.keys(props)) chaves.add(k);
  }
  return [...chaves];
}

/** Nó do filho `key` (união dos ramos que o declaram). */
function filhoDoNo(ctx: SchemaCtx, node: JsonSchemaNode | undefined, key: string): JsonSchemaNode | undefined {
  const alvos: JsonSchemaNode[] = [];
  for (const r of ramos(ctx, node)) {
    const props = r.properties as Record<string, JsonSchemaNode> | undefined;
    if (props && props[key]) alvos.push(props[key]);
  }
  if (alvos.length === 0) return undefined;
  return alvos.length === 1 ? alvos[0] : { anyOf: alvos };
}

/** Nó dos itens de uma lista (união dos ramos que são array). */
function itensDoNo(ctx: SchemaCtx, node: JsonSchemaNode | undefined): JsonSchemaNode | undefined {
  const alvos: JsonSchemaNode[] = [];
  for (const r of ramos(ctx, node)) {
    if (r.items && typeof r.items === 'object' && !Array.isArray(r.items)) alvos.push(r.items as JsonSchemaNode);
  }
  if (alvos.length === 0) return undefined;
  return alvos.length === 1 ? alvos[0] : { anyOf: alvos };
}

/**
 * "Você quis dizer": entre as chaves VÁLIDAS do objeto (do schema; sem schema,
 * as irmãs que sobreviveram ao parse + as canônicas), NUNCA a própria chave.
 * Sinônimo do domínio primeiro (contestant → competitor em `effort`); depois
 * a distância de edição.
 */
function sugestaoDeChave(key: string, validas: readonly string[] | null, irmaos: readonly string[]): string | null {
  const semEco = (xs: readonly string[]): string[] => [...new Set(xs)].filter((c) => c !== key);
  if (validas && validas.length > 0) {
    const cands = semEco(validas);
    for (const s of SINONIMOS[key] ?? []) if (cands.includes(s)) return s;
    return closestMatch(key, cands) ?? null;
  }
  const cands = semEco([...irmaos, ...CHAVES_CANONICAS]);
  for (const s of SINONIMOS[key] ?? []) if (irmaos.includes(s)) return s;
  return closestMatch(key, cands) ?? null;
}

function walkUnknownKeys(
  raw: unknown,
  parsed: unknown,
  base: string,
  allow: ReadonlySet<string>,
  ctx: SchemaCtx | null,
  node: JsonSchemaNode | undefined,
  out: UnknownKeyIssue[],
): void {
  if (Array.isArray(raw)) {
    if (!Array.isArray(parsed)) return;
    const itens = ctx ? itensDoNo(ctx, node) : undefined;
    raw.forEach((item, i) => walkUnknownKeys(item, parsed[i], `${base}[${i}]`, allow, ctx, itens, out));
    return;
  }
  if (typeof raw !== 'object' || raw === null) return;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
  const r = raw as Record<string, unknown>;
  const p = parsed as Record<string, unknown>;
  const irmaos = Object.keys(p);
  const validas = ctx && node ? chavesDoNo(ctx, node) : null;
  for (const [k, v] of Object.entries(r)) {
    const caminho = base ? `${base}.${k}` : k;
    if (allow.has(caminho)) continue;
    if (!(k in p)) {
      out.push({ path: caminho, key: k, suggestion: sugestaoDeChave(k, validas, irmaos) });
      continue;
    }
    walkUnknownKeys(v, p[k], caminho, allow, ctx, ctx ? filhoDoNo(ctx, node, k) : undefined, out);
  }
}

/**
 * Chaves do JSON de entrada que o parser descartaria em silêncio (comparação
 * entrada × saída do parse). Pura: testável sem disco nem CLI. O dialeto (e o
 * schema da sugestão) sai do `format` do próprio JSON.
 */
export function unknownKeyIssues(
  raw: unknown,
  parsed: unknown,
  allow: readonly string[] = CHAVES_LEGADO_ACEITAS,
): UnknownKeyIssue[] {
  const out: UnknownKeyIssue[] = [];
  const ctx = schemaDoDialeto(raw);
  walkUnknownKeys(raw, parsed, '', new Set(allow), ctx, ctx?.root, out);
  return out;
}

/** Mensagem PT-BR da recusa (a MESMA no CLI, no MCP e na API HTTP). */
export function unknownKeysMessage(issues: readonly UnknownKeyIssue[]): string {
  const citadas = issues
    .slice(0, 5)
    .map((i) => `"${i.path}"${i.suggestion ? ` (você quis dizer "${i.suggestion}"?)` : ''}`)
    .join('; ');
  const mais = issues.length > 5 ? ` (+${issues.length - 5})` : '';
  return `Chave(s) desconhecida(s) no config: ${citadas}${mais}. Nada é descartado em silêncio.`;
}
