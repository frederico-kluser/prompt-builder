// Multi-prompt / coordinate ascent (F2 do PLANO-PARIDADE, P0.4). Fonte única
// e pura — os dois motores usam.
//
// Sistemas reais têm >1 prompt por feature (ex.: regras + críticas). Um
// treino que evolui o prompt INTEIRO de uma vez não sabe qual fragmento ajudou.
// Coordinate ascent: evoluir UM fragmento por sessão, com os IRMÃOS CONGELADOS
// (o texto deles vira contexto fixo no rewriter e compõe o system prompt
// efetivo dos contestants) — exatamente a semântica de fragmento do prompt-arena,
// genérica. O plano exige `promptId` quando o grupo tem >1 prompt.

export interface PromptGroupPrompt {
  id: string;
  label?: string;
  text: string;
}

export interface PromptGroup {
  prompts: PromptGroupPrompt[];
}

export interface PromptGroupCheck {
  ok: boolean;
  error?: string; // PT-BR, citando o campo
}

/**
 * Valida o grupo + fragmento alvo. Grupo com >1 prompt EXIGE `promptId`
 * (sem ele não há coordinate ascent — o evolve não sabe o que está evoluindo);
 * o id precisa existir no grupo. Nunca lança.
 */
export function validatePromptGroup(
  group: PromptGroup | undefined,
  promptId: string | undefined,
): PromptGroupCheck {
  if (!group) return { ok: true };
  const prompts = Array.isArray(group.prompts) ? group.prompts : null;
  if (!prompts || prompts.length === 0) {
    return { ok: false, error: 'promptGroup.prompts precisa ter ao menos 1 prompt { id, text }.' };
  }
  const ids = new Set<string>();
  for (const p of prompts) {
    if (!p?.id?.trim() || !p?.text?.trim()) {
      return { ok: false, error: 'Cada prompt do grupo precisa de { id, text } não vazios.' };
    }
    if (ids.has(p.id)) {
      return { ok: false, error: `promptGroup: id duplicado "${p.id}".` };
    }
    ids.add(p.id);
  }
  if (prompts.length > 1 && !promptId?.trim()) {
    return {
      ok: false,
      error:
        'promptGroup com mais de 1 prompt exige promptId (qual fragmento esta sendo evoluido).',
    };
  }
  if (promptId?.trim() && !ids.has(promptId)) {
    return { ok: false, error: `promptId "${promptId}" não existe no promptGroup.` };
  }
  return { ok: true };
}

/** Fragmento alvo (o que esta sessão evolui). Único prompt do grupo quando não há promptId. */
export function targetFragment(
  group: PromptGroup,
  promptId: string | undefined,
): PromptGroupPrompt | undefined {
  if (promptId) return group.prompts.find((p) => p.id === promptId);
  return group.prompts[0];
}

/** Irmãos CONGELADOS: os demais fragmentos, na ordem do grupo. */
export function frozenSiblings(
  group: PromptGroup,
  promptId: string | undefined,
): PromptGroupPrompt[] {
  const alvo = targetFragment(group, promptId);
  return group.prompts.filter((p) => p !== alvo);
}

/**
 * Bloco de contexto fixo para o REWRITER: os irmãos congelados, com a regra
 * explícita de não mexer neles. Vazio quando o grupo tem 1 prompt só.
 */
export function siblingsContext(group: PromptGroup, promptId: string | undefined): string {
  const irmaos = frozenSiblings(group, promptId);
  if (!irmaos.length) return '';
  const blocos = irmaos
    .map((p) => `<fragmento id="${p.id}"${p.label ? ` rotulo="${p.label}"` : ''}>\n${p.text}\n</fragmento>`)
    .join('\n');
  return `FRAGMENTOS IRMÃOS CONGELADOS (faça parte do prompt final, mas NÃO os altere — otimize APENAS o fragmento alvo; a reescrita deve continuar coerente com eles):
${blocos}`;
}

/**
 * System prompt EFETIVO dos contestants: os fragmentos na ordem do grupo, com o
 * alvo substituído pela variante em teste. É isto que o modelo sob teste recebe.
 */
export function composePrompt(
  group: PromptGroup,
  promptId: string | undefined,
  variantText: string,
): string {
  const alvo = targetFragment(group, promptId);
  return group.prompts
    .map((p) => (p === alvo ? variantText.trim() : p.text))
    .filter((t) => t.trim().length > 0)
    .join('\n\n');
}
