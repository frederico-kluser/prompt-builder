// Pacote JSON de cenários+gabaritos+prompt, exportado ao fim de uma run e
// importado numa run seguinte como seed (o datagen complementa com cenários
// novos). A validação (zod) NUNCA lança exceção: qualquer problema vira uma
// mensagem de erro em PT-BR legível, para a UI exibir sem derrubar nada.

import { z } from 'zod';
import { exactPairKey } from './dedup.js';
import { checkImportPii, type PiiImportCheck } from './engine/pii.js';
import { stageLabelIssues } from './engine/groundTruth.js';
import type { ScenarioPack, StageSpec } from './types.js';

/** Valor do campo `format` gravado ao EXPORTAR — versão do contrato. */
export const SCENARIO_PACK_FORMAT = 'prompt-builder-pack@1';

/**
 * Nome antigo do formato, de quando o projeto se chamava ai-benchmark. Continua
 * ACEITO na leitura: pacotes de cenários são arquivos que o usuário exporta,
 * guarda e compartilha — recusá-los por causa de uma troca de marca seria
 * quebrar dado alheio de graça. Só a escrita usa o nome novo.
 */
export const SCENARIO_PACK_FORMAT_LEGACY = 'ai-benchmark-pack@1';

const FORMATOS_ACEITOS = [SCENARIO_PACK_FORMAT, SCENARIO_PACK_FORMAT_LEGACY] as const;

// ----------------------------------------------------------------------------
// build
// ----------------------------------------------------------------------------

/** Monta o pacote exportável: ids `sc-<i+1>`, `exportedAt` ISO e `format` fixo. */
export function buildScenarioPack(input: {
  theme: string;
  prompt: { text: string; source: 'champion' | 'base'; label?: string };
  scenarios: StageSpec[];
}): ScenarioPack {
  return {
    format: SCENARIO_PACK_FORMAT,
    theme: input.theme,
    exportedAt: new Date().toISOString(),
    prompt: input.prompt,
    scenarios: input.scenarios.map((s, i) => ({ ...s, id: `sc-${i + 1}` })),
  };
}

// ----------------------------------------------------------------------------
// parse (validação zod do shape inteiro; nunca lança exceção)
// ----------------------------------------------------------------------------

// Mensagens inline já citam o nome do campo — o prefixo 'cenário N:' é
// acrescentado em descreverIssues a partir do path do issue.
const scenarioSchema = z.object({
  id: z.string('id obrigatório').min(1, 'id obrigatório'),
  question: z.string('question obrigatória').min(1, 'question obrigatória'),
  productContext: z.string('productContext deve ser texto').default(''),
  maxTokens: z
    .number('maxTokens deve ser número inteiro')
    .int('maxTokens deve ser número inteiro')
    .positive('maxTokens deve ser maior que zero')
    .max(16000, 'maxTokens não pode passar de 16000'),
  rubric: z.string('rubric deve ser texto').default(''),
  reference: z.string('reference deve ser texto').optional(),
  // Rotulo esperado (ground-truth): veredito deterministico sem juiz LLM.
  expected: z
    .union([
      z.string().min(1),
      z.array(z.string().min(1)).min(1),
      z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    ])
    .optional(),
  // Todos os rotulos validos (IMPL-003): obrigatorio com `expected` curto.
  labelSet: z
    .array(z.string('labelSet deve ser lista de textos').min(1, 'rótulo vazio em labelSet'), 'labelSet deve ser uma lista de rótulos')
    .min(1, 'labelSet não pode ser vazio')
    .max(200, 'labelSet não pode passar de 200 rótulos')
    .optional(),
  origin: z.enum(['ai', 'import'], "origin deve ser 'ai' ou 'import'").optional(),
});

const packSchema = z.object({
  format: z.union([z.literal(SCENARIO_PACK_FORMAT), z.literal(SCENARIO_PACK_FORMAT_LEGACY)]),
  theme: z.string('theme deve ser texto'),
  exportedAt: z.string('exportedAt deve ser texto'),
  prompt: z.object(
    {
      text: z.string('prompt.text obrigatório').min(1, 'prompt.text obrigatório'),
      source: z.enum(['champion', 'base'], "prompt.source deve ser 'champion' ou 'base'"),
      label: z.string('prompt.label deve ser texto').optional(),
    },
    'prompt deve ser um objeto com { text, source }',
  ),
  scenarios: z
    .array(scenarioSchema, 'scenarios deve ser uma lista de cenários')
    .min(1, 'O pacote não contém cenários'),
}).superRefine((pack, ctx) => {
  // IMPL-003: pacote é config (vira scenarioSeed) — rótulo curto sem labelSet
  // é recusado aqui, com a mesma regra dos schemas de run.
  for (const { index, message } of stageLabelIssues(pack.scenarios)) {
    ctx.addIssue({ code: 'custom', path: ['scenarios', index, 'labelSet'], message });
  }
});

// Converte os issues do zod numa frase PT-BR com o caminho do campo —
// ex.: 'cenário 3: question obrigatória'. Limita a 3 para não inundar a UI.
function descreverIssues(error: z.ZodError): string {
  const partes = error.issues.slice(0, 3).map((iss) => {
    const [head, idx] = iss.path;
    if (head === 'scenarios' && typeof idx === 'number') {
      return `cenário ${idx + 1}: ${iss.message}`;
    }
    const caminho = iss.path.map(String).join('.');
    return caminho ? `${caminho}: ${iss.message}` : iss.message;
  });
  const restantes = error.issues.length - partes.length;
  return restantes > 0 ? `${partes.join('; ')} (+${restantes} erros)` : partes.join('; ');
}

/**
 * Valida um JSON lido de arquivo como ScenarioPack. Nunca lança: qualquer
 * problema (não-objeto, format divergente, campo inválido) vira
 * `{ ok: false, error }` com mensagem legível em PT-BR.
 */
export function parseScenarioPack(
  json: unknown,
  opts: { allowPii?: boolean } = {},
): { ok: true; pack: ScenarioPack } | { ok: false; error: string; pii?: PiiImportCheck } {
  // O discriminador `format` é checado à mão ANTES do zod, para garantir a
  // mensagem exata quando o arquivo não é um pacote (ou é de outra versão).
  const formato =
    json && typeof json === 'object' ? (json as Record<string, unknown>).format : undefined;
  if (!(FORMATOS_ACEITOS as readonly unknown[]).includes(formato)) {
    const desc = typeof formato === 'string' && formato.trim() ? formato : 'desconhecido';
    return {
      ok: false,
      error: `Arquivo não é um pacote de cenários do prompt-builder (formato ${desc})`,
    };
  }
  const result = packSchema.safeParse(json);
  if (!result.success) return { ok: false, error: descreverIssues(result.error) };
  // LGPD (IMPL-042): pacote com dado pessoal de aparência real é BLOQUEADO com
  // aviso nomeando o campo (cenário exportado por nós inclusive: `origin` é
  // editável no arquivo). `allowPii` = revisão humana confirmou.
  if (!opts.allowPii) {
    const pii = checkImportPii(result.data);
    if (!pii.ok) return { ok: false, error: pii.message!, pii };
  }
  return { ok: true, pack: result.data };
}

// ----------------------------------------------------------------------------
// merge (seed importado + cenários gerados pelo datagen)
// ----------------------------------------------------------------------------

/**
 * Mescla o seed importado com os cenários gerados. A assimetria é proposital:
 * o seed é CURADORIA do usuário (ele exportou, revisou e reimportou o pacote),
 * então entra sempre primeiro, na íntegra, marcado `origin: 'import'`, e nunca
 * é descartado por duplicidade. Os gerados são só COMPLEMENTO e saem marcados
 * `origin: 'ai'`; um gerado só é recusado se repetir o PAR (pergunta +
 * contexto) de um item do SEED.
 *
 * web-live#7: antes o critério era ROUGE-L ≥ 0.7 da pergunta contra TODOS os
 * aceitos (seed + gerados). Isto rodava DEPOIS de `generateStages` já ter
 * deduplicado e decidido a reposição — o que o merge tirava ninguém repunha, e
 * sem aviso: numa run paga real, 8 de 12 cenários sumiram assim (perguntas
 * legítimas do mesmo tema, como "jejum para glicemia" × "jejum para
 * colesterol", passam de 0.7) e a sessão inteira terminou inconclusiva. O
 * dedup gerado×gerado E gerado×seed agora mora em `generateStages` (âncoras de
 * `dedupeSemantic`, antes da decisão de reposição); aqui fica só a rede de
 * segurança do par exato contra o seed.
 */
export function mergeScenarios(seed: StageSpec[], generated: StageSpec[]): StageSpec[] {
  return mergeScenariosReport(seed, generated).specs;
}

/** `mergeScenarios` + quantos gerados colidiram com o seed (para o relatório da run). */
export function mergeScenariosReport(
  seed: StageSpec[],
  generated: StageSpec[],
): { specs: StageSpec[]; droppedVsSeed: number } {
  const accepted: StageSpec[] = seed.map((s) => ({ ...s, origin: 'import' as const }));
  const chavesSeed = new Set(seed.map(exactPairKey));
  let droppedVsSeed = 0;
  for (const gen of generated) {
    if (chavesSeed.has(exactPairKey(gen))) {
      droppedVsSeed += 1;
      continue;
    }
    accepted.push({ ...gen, origin: 'ai' as const });
  }
  return { specs: accepted, droppedVsSeed };
}
