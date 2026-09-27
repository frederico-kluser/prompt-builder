// Regras de geração de cenários POR PERFIL/PROMPT com grounding real (F1.3 do
// PLANO-PARIDADE, item P0.2). Fonte única e pura — os dois motores usam.
//
// O datagen genérico (theme/scenarioBrief) não conhece o domínio; o prompt-arena
// injeta grounding real (`{{blockCatalog}}`, `{{fewShot}}`, `{{setupKeys}}`) e é
// isso que faz os cenários saírem do lugar-comum. Aqui o mesmo mecanismo é
// genérico: o perfil declara templates + grounding, e este módulo RENDERIZA o
// prompt do gerador. O CONTRATO DE SAÍDA (JSON {question, productContext,
// maxTokens, rubric}) continua fixo em código — regra não pode quebrar o parse.

import type { CoverageReport, ScenarioRules } from './libraryCore.js';

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Placeholders que `renderScenarioRules` preenche — qualquer outro vira texto vazio. */
export const SCENARIO_RULE_PLACEHOLDERS = ['theme', 'count', 'context', 'fewShot', 'setupKeys'] as const;

/** Interpola `{{nome}}` no template. Placeholder sem valor some (sem "{{x}}" cru). */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(PLACEHOLDER_RE, (_m, nome: string) => vars[nome] ?? '');
}

/** Nomes de placeholder usados no template, na ordem, sem repetição. */
export function templatePlaceholders(template: string): string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER_RE)].map((m) => m[1]))];
}

/**
 * Avisos de grounding que NÃO chegaria ao gerador (IMPL-008, R-05:REC-6).
 *
 * O bug E5 era o grounding renderizado e nunca enviado; a mesma perda acontece,
 * calada, um nível acima — na configuração do perfil: `renderTemplate` apaga o
 * placeholder desconhecido e o grounding que nenhum template referencia
 * simplesmente não entra no prompt. Nada disso é erro (o gerador ainda roda),
 * mas cada item aqui é um cenário gerado sem o exemplo real que o perfil
 * declarou — por isso o CLI mostra os avisos no `init` e no `seed --generate`.
 */
export function lintScenarioRules(rules: ScenarioRules): string[] {
  const avisos: string[] = [];
  const usados = new Set([
    ...templatePlaceholders(rules.templates.system),
    ...templatePlaceholders(rules.templates.user ?? ''),
  ]);
  const conhecidos = new Set<string>(SCENARIO_RULE_PLACEHOLDERS);
  for (const nome of usados) {
    if (!conhecidos.has(nome)) {
      avisos.push(
        `placeholder {{${nome}}} não é preenchido (conhecidos: ${SCENARIO_RULE_PLACEHOLDERS.map((p) => `{{${p}}}`).join(', ')}) — vira texto vazio no prompt do gerador.`,
      );
    }
  }
  const g = rules.grounding ?? {};
  const declarado: Record<'context' | 'fewShot' | 'setupKeys', boolean> = {
    context: Boolean(g.context?.trim()),
    fewShot: Boolean(g.fewShot?.trim()),
    setupKeys: (g.setupKeys ?? []).some((k) => k.trim()),
  };
  for (const campo of ['context', 'fewShot', 'setupKeys'] as const) {
    if (declarado[campo] && !usados.has(campo)) {
      avisos.push(
        `grounding.${campo} declarado, mas nenhum template usa {{${campo}}} — esse grounding nunca chega ao gerador.`,
      );
    } else if (!declarado[campo] && usados.has(campo)) {
      avisos.push(`template usa {{${campo}}}, mas grounding.${campo} está vazio — o trecho sai em branco.`);
    }
  }
  return avisos;
}

export type ParsedScenarioRules =
  | { ok: true; rules: ScenarioRules; warnings: string[] }
  | { ok: false; error: string };

/**
 * Valida regras vindas de arquivo/disco (nunca lança; erro em PT-BR). Sem
 * `templates.system` string o render quebraria DENTRO de cada lote — e o lote
 * que falha vira "lote vazio" (só um aviso), ou seja, zero cenários sem erro.
 */
export function parseScenarioRules(raw: unknown): ParsedScenarioRules {
  const obj = raw as { templates?: unknown; grounding?: unknown } | null;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: 'Regras de geração precisam ser um objeto { templates: { system } }.' };
  }
  const t = obj.templates as { system?: unknown; user?: unknown } | undefined;
  if (!t || typeof t !== 'object' || Array.isArray(t)) {
    return { ok: false, error: 'Regras de geração precisam ter { templates: { system } }.' };
  }
  if (typeof t.system !== 'string' || !t.system.trim()) {
    return { ok: false, error: 'templates.system precisa ser um texto não vazio.' };
  }
  if (t.user !== undefined && typeof t.user !== 'string') {
    return { ok: false, error: 'templates.user, quando presente, precisa ser texto.' };
  }
  const g = obj.grounding as { context?: unknown; fewShot?: unknown; setupKeys?: unknown } | undefined;
  if (g !== undefined) {
    if (!g || typeof g !== 'object' || Array.isArray(g)) {
      return { ok: false, error: 'grounding, quando presente, precisa ser um objeto.' };
    }
    for (const campo of ['context', 'fewShot'] as const) {
      if (g[campo] !== undefined && typeof g[campo] !== 'string') {
        return { ok: false, error: `grounding.${campo} precisa ser texto.` };
      }
    }
    if (
      g.setupKeys !== undefined &&
      (!Array.isArray(g.setupKeys) || g.setupKeys.some((k) => typeof k !== 'string'))
    ) {
      return { ok: false, error: 'grounding.setupKeys precisa ser uma lista de textos.' };
    }
  }
  const rules = obj as ScenarioRules;
  return { ok: true, rules, warnings: lintScenarioRules(rules) };
}

export interface RenderedRules {
  system: string;
  user: string;
}

/**
 * Monta o system/user do gerador a partir das regras do perfil.
 * `coverageInstruction` entra no user quando há lacunas de cobertura: o datagen
 * passa a ter ALVO de preenchimento (curriculum), em vez de gerar mais do mesmo.
 */
export function renderScenarioRules(
  rules: ScenarioRules,
  opts: {
    theme: string;
    count: number;
    excludePrompts?: string[];
    coverageInstruction?: string;
  },
): RenderedRules {
  const g = rules.grounding ?? {};
  const vars: Record<string, string> = {
    theme: opts.theme,
    count: String(opts.count),
    context: g.context ?? '',
    fewShot: g.fewShot ?? '',
    setupKeys: (g.setupKeys ?? []).join(', '),
  };
  const system = renderTemplate(rules.templates.system, vars);
  const excludeLine = opts.excludePrompts?.length
    ? `\nEVITE perguntas equivalentes a estas já existentes:\n${opts.excludePrompts
        .map((p) => `- ${p}`)
        .join('\n')}`
    : '';
  const user = `${renderTemplate(rules.templates.user ?? '', vars)}${
    opts.coverageInstruction ? `\n${opts.coverageInstruction}` : ''
  }${excludeLine}`.trim();
  return { system, user };
}

/**
 * Instrução de CURRICULUM a partir do relatório de cobertura: lista as lacunas
 * (tier/dimensão abaixo do alvo) para o gerador priorizá-las. Vazia quando o
 * banco já cumpre a matriz — o gerador não recebe ruído.
 */
export function coverageInstruction(report: CoverageReport): string {
  if (!report.gaps.length) return '';
  const linhas = report.gaps.map(
    (gap) =>
      `- ${gap.kind === 'tier' ? `tier "${gap.key}"` : `dimensão "${gap.key}"`}: ${
        gap.have
      }/${gap.target} (faltam ${gap.target - gap.have})`,
  );
  return `COBERTURA ALVO — priorize cenários que PREENCHAM estas lacunas:\n${linhas.join('\n')}`;
}
