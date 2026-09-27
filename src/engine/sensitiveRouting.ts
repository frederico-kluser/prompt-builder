// Modo "dados sensíveis" LGPD — ENFORCEMENT no gateway (IMPL-040, R-16:REC-1).
//
// Antes o pré-voo (IMPL-041) só RECUSAVA a run fora da allowlist, mas as
// requisições que saíam não carregavam campo de privacidade nenhum: o
// OpenRouter roteava com `allow_fallbacks` no default (true) e podia cair num
// endpoint que retém dados. Agora, em área sensível, TODA requisição de chat
// (datagen, gabarito, competidor, juiz, duelo, reescritor) sai com
//
//   provider: { zdr: true, data_collection: 'deny', only: [tags ZDR da
//               allowlist do modelo], allow_fallbacks: false }
//
// e é FAIL-CLOSED: se faltar QUALQUER um dos 4 campos (modelo sem rota na
// allowlist, snapshot ausente/vencido, política malformada) a chamada lança
// `LgpdPolicyError` ANTES do fetch — nunca sai requisição sensível sem eles.
//
// Onde a política mora: no LEDGER da run/sessão (`CostSink.sensitiveRouting`),
// que já viaja em toda chamada dos 6 papéis (IMPL-021). O gateway lê do sink —
// não de estado de módulo — então não há como o modo "sumir" por instância
// dupla de ESM nem por troca do gateway padrão. Um ponto de aplicação só:
// `OpenRouterGateway.buildBody` → `applySensitiveRouting`.
//
// Puro (sem `node:*`/`process.env`): roda igual no Node e no navegador.

import {
  isSensitiveCompliance,
  LGPD_BLOCK_REASON_TEXT,
  LgpdPolicyError,
  sensitiveRoute,
  type ComplianceConfigLike,
  type LgpdBlockReason,
  type LgpdData,
  type LgpdRole,
  type SensitiveRoute,
} from './lgpdCore.js';

/** Os 4 campos de privacidade que TODA requisição sensível precisa carregar. */
export interface SensitiveProviderFields {
  zdr: true;
  data_collection: 'deny';
  only: string[];
  allow_fallbacks: false;
}

/** Política de roteamento do modo sensível de UMA run/sessão (anexada ao ledger). */
export interface SensitiveRouting {
  /** Área LGPD que ligou o modo (vai na mensagem de erro). */
  readonly area: string;
  /** Rota do modelo: as tags de endpoint ZDR da allowlist p/ `provider.only`. */
  routeFor(modelId: string): SensitiveRoute;
}

/**
 * Política do modo sensível para um config, ou `undefined` se o config não
 * liga o modo (sem compliance, `livre`, ou área consultiva como "geral").
 * `now` fica FIXO no instante do pré-voo: a run inteira usa a mesma leitura do
 * snapshot (as rotas são memorizadas por modelo).
 */
export function sensitiveRoutingFor(
  cfg: ComplianceConfigLike,
  data: LgpdData,
  now: Date | number = Date.now(),
): SensitiveRouting | undefined {
  if (!isSensitiveCompliance(cfg, data)) return undefined;
  const area = cfg.compliance!.area;
  const rotas = new Map<string, SensitiveRoute>();
  return {
    area,
    routeFor(modelId: string): SensitiveRoute {
      let r = rotas.get(modelId);
      if (!r) {
        r = sensitiveRoute(modelId, area, data, now);
        rotas.set(modelId, r);
      }
      return r;
    },
  };
}

/** Papel do ledger → papel da política (duelo é juiz; gabarito é `reference`). */
const LGPD_ROLE: Record<string, LgpdRole> = {
  datagen: 'datagen',
  gabarito: 'reference',
  competitor: 'competitor',
  judge: 'judge',
  duel: 'judge',
  rewriter: 'rewriter',
  agent: 'competitor',
};

function recusa(role: string, modelId: string, area: string, motivo: LgpdBlockReason, detalhe: string): never {
  const message = `${role} ${modelId}: ${detalhe}`;
  throw new LgpdPolicyError(
    `Modo sensível LGPD (área "${area}"): requisição recusada ANTES do envio — ${message}.`,
    [{ role: LGPD_ROLE[role] ?? 'config', modelId, motivo, message }],
  );
}

/**
 * Os 4 campos estão lá, com os valores exatos? Checagem INDEPENDENTE de quem
 * montou o corpo (é o que o fail-closed promete: não importa o caminho, sem os
 * 4 campos não há fetch). `only` precisa ser lista não vazia de tags.
 */
export function hasSensitiveProviderFields(provider: unknown): provider is SensitiveProviderFields {
  if (!provider || typeof provider !== 'object') return false;
  const p = provider as Record<string, unknown>;
  return (
    p.zdr === true &&
    p.data_collection === 'deny' &&
    p.allow_fallbacks === false &&
    Array.isArray(p.only) &&
    p.only.length > 0 &&
    p.only.every((t) => typeof t === 'string' && t.trim().length > 0)
  );
}

/**
 * Aplica o modo sensível ao corpo de UMA requisição de chat (chamado só por
 * `OpenRouterGateway.buildBody`). Sem política = modo desligado, corpo intacto.
 * Com política: sobrescreve os 4 campos (nada montado antes pode afrouxá-los;
 * `max_price` e afins são preservados) e valida — falhou, lança antes do fetch.
 */
export function applySensitiveRouting(
  body: Record<string, unknown>,
  routing: SensitiveRouting | undefined,
  modelId: string,
  role: string,
): void {
  if (!routing) return;
  const route = routing.routeFor(modelId);
  if (!route.ok) recusa(role, modelId, routing.area, route.motivo, LGPD_BLOCK_REASON_TEXT[route.motivo]);
  const provider = (body.provider ?? {}) as Record<string, unknown>;
  body.provider = {
    ...provider,
    zdr: true,
    data_collection: 'deny',
    only: [...new Set(route.only)],
    allow_fallbacks: false,
  };
  if (!hasSensitiveProviderFields(body.provider)) {
    recusa(role, modelId, routing.area, 'roteamento_incompleto', LGPD_BLOCK_REASON_TEXT.roteamento_incompleto);
  }
}
