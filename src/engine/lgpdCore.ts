// Núcleo PURO da conformidade LGPD — FONTE ÚNICA da classificação (IMPL-041,
// R-16:REC-3). Antes havia TRÊS cópias da mesma regra (src/lgpd.ts,
// web/src/lgpd.ts e scripts/gen-lgpd-allowlist.mjs) e a unidade de decisão era
// o PREFIXO DO CRIADOR, fail-open: criador desconhecido herdava "permitido com
// ressalvas" até em saúde. A política do OpenRouter é por ENDPOINT (provedor +
// região/variante), e é essa a unidade aqui:
//
//   • o snapshot `src/data/lgpd-allowlist.generated.json` é derivado de
//     GET /models + GET /endpoints/zdr (ambos públicos) por UM gerador
//     (`buildAllowlistSnapshot`, chamado por scripts/gen-lgpd-allowlist.mjs);
//   • em ÁREA SENSÍVEL o modelo só passa com snapshot fresco (≤ 90 dias), criador
//     conhecido e ≥ 1 endpoint ZDR de provedor conhecido — "desconhecido ⇒
//     bloqueado" (a mesma postura do OpenRouter: política desconhecida é
//     assumida como retenção + treino);
//   • IMPL-101: no modo sensível, `:batch`, `:free` e `openrouter/*` são
//     recusados pela forma do id, e endpoint com cache implícita não entra em
//     `provider.only` (o cache fica fora da definição de ZDR);
//   • a área "geral" (baixo risco) segue consultiva por criador, como antes.
//
// Quem consome: `src/lgpd.ts` (Node: lê os JSON do pacote), `web/src/lgpd.ts`
// (shim + loader do bundle), o gerador e os orquestradores (pré-voo da run).
//
// ⚠️ SEM imports relativos, de propósito: o gerador importa este arquivo pelo
// caminho `.ts` (sob tsx), e o bundle do navegador também o arrasta — nada de
// `node:*` nem `process.env` aqui (guarda em test/engine-sync.test.ts).
//
// NÃO é aconselhamento jurídico: é um controle técnico verificável.

// ---------------------------------------------------------------------------
// Tipos da base de conhecimento (src/data/lgpd-compliance.json)
// ---------------------------------------------------------------------------

export type AreaStatus = 'permitido' | 'permitido com ressalvas' | 'não recomendado';

export interface LgpdArea {
  id: string;
  label: string;
  descricao: string;
  /**
   * Área SENSÍVEL: exige allowlist de endpoints fresca e é fail-closed.
   * Ausente ⇒ sensível (só `false` explícito libera o modo consultivo).
   */
  sensivel?: boolean;
}

export interface LgpdFamilia {
  id: string;
  nome: string;
  prefixos: string[];
  provedor_modelo: string;
  origem: string;
  pais_adequacao_lgpd: string;
  certificacoes: string[];
  observacoes: string;
  areas_permitidas: Record<string, AreaStatus>;
  areas_notas?: Record<string, string>;
}

/** Provedor de infraestrutura (o `provider_name` do OpenRouter). */
export interface LgpdProvider {
  origem: string;
  zdr: boolean;
  treina: boolean;
}

export interface LgpdData {
  data_referencia: string;
  aviso: string;
  principio_central: string;
  status_adequacao_anpd: Record<string, string>;
  configuracao_openrouter_recomendada: Record<string, string>;
  statuses: AreaStatus[];
  areas: LgpdArea[];
  familias: LgpdFamilia[];
  heuristica_nao_classificados: {
    descricao: string;
    defaults_restrita: Record<string, AreaStatus>;
    defaults_ocidental: Record<string, AreaStatus>;
  };
  creators_origem: Record<string, string>;
  providers: Record<string, LgpdProvider>;
  regioes_ue_tags: string[];
  /**
   * Snapshot da allowlist por endpoint, ANEXADO EM RUNTIME pelo loader de cada
   * lado (não vive no JSON da base). `null`/ausente ⇒ área sensível bloqueada.
   */
  allowlist?: LgpdAllowlistSnapshot | null;
}

// ---------------------------------------------------------------------------
// Snapshot da allowlist por endpoint (src/data/lgpd-allowlist.generated.json)
// ---------------------------------------------------------------------------

/** Formato do snapshot. Mudou a forma ⇒ mude o formato (o runtime recusa o desconhecido). */
export const ALLOWLIST_FORMAT = 'prompt-builder-lgpd-allowlist@2';
/** Validade MÁXIMA (R-16:REC-3). O campo `validade_dias` do arquivo só pode ENCURTAR. */
export const ALLOWLIST_MAX_AGE_DAYS = 90;
/** Alvo operacional: acima disso o snapshot ainda vale, mas avisa para regenerar. */
export const ALLOWLIST_TARGET_AGE_DAYS = 30;
/** Folga para relógio adiantado de quem gerou (data futura além disso = inválido). */
const FUTURE_TOLERANCE_DAYS = 1;
const DAY_MS = 86_400_000;

export interface AllowlistEndpoint {
  /**
   * Tag do endpoint no OpenRouter (`provedor[/variante-ou-região]`, ex.:
   * `mistral/eu`, `google-vertex/global`, `azure`) — o identificador que
   * `provider.only` aceita. É ESTA a unidade da política.
   */
  tag: string;
  /** `provider_name` publicado pelo OpenRouter (chave de `providers` na base). */
  provider: string;
  /** Endpoint declara `supports_implicit_caching` (cache fica FORA da definição de ZDR). */
  implicitCaching?: boolean;
}

export interface LgpdAllowlistSnapshot {
  format: string;
  /** YYYY-MM-DD (UTC) da geração — a idade é contada a partir daqui. */
  data_geracao: string;
  validade_dias: number;
  alvo_operacional_dias: number;
  fonte: string;
  total_modelos_catalogo: number;
  total_endpoints_zdr: number;
  endpoints_zdr_fora_do_catalogo: number;
  /**
   * TODOS os modelos do catálogo na geração → endpoints ZDR que os servem.
   * `[]` = modelo conhecido SEM endpoint ZDR; chave ausente = modelo que
   * surgiu depois da geração (desconhecido ⇒ bloqueado).
   */
  modelos: Record<string, AllowlistEndpoint[]>;
}

// ---------------------------------------------------------------------------
// Criador (metadado de exibição + teto consultivo)
// ---------------------------------------------------------------------------

/** id "livre" reservado: não filtra nada (mostra todos os modelos). */
export const AREA_LIVRE = 'livre';

/** Jurisdições que a base trata como restritas (postura DeepSeek/Qwen). */
const ORIGENS_RESTRITAS = new Set(['China', 'SG']);

/** Prefixo do criador no id OpenRouter: trecho antes de "/", sem o "~" de variantes. */
export function creatorPrefix(modelId: string): string {
  const head = modelId.split('/')[0] ?? '';
  return head.replace(/^~/, '').toLowerCase();
}

/** Família do relatório que cobre este modelo (por prefixo), se houver. */
export function familiaFor(modelId: string, data: LgpdData): LgpdFamilia | undefined {
  const prefix = creatorPrefix(modelId);
  return data.familias.find((f) => f.prefixos.some((p) => p.toLowerCase() === prefix));
}

/** Origem (rótulo p/ badge): da família, ou do mapa creators_origem, ou "Indefinido". */
export function originFor(modelId: string, data: LgpdData): string {
  const fam = familiaFor(modelId, data);
  if (fam) return fam.origem;
  return data.creators_origem[creatorPrefix(modelId)] ?? 'Indefinido';
}

/** O criador é conhecido da base (família ou origem mapeada, não "Indefinido")? */
export function isKnownCreator(modelId: string, data: LgpdData): boolean {
  if (familiaFor(modelId, data)) return true;
  const origem = data.creators_origem[creatorPrefix(modelId)];
  return Boolean(origem && origem !== 'Indefinido');
}

/** Área sensível? `livre` nunca; área fora da base SIM (fail-closed). */
export function isSensitiveArea(area: string, data: LgpdData): boolean {
  if (area === AREA_LIVRE) return false;
  const def = data.areas.find((a) => a.id === area);
  return def ? def.sensivel !== false : true;
}

// ---------------------------------------------------------------------------
// Idade/validade do snapshot
// ---------------------------------------------------------------------------

export type AllowlistState = 'ok' | 'desatualizada' | 'vencida' | 'ausente' | 'invalida';

export interface AllowlistHealth {
  state: AllowlistState;
  /** Pode ser usado para liberar área sensível? (ok | desatualizada) */
  usable: boolean;
  geradoEm?: string;
  ageDays?: number;
  maxAgeDays: number;
  targetAgeDays: number;
  /** Modelos do catálogo na geração / com ≥1 endpoint ZDR / endpoints ZDR listados. */
  modelos: number;
  modelosComZdr: number;
  endpoints: number;
  message: string;
}

function parseIsoDay(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // Rejeita 2026-02-31 & cia (o Date.UTC "rola" o mês em silêncio).
  const d = new Date(t);
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1) return null;
  return t;
}

function toMs(now: Date | number): number {
  return typeof now === 'number' ? now : now.getTime();
}

/** Estado do snapshot em `now`. Qualquer coisa fora do contrato ⇒ inutilizável. */
export function allowlistHealth(
  snapshot: LgpdAllowlistSnapshot | null | undefined,
  now: Date | number = Date.now(),
): AllowlistHealth {
  const base = {
    maxAgeDays: ALLOWLIST_MAX_AGE_DAYS,
    targetAgeDays: ALLOWLIST_TARGET_AGE_DAYS,
    modelos: 0,
    modelosComZdr: 0,
    endpoints: 0,
  };
  if (!snapshot) {
    return {
      ...base,
      state: 'ausente',
      usable: false,
      message: 'Allowlist LGPD de endpoints ausente: área sensível bloqueada. Rode `npm run lgpd:allowlist`.',
    };
  }
  const gerado = parseIsoDay(snapshot.data_geracao);
  const modelos = snapshot.modelos;
  if (
    snapshot.format !== ALLOWLIST_FORMAT ||
    gerado === null ||
    !modelos ||
    typeof modelos !== 'object' ||
    Array.isArray(modelos)
  ) {
    return {
      ...base,
      state: 'invalida',
      usable: false,
      geradoEm: typeof snapshot.data_geracao === 'string' ? snapshot.data_geracao : undefined,
      message: `Allowlist LGPD inválida (formato esperado ${ALLOWLIST_FORMAT}): área sensível bloqueada.`,
    };
  }
  const listas = Object.values(modelos);
  const counts = {
    modelos: listas.length,
    modelosComZdr: listas.filter((l) => Array.isArray(l) && l.length > 0).length,
    endpoints: listas.reduce((s, l) => s + (Array.isArray(l) ? l.length : 0), 0),
  };
  // O arquivo pode ENCURTAR a validade, nunca estender além do teto do código.
  const declarada = Number(snapshot.validade_dias);
  const maxAgeDays =
    Number.isFinite(declarada) && declarada > 0
      ? Math.min(declarada, ALLOWLIST_MAX_AGE_DAYS)
      : ALLOWLIST_MAX_AGE_DAYS;
  const ageDays = Math.floor((toMs(now) - gerado) / DAY_MS);
  const comum = { ...base, ...counts, maxAgeDays, geradoEm: snapshot.data_geracao, ageDays };
  if (ageDays < -FUTURE_TOLERANCE_DAYS) {
    return {
      ...comum,
      state: 'invalida',
      usable: false,
      message: `Allowlist LGPD com data de geração no futuro (${snapshot.data_geracao}): área sensível bloqueada.`,
    };
  }
  if (ageDays > maxAgeDays) {
    return {
      ...comum,
      state: 'vencida',
      usable: false,
      message:
        `Allowlist LGPD vencida: gerada em ${snapshot.data_geracao} (${ageDays} dias; validade ${maxAgeDays}). ` +
        'Área sensível bloqueada até regenerar (`npm run lgpd:allowlist`).',
    };
  }
  if (ageDays > ALLOWLIST_TARGET_AGE_DAYS) {
    return {
      ...comum,
      state: 'desatualizada',
      usable: true,
      message:
        `Allowlist LGPD com ${ageDays} dias (alvo operacional ${ALLOWLIST_TARGET_AGE_DAYS}; ` +
        `vence em ${maxAgeDays - ageDays}). Regenere com \`npm run lgpd:allowlist\`.`,
    };
  }
  return {
    ...comum,
    state: 'ok',
    usable: true,
    message: `Allowlist LGPD gerada em ${snapshot.data_geracao} (${Math.max(ageDays, 0)} dias).`,
  };
}

// ---------------------------------------------------------------------------
// Endpoint: elegibilidade em área sensível
// ---------------------------------------------------------------------------

export type EndpointExclusion =
  | 'provedor_desconhecido'
  | 'provedor_origem_indefinida'
  | 'provedor_origem_restrita'
  | 'provedor_treina'
  /** IMPL-101: `supports_implicit_caching` — o cache fica FORA da definição de ZDR. */
  | 'cache_implicito';

/**
 * Por que um endpoint ZDR NÃO serve à área sensível (null = elegível).
 * O ZDR vem do snapshot (política POR ENDPOINT — o `zdr` do mapa de provedores
 * é genérico e não manda aqui); o mapa só responde "quem é e onde está".
 * Provedor fora do mapa ou de jurisdição indefinida ⇒ desconhecido ⇒ fora.
 *
 * IMPL-101 (R-16:REC-4): endpoint com cache implícita também sai. O OpenRouter
 * lista esses endpoints em `/endpoints/zdr`, mas o prompt fica em cache do
 * provedor — retenção que a definição de ZDR não cobre. A checagem vem por
 * ÚLTIMO de propósito: `cache_implicito` significa "provedor aceitável, só o
 * cache o tirou" — é o que deixa o motivo do modelo dizer isso ao usuário.
 */
export function endpointExclusion(ep: AllowlistEndpoint, data: LgpdData): EndpointExclusion | null {
  const p = data.providers[ep.provider];
  if (!p) return 'provedor_desconhecido';
  if (p.treina) return 'provedor_treina';
  if (!p.origem || p.origem === 'Indefinido') return 'provedor_origem_indefinida';
  if (ORIGENS_RESTRITAS.has(p.origem)) return 'provedor_origem_restrita';
  if (ep.implicitCaching === true) return 'cache_implicito';
  return null;
}

/**
 * IMPL-101 (R-16:REC-4) — ids que o modo sensível RECUSA pela forma, antes de
 * olhar a allowlist (null = a forma não bloqueia):
 *   • `…:batch` — a variante batch retém insumos e resultados (até 30 dias);
 *   • `…:free`  — o provedor gratuito pode reter/usar os prompts;
 *   • `openrouter/*` — roteadores do próprio OpenRouter: não há garantia
 *     documentada de que `provider.*` (zdr/only/allow_fallbacks) se propaga ao
 *     modelo que o roteador escolhe.
 * Antes a recusa era ACIDENTAL (`:batch` sem endpoint no snapshot, `:free` e
 * `openrouter/*` com criador desconhecido) — e `:free` com endpoint ZDR no
 * snapshot passaria assim que o criador fosse classificado.
 */
export function sensitiveIdBlock(modelId: string): LgpdBlockReason | null {
  const id = modelId.trim().toLowerCase();
  if (id.endsWith(':batch')) return 'variante_batch';
  if (id.endsWith(':free')) return 'variante_free';
  if (creatorPrefix(id) === 'openrouter') return 'roteador_openrouter';
  return null;
}

/** Tag de endpoint em região da UE (pela lista `regioes_ue_tags` da base). */
export function isEuEndpointTag(tag: string, data: LgpdData): boolean {
  const t = tag.toLowerCase();
  return data.regioes_ue_tags.some((p) => p && t.includes(p.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Classificação por (modelo, área)
// ---------------------------------------------------------------------------

export type LgpdBlockReason =
  | 'area_desconhecida'
  | 'allowlist_ausente'
  | 'allowlist_invalida'
  | 'allowlist_vencida'
  | 'criador_desconhecido'
  | 'nao_recomendado'
  | 'modelo_desconhecido'
  | 'sem_endpoint_zdr'
  | 'ressalvas_excluidas'
  /** IMPL-040: a requisição sensível ficaria sem algum dos 4 campos de privacidade. */
  | 'roteamento_incompleto'
  /** IMPL-101: variante `:batch` (retém insumos/resultados). */
  | 'variante_batch'
  /** IMPL-101: variante `:free` (o provedor gratuito pode reter os prompts). */
  | 'variante_free'
  /** IMPL-101: roteador `openrouter/*` (propagação de `provider.*` não documentada). */
  | 'roteador_openrouter'
  /** IMPL-101: os endpoints ZDR de provedor aceitável têm TODOS cache implícita. */
  | 'cache_implicito';

/** Texto curto (PT-BR) de cada motivo — UI, CLI e mensagens de erro. */
export const LGPD_BLOCK_REASON_TEXT: Record<LgpdBlockReason, string> = {
  area_desconhecida: 'área LGPD desconhecida',
  allowlist_ausente: 'allowlist de endpoints ausente',
  allowlist_invalida: 'allowlist de endpoints inválida',
  allowlist_vencida: `allowlist de endpoints vencida (> ${ALLOWLIST_MAX_AGE_DAYS} dias)`,
  criador_desconhecido: 'criador desconhecido (desconhecido ⇒ bloqueado)',
  nao_recomendado: 'não recomendado para a área',
  modelo_desconhecido: 'modelo fora do snapshot da allowlist (desconhecido ⇒ bloqueado)',
  sem_endpoint_zdr: 'sem endpoint ZDR elegível na allowlist',
  ressalvas_excluidas: 'só permitido com ressalvas, e o rigor escolhido exclui ressalvas',
  roteamento_incompleto:
    'requisição sensível sem os 4 campos de privacidade (zdr, data_collection, only, allow_fallbacks)',
  variante_batch: 'variante :batch recusada em dado sensível (retém insumos e resultados)',
  variante_free: 'variante :free recusada em dado sensível (o provedor gratuito pode reter os prompts)',
  roteador_openrouter:
    'roteador openrouter/* recusado em dado sensível (sem garantia de que a política de provedor se propaga)',
  cache_implicito: 'só endpoints ZDR com cache implícita (o cache fica fora da definição de ZDR)',
};

export interface ModelPermission {
  status: AreaStatus;
  nota?: string;
  origem: string;
  familiaId?: string;
  /** A área exige allowlist (fail-closed)? */
  sensivel: boolean;
  /** Por que está bloqueado (só quando `status === 'não recomendado'`). */
  motivo?: LgpdBlockReason;
  /** Área sensível liberada: os endpoints ZDR elegíveis (vão em `provider.only` — IMPL-040). */
  endpoints?: AllowlistEndpoint[];
}

const HEALTH_REASON: Partial<Record<AllowlistState, LgpdBlockReason>> = {
  ausente: 'allowlist_ausente',
  invalida: 'allowlist_invalida',
  vencida: 'allowlist_vencida',
};

/** Teto consultivo do criador (família → origem → desconhecido). */
function creatorVerdict(
  modelId: string,
  area: string,
  data: LgpdData,
  sensivel: boolean,
): { status: AreaStatus; motivo?: LgpdBlockReason } {
  const blocked = (motivo: LgpdBlockReason) => ({ status: 'não recomendado' as const, motivo });
  const fam = familiaFor(modelId, data);
  if (fam) {
    const s = fam.areas_permitidas[area];
    if (s) return s === 'não recomendado' ? blocked('nao_recomendado') : { status: s };
    // Família sem classificação p/ esta área: em área sensível é desconhecido.
    return sensivel ? blocked('criador_desconhecido') : { status: 'permitido com ressalvas' };
  }
  const origem = data.creators_origem[creatorPrefix(modelId)];
  const h = data.heuristica_nao_classificados;
  if (origem && origem !== 'Indefinido') {
    const s = (ORIGENS_RESTRITAS.has(origem) ? h.defaults_restrita : h.defaults_ocidental)[area];
    if (s) return s === 'não recomendado' ? blocked('nao_recomendado') : { status: s };
    return sensivel ? blocked('criador_desconhecido') : { status: 'permitido com ressalvas' };
  }
  // Criador desconhecido. Antes: defaults_ocidental em TODA área (fail-open).
  // Agora só a área não sensível segue consultiva.
  if (sensivel) return blocked('criador_desconhecido');
  const s = h.defaults_ocidental[area] ?? 'permitido com ressalvas';
  return s === 'não recomendado' ? blocked('nao_recomendado') : { status: s };
}

function permissionWith(
  modelId: string,
  area: string,
  data: LgpdData,
  health: AllowlistHealth,
  forceSensitive = false,
): ModelPermission {
  const fam = familiaFor(modelId, data);
  const meta = {
    nota: fam?.areas_notas?.[area],
    origem: originFor(modelId, data),
    familiaId: fam?.id,
  };
  if (area === AREA_LIVRE && !forceSensitive) return { status: 'permitido', sensivel: false, ...meta };
  if (!data.areas.some((a) => a.id === area)) {
    return { status: 'não recomendado', sensivel: true, motivo: 'area_desconhecida', ...meta };
  }
  // `forceSensitive`: o modo "dados sensíveis" pode valer até na área "geral".
  const sensivel = forceSensitive || isSensitiveArea(area, data);
  const cv = creatorVerdict(modelId, area, data, sensivel);
  if (!sensivel) return { status: cv.status, sensivel, ...(cv.motivo ? { motivo: cv.motivo } : {}), ...meta };

  // --- área sensível: fail-closed em cada degrau ---
  const block = (motivo: LgpdBlockReason): ModelPermission => ({
    status: 'não recomendado',
    sensivel,
    motivo,
    ...meta,
  });
  // IMPL-101: a FORMA do id (`:batch`/`:free`/`openrouter/*`) recusa antes de
  // tudo — não depende do snapshot, então nem um snapshot novo a afrouxa.
  const pelaForma = sensitiveIdBlock(modelId);
  if (pelaForma) return block(pelaForma);
  if (!health.usable) return block(HEALTH_REASON[health.state] ?? 'allowlist_invalida');
  if (cv.motivo) return block(cv.motivo);
  const eps = data.allowlist?.modelos[modelId];
  if (!Array.isArray(eps)) return block('modelo_desconhecido');
  const exclusoes = eps.map((ep) => endpointExclusion(ep, data));
  const elegiveis = eps.filter((_, i) => exclusoes[i] === null);
  if (elegiveis.length === 0) {
    // Havia endpoint de provedor aceitável e só o cache implícito o tirou: diga
    // ISSO (a redução de oferta é comunicada, nunca escondida — REC-9).
    return block(exclusoes.includes('cache_implicito') ? 'cache_implicito' : 'sem_endpoint_zdr');
  }
  return { status: cv.status, sensivel, endpoints: elegiveis, ...meta };
}

/** Permissão detalhada de um modelo numa área (badges, tooltips, pré-voo). */
export function permissionOf(
  modelId: string,
  area: string,
  data: LgpdData,
  now: Date | number = Date.now(),
): ModelPermission {
  return permissionWith(modelId, area, data, allowlistHealth(data.allowlist, now));
}

/** Status de uma área para um modelo (atalho de `permissionOf`). */
export function statusFor(
  modelId: string,
  area: string,
  data: LgpdData,
  now: Date | number = Date.now(),
): AreaStatus {
  return permissionOf(modelId, area, data, now).status;
}

/** Um status passa no filtro? "não recomendado" nunca passa; ressalvas só com a flag. */
export function statusAllowed(status: AreaStatus, includeRessalvas: boolean): boolean {
  if (status === 'permitido') return true;
  if (status === 'permitido com ressalvas') return includeRessalvas;
  return false;
}

/** Particiona um catálogo em permitidos/bloqueados para (área, rigor), com o motivo. */
export function filterModels<T extends { id: string }>(
  models: T[],
  area: string,
  includeRessalvas: boolean,
  data: LgpdData,
  now: Date | number = Date.now(),
): { allowed: T[]; blockedIds: Set<string>; reasons: Map<string, LgpdBlockReason> } {
  if (area === AREA_LIVRE) return { allowed: models, blockedIds: new Set(), reasons: new Map() };
  const health = allowlistHealth(data.allowlist, now);
  const allowed: T[] = [];
  const blockedIds = new Set<string>();
  const reasons = new Map<string, LgpdBlockReason>();
  for (const m of models) {
    const p = permissionWith(m.id, area, data, health);
    if (statusAllowed(p.status, includeRessalvas)) {
      allowed.push(m);
    } else {
      blockedIds.add(m.id);
      reasons.set(m.id, p.motivo ?? 'ressalvas_excluidas');
    }
  }
  return { allowed, blockedIds, reasons };
}

/** Um id específico está permitido para (área, rigor)? Útil p/ podar seleções. */
export function isAllowed(
  modelId: string,
  area: string,
  includeRessalvas: boolean,
  data: LgpdData,
  now: Date | number = Date.now(),
): boolean {
  return statusAllowed(statusFor(modelId, area, data, now), includeRessalvas);
}

export type SensitiveRoute =
  | { ok: true; only: string[]; endpoints: AllowlistEndpoint[] }
  | { ok: false; motivo: LgpdBlockReason; message: string };

/**
 * Rota sensível de um modelo: as tags de endpoint que podem ir em
 * `provider.only` (insumo do modo "dados sensíveis", IMPL-040). Aplica o
 * portão sensível em QUALQUER área da base (inclusive "geral"); `livre` ou área
 * desconhecida não têm rota. Nunca devolve lista vazia com `ok: true`.
 */
export function sensitiveRoute(
  modelId: string,
  area: string,
  data: LgpdData,
  now: Date | number = Date.now(),
): SensitiveRoute {
  const fail = (motivo: LgpdBlockReason): SensitiveRoute => ({
    ok: false,
    motivo,
    message: `${modelId}: ${LGPD_BLOCK_REASON_TEXT[motivo]}`,
  });
  if (area === AREA_LIVRE) return fail('area_desconhecida');
  const p = permissionWith(modelId, area, data, allowlistHealth(data.allowlist, now), true);
  if (p.status === 'não recomendado' || !p.endpoints?.length) return fail(p.motivo ?? 'sem_endpoint_zdr');
  return { ok: true, only: p.endpoints.map((e) => e.tag), endpoints: p.endpoints };
}

// ---------------------------------------------------------------------------
// Pré-voo da run: TODOS os papéis que recebem o dado
// ---------------------------------------------------------------------------

export type LgpdRole = 'competitor' | 'judge' | 'datagen' | 'reference' | 'rewriter';

const ROLE_TEXT: Record<LgpdRole, string> = {
  competitor: 'competidor',
  judge: 'juiz',
  datagen: 'gerador',
  reference: 'gabarito',
  rewriter: 'reescritor',
};

/** Recorte estrutural do RunConfig (o núcleo não importa tipos de fora). */
export interface ComplianceConfigLike {
  compliance?: { area: string; includeRessalvas: boolean };
  datagenModelId?: string;
  judgeModelIds?: string[];
  referenceModelId?: string;
  optimizerModelId?: string;
  competitorModelIds?: string[];
  competitorConfigs?: { modelId: string }[];
  contestantModelId?: string;
  /** IMPL-055: o 2º gabarito também lê cenário + rubrica. */
  secondReferenceModelId?: string;
  /** IMPL-115: no modo econômico quem julga são os baratos + o forte. */
  judgeCascade?: { cheap?: readonly string[]; strong?: string };
  /** IMPL-063: o modelo de embeddings do dedup semântico recebe o texto dos cenários. */
  scenarioDedup?: { semantic?: boolean; embedModelId?: string };
  /** Presente = modo agente: o executor (`pi`) fala com o provedor FORA do gateway. */
  agent?: unknown;
}

/**
 * Modelo de embeddings do dedup semântico quando o config liga o dedup sem
 * escolher um. Fonte ÚNICA (`src/embeddings.ts` reexporta como
 * `DEFAULT_DEDUP_EMBED_MODEL`): o pré-voo checa o modelo que DE FATO recebe
 * os cenários.
 */
export const DEFAULT_SCENARIO_EMBED_MODEL = 'openai/text-embedding-3-small';

/** Modelo de embeddings que a run chama (dedup semântico ligado), ou undefined. */
export function scenarioEmbedModelId(cfg: Pick<ComplianceConfigLike, 'scenarioDedup'>): string | undefined {
  const d = cfg.scenarioDedup;
  if (!d?.semantic) return undefined;
  return d.embedModelId?.trim() || DEFAULT_SCENARIO_EMBED_MODEL;
}

/** O config liga o modo sensível? (compliance numa área sensível; área fora da base conta). */
export function isSensitiveCompliance(cfg: ComplianceConfigLike, data: LgpdData): boolean {
  const area = cfg.compliance?.area;
  return Boolean(area && isSensitiveArea(area, data));
}

/**
 * Modelos que VEEM o dado da run, por papel. O dado sensível não vai só ao
 * competidor: cenários, respostas e gabaritos passam por gerador, gabarito,
 * juiz/duelo e reescritor (os 6 papéis do R-16) — todos entram no pré-voo.
 */
export function runModelRoles(cfg: ComplianceConfigLike): { role: LgpdRole; modelId: string }[] {
  const out: { role: LgpdRole; modelId: string }[] = [];
  const seen = new Set<string>();
  const add = (role: LgpdRole, id: string | undefined): void => {
    if (!id) return;
    const k = `${role}\u0000${id}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ role, modelId: id });
  };
  for (const id of cfg.competitorModelIds ?? []) add('competitor', id);
  for (const c of cfg.competitorConfigs ?? []) add('competitor', c.modelId);
  add('competitor', cfg.contestantModelId);
  for (const id of cfg.judgeModelIds ?? []) add('judge', id);
  // IMPL-115 (revisão w2): com cascata os juízes que EMITEM veredito são os
  // baratos + o forte — sem eles o pré-voo checava quem nem julga e deixava
  // passar quem julga (a recusa virava `judge_failed` → consenso 'degraded').
  for (const id of cfg.judgeCascade?.cheap ?? []) add('judge', id);
  add('judge', cfg.judgeCascade?.strong);
  add('datagen', cfg.datagenModelId);
  // IMPL-063: embeddings do dedup semântico (papel datagen no ledger).
  add('datagen', scenarioEmbedModelId(cfg));
  add('reference', cfg.referenceModelId);
  add('reference', cfg.secondReferenceModelId);
  add('rewriter', cfg.optimizerModelId);
  return out;
}

export interface LgpdViolation {
  role: LgpdRole | 'config';
  modelId?: string;
  motivo: LgpdBlockReason;
  message: string;
}

export interface RunComplianceCheck {
  sensivel: boolean;
  area?: string;
  health?: AllowlistHealth;
  violations: LgpdViolation[];
}

/** Checa um RunConfig contra a política (puro; quem lança é `assertRunCompliance`). */
export function checkRunCompliance(
  cfg: ComplianceConfigLike,
  data: LgpdData,
  now: Date | number = Date.now(),
): RunComplianceCheck {
  const area = cfg.compliance?.area;
  if (!area || area === AREA_LIVRE) return { sensivel: false, violations: [] };
  if (!data.areas.some((a) => a.id === area)) {
    return {
      sensivel: true,
      area,
      violations: [{ role: 'config', motivo: 'area_desconhecida', message: `área LGPD desconhecida: "${area}"` }],
    };
  }
  // Área não sensível ("geral"): segue CONSULTIVA — não recusa a run.
  if (!isSensitiveArea(area, data)) return { sensivel: false, area, violations: [] };

  const health = allowlistHealth(data.allowlist, now);
  const incluir = cfg.compliance?.includeRessalvas === true;
  const violations: LgpdViolation[] = [];
  for (const { role, modelId } of runModelRoles(cfg)) {
    const p = permissionWith(modelId, area, data, health);
    if (statusAllowed(p.status, incluir)) continue;
    const motivo = p.motivo ?? 'ressalvas_excluidas';
    violations.push({
      role,
      modelId,
      motivo,
      message: `${ROLE_TEXT[role]} ${modelId}: ${LGPD_BLOCK_REASON_TEXT[motivo]}`,
    });
  }
  // IMPL-040 (revisão): o executor do agente (`pi --provider openrouter`) chama
  // o provedor por conta própria, por FORA de `OpenRouterGateway.buildBody` —
  // as requisições sairiam sem os 4 campos e com fallback livre. Fail-closed
  // até o proxy do sandbox injetar a política (mesma lógica do IMPL-042).
  if (cfg.agent !== undefined && cfg.agent !== null) {
    violations.push({
      role: 'competitor',
      motivo: 'roteamento_incompleto',
      message:
        'modo agente: o executor do agente fala com o provedor FORA do gateway e não envia os 4 ' +
        'campos de privacidade (zdr, data_collection, only, allow_fallbacks) — em área sensível, ' +
        'rode sem agente',
    });
  }
  return { sensivel: true, area, health, violations };
}

/** Erro de POLÍTICA (não de rede): a run sensível não pode começar. */
export class LgpdPolicyError extends Error {
  readonly code = 'LGPD_POLICY';
  readonly violations: LgpdViolation[];
  // Sem "parameter property": o gerador roda este arquivo por strip de tipos.
  constructor(message: string, violations: LgpdViolation[]) {
    super(message);
    this.name = 'LgpdPolicyError';
    this.violations = violations;
  }
}

/** Reconhece o erro sem `instanceof` (ESM com instância dupla do módulo). */
export function isLgpdPolicyError(err: unknown): err is LgpdPolicyError {
  return Boolean(err && typeof err === 'object' && (err as { code?: unknown }).code === 'LGPD_POLICY');
}

/**
 * Pré-voo fail-closed: lança ANTES de qualquer chamada de LLM se o modo sensível
 * estiver ligado e algum papel usar modelo fora da allowlist (ou o snapshot
 * estiver vencido/ausente). Área livre/consultiva passa direto.
 */
export function assertRunCompliance(
  cfg: ComplianceConfigLike,
  data: LgpdData,
  now: Date | number = Date.now(),
): RunComplianceCheck {
  const check = checkRunCompliance(cfg, data, now);
  if (check.violations.length) {
    const cab = check.health && !check.health.usable ? ` ${check.health.message}` : '';
    throw new LgpdPolicyError(
      `Modo sensível LGPD (área "${check.area}") recusado — desconhecido ⇒ bloqueado.${cab} ` +
        check.violations.map((v) => v.message).join('; ') +
        '.',
      check.violations,
    );
  }
  return check;
}

// ---------------------------------------------------------------------------
// Geração do snapshot (o ÚNICO gerador; o script só busca e grava)
// ---------------------------------------------------------------------------

function dataArray(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  const d = (payload as { data?: unknown } | null)?.data;
  return Array.isArray(d) ? d : null;
}

function isoDay(now: Date | number): string {
  return new Date(toMs(now)).toISOString().slice(0, 10);
}

/**
 * Deriva o snapshot de GET /models + GET /endpoints/zdr (payloads crus).
 * Lança em vez de gravar lixo: catálogo ou lista ZDR vazios/ilegíveis são
 * falha de busca, e um snapshot "vazio mas fresco" pareceria válido.
 */
export function buildAllowlistSnapshot(input: {
  models: unknown;
  zdr: unknown;
  now: Date | number;
  fonte: string;
}): LgpdAllowlistSnapshot {
  const rawModels = dataArray(input.models);
  const rawZdr = dataArray(input.zdr);
  if (!rawModels) throw new Error('GET /models sem array `data`: recusando gerar a allowlist.');
  if (!rawZdr) throw new Error('GET /endpoints/zdr sem array `data`: recusando gerar a allowlist.');
  const ids = [
    ...new Set(
      rawModels
        .map((m) => (m as { id?: unknown } | null)?.id)
        .filter((id): id is string => typeof id === 'string' && id.trim() !== ''),
    ),
  ].sort();
  if (ids.length === 0) throw new Error('Catálogo vazio em GET /models: recusando gerar a allowlist.');
  if (rawZdr.length === 0) throw new Error('Lista vazia em GET /endpoints/zdr: recusando gerar a allowlist.');

  const porModelo = new Map<string, Map<string, AllowlistEndpoint>>(ids.map((id) => [id, new Map()]));
  let fora = 0;
  for (const raw of rawZdr) {
    const e = (raw ?? {}) as Record<string, unknown>;
    const modelId = typeof e.model_id === 'string' ? e.model_id : '';
    const tag = typeof e.tag === 'string' ? e.tag.trim() : '';
    const provider = typeof e.provider_name === 'string' ? e.provider_name.trim() : '';
    const eps = porModelo.get(modelId);
    if (!eps) {
      fora += 1;
      continue;
    }
    // Endpoint sem tag/provedor não é identificável ⇒ não entra (fail-closed).
    if (!tag || !provider) continue;
    const prev = eps.get(tag);
    // A mesma tag pode vir repetida (variações de preço): cache implícita em
    // QUALQUER cópia marca o endpoint (postura conservadora).
    const cache = e.supports_implicit_caching === true || prev?.implicitCaching === true;
    eps.set(tag, { tag, provider: prev?.provider ?? provider, ...(cache ? { implicitCaching: true } : {}) });
  }

  const modelos: Record<string, AllowlistEndpoint[]> = {};
  for (const id of ids) {
    modelos[id] = [...porModelo.get(id)!.values()].sort((a, b) => a.tag.localeCompare(b.tag));
  }
  return {
    format: ALLOWLIST_FORMAT,
    data_geracao: isoDay(input.now),
    validade_dias: ALLOWLIST_MAX_AGE_DAYS,
    alvo_operacional_dias: ALLOWLIST_TARGET_AGE_DAYS,
    fonte: input.fonte,
    total_modelos_catalogo: ids.length,
    total_endpoints_zdr: rawZdr.length,
    endpoints_zdr_fora_do_catalogo: fora,
    modelos,
  };
}

/**
 * Serialização ESTÁVEL (um modelo por linha): diffs de regeneração legíveis
 * no PR da CI e arquivo ~50 KB em vez de ~200 KB indentado.
 */
export function serializeAllowlistSnapshot(s: LgpdAllowlistSnapshot): string {
  const { modelos, ...cab } = s;
  const head = Object.entries(cab).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  const linhas = Object.keys(modelos)
    .sort()
    .map((id) => `    ${JSON.stringify(id)}: ${JSON.stringify(modelos[id])}`);
  return `{\n${head.join(',\n')},\n  "modelos": {\n${linhas.join(',\n')}\n  }\n}\n`;
}

// ---------------------------------------------------------------------------
// Relatório (models allowlist --check, gerador, CI)
// ---------------------------------------------------------------------------

export interface AllowlistAreaReport {
  sensivel: boolean;
  permitidos: number;
  com_ressalvas: number;
  bloqueados: number;
  /** Liberados com criador/provedor desconhecido — o limiar é ZERO. */
  desconhecidos_liberados: number;
  /**
   * `bloqueados` quebrado por motivo (IMPL-101: a redução de oferta do modo
   * sensível — variantes, roteadores, cache implícita — aparece, não some).
   */
  bloqueados_por_motivo: Partial<Record<LgpdBlockReason, number>>;
}

export interface AllowlistReport {
  health: AllowlistHealth;
  porArea: Record<string, AllowlistAreaReport>;
  /** Provedores com endpoint ZDR no snapshot que a base não conhece (excluídos). */
  provedoresForaDoMapa: string[];
  /** Modelos com ≥1 endpoint elegível numa região da UE. */
  modelosComEndpointUe: number;
}

/**
 * Contagem por área sobre os modelos do snapshot + a métrica
 * `desconhecidos_liberados`, recalculada de forma INDEPENDENTE da regra (um
 * liberado precisa ter criador conhecido e só endpoints de provedor mapeado).
 */
export function allowlistReport(data: LgpdData, now: Date | number = Date.now()): AllowlistReport {
  const health = allowlistHealth(data.allowlist, now);
  const modelos = data.allowlist && health.state !== 'invalida' ? data.allowlist.modelos : {};
  const ids = Object.keys(modelos).sort();
  const porArea: Record<string, AllowlistAreaReport> = {};
  for (const a of data.areas) {
    const r: AllowlistAreaReport = {
      sensivel: isSensitiveArea(a.id, data),
      permitidos: 0,
      com_ressalvas: 0,
      bloqueados: 0,
      desconhecidos_liberados: 0,
      bloqueados_por_motivo: {},
    };
    for (const id of ids) {
      const p = permissionWith(id, a.id, data, health);
      if (p.status === 'permitido') r.permitidos += 1;
      else if (p.status === 'permitido com ressalvas') r.com_ressalvas += 1;
      else {
        r.bloqueados += 1;
        const m = p.motivo ?? 'nao_recomendado';
        r.bloqueados_por_motivo[m] = (r.bloqueados_por_motivo[m] ?? 0) + 1;
      }
      if (r.sensivel && p.status !== 'não recomendado') {
        const desconhecido =
          !isKnownCreator(id, data) ||
          !p.endpoints?.length ||
          p.endpoints.some((ep) => !data.providers[ep.provider]);
        if (desconhecido) r.desconhecidos_liberados += 1;
      }
    }
    porArea[a.id] = r;
  }
  const provs = new Set<string>();
  let ue = 0;
  for (const id of ids) {
    const eps = Array.isArray(modelos[id]) ? modelos[id] : [];
    for (const ep of eps) if (!data.providers[ep.provider]) provs.add(ep.provider);
    if (eps.some((ep) => endpointExclusion(ep, data) === null && isEuEndpointTag(ep.tag, data))) ue += 1;
  }
  return { health, porArea, provedoresForaDoMapa: [...provs].sort(), modelosComEndpointUe: ue };
}
