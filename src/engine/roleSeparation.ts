// Papéis separados: referência × juiz × competidores (IMPL-048, R-03a:REC-2).
//
// A REFERÊNCIA (quem escreve o gabarito) não pode ser juiz nem competidor: o
// mesmo modelo escrever a régua e julgar contra ela (ou competir contra ela)
// produz erros CORRELACIONADOS que não se cancelam (DEC-2). Em training/
// variation a referência é OBRIGATÓRIA — o default "1º juiz escreve o gabarito"
// só sobrevive no compare, explícito e documentado.
//
// Fonte ÚNICA da regra, pura e isomórfica: o `runConfigSchema` (Node: servidor
// + CLI + MCP) monta as mensagens de erro daqui, o portão da SPA (`web/src/api.ts`
// createRun/createSession) recusa ANTES de qualquer chamada paga e o formulário
// de Nova Run (`problems()`) mostra a mesma pendência antes do clique. Uma
// segunda cópia da regra divergiria no primeiro ajuste — foi o furo do IMPL-048
// na SPA, que não validava nada e caía no `judgeModelIds[0]`.

export type RoleConflictKind =
  | 'reference-missing'
  | 'reference-is-judge'
  | 'reference-is-competitor'
  // IMPL-055: o 2º gabarito (validação por família distinta) sob a MESMA regra.
  | 'second-reference-is-reference'
  | 'second-reference-is-judge'
  | 'second-reference-is-competitor';

export interface RoleConflict {
  kind: RoleConflictKind;
  /** O modelo de referência em conflito (ausente em `reference-missing`). */
  ref?: string;
}

/** Recorte do RunConfig que a regra lê (vale para o RunConfig cru e o do form). */
export interface RoleSeparationInput {
  mode?: string;
  referenceModelId?: string | null;
  judgeModelIds?: readonly string[] | null;
  competitorModelIds?: readonly string[] | null;
  competitorConfigs?: readonly { modelId: string }[] | null;
  contestantModelId?: string | null;
  /**
   * IMPL-055: o 2º gabarito. Igual à referência, a checagem de concordância
   * "de outra família" é sempre verdadeira (a divergência nunca vai à fila);
   * juiz (o 1º juiz é também o verificador) ou competidor devolve o erro
   * correlacionado que o IMPL-048 existe para evitar.
   */
  secondReferenceModelId?: string | null;
}

/** Quem COMPETE no config: ids do compare (dois eixos) ou o modelo sob teste. */
export function competingModelIds(cfg: RoleSeparationInput): string[] {
  if (cfg.mode === 'compare') {
    return [...(cfg.competitorModelIds ?? []), ...(cfg.competitorConfigs ?? []).map((c) => c.modelId)];
  }
  return cfg.contestantModelId ? [cfg.contestantModelId] : [];
}

/**
 * Conflitos de papel do config, na ordem em que o schema os reporta (juiz,
 * competidor, ausente). Lista vazia = papéis separados.
 */
export function roleSeparationIssues(cfg: RoleSeparationInput): RoleConflict[] {
  const out: RoleConflict[] = [];
  const ref = cfg.referenceModelId ?? '';
  if (ref) {
    if ((cfg.judgeModelIds ?? []).includes(ref)) out.push({ kind: 'reference-is-judge', ref });
    if (competingModelIds(cfg).includes(ref)) out.push({ kind: 'reference-is-competitor', ref });
  }
  if (cfg.mode !== 'compare' && !ref.trim()) out.push({ kind: 'reference-missing' });
  const segunda = cfg.secondReferenceModelId ?? '';
  if (segunda) {
    // Sem referência explícita (compare) quem escreve o gabarito é o 1º juiz —
    // e esse caso já cai em "é juiz".
    if (ref && segunda === ref) out.push({ kind: 'second-reference-is-reference', ref: segunda });
    if ((cfg.judgeModelIds ?? []).includes(segunda)) out.push({ kind: 'second-reference-is-judge', ref: segunda });
    if (competingModelIds(cfg).includes(segunda)) out.push({ kind: 'second-reference-is-competitor', ref: segunda });
  }
  return out;
}

/** Mensagem canônica (a do schema/CLI/API) de cada conflito. */
export function roleConflictMessage(c: RoleConflict): string {
  switch (c.kind) {
    case 'reference-is-judge':
      return `A referência "${c.ref}" não pode ser também juiz: o mesmo modelo escreveria o gabarito e emitiria o veredito sobre ele (viés de auto-preferência). Escolha modelos distintos.`;
    case 'reference-is-competitor':
      return `A referência "${c.ref}" não pode ser também competidor: quem escreve o gabarito não compete contra ele (viés de auto-preferência). Escolha modelos distintos.`;
    case 'reference-missing':
      return 'referenceModelId é obrigatório em training/variation: o gabarito não pode sair do 1º juiz (o mesmo modelo escreveria a régua e julgaria contra ela).';
    case 'second-reference-is-reference':
      return `O 2º gabarito "${c.ref}" não pode ser a própria referência: a concordância entre os dois gabaritos seria sempre verdadeira e nenhuma divergência iria à revisão humana. Escolha um modelo de outra família.`;
    case 'second-reference-is-judge':
      return `O 2º gabarito "${c.ref}" não pode ser também juiz (o 1º juiz é ainda o verificador): o mesmo modelo escreveria a régua e julgaria contra ela. Escolha modelos distintos.`;
    case 'second-reference-is-competitor':
      return `O 2º gabarito "${c.ref}" não pode ser também competidor: quem escreve a régua não compete contra ela. Escolha modelos distintos.`;
  }
}

/** Campo do config que o conflito aponta (o schema reporta o issue nele). */
export function roleConflictField(c: RoleConflict): 'referenceModelId' | 'secondReferenceModelId' {
  return c.kind.startsWith('second-reference') ? 'secondReferenceModelId' : 'referenceModelId';
}

/**
 * Portão fail-closed: lança com as mensagens canônicas quando os papéis se
 * misturam. Para quem inicia run fora do schema Zod (a SPA não carrega o zod).
 */
export function assertRoleSeparation(cfg: RoleSeparationInput): void {
  const issues = roleSeparationIssues(cfg);
  if (issues.length) throw new Error(issues.map(roleConflictMessage).join(' '));
}
