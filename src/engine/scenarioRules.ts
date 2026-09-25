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

/** Interpola `{{nome}}` no template. Placeholder sem valor some (sem "{{x}}" cru). */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, nome: string) => vars[nome] ?? '');
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
