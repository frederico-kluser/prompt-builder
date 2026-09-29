// IMPL-101 (R-16:REC-4) — bloqueios de CATÁLOGO do modo sensível.
//
// Antes: `:batch`, `:free` e `openrouter/*` só eram recusados por ACIDENTE
// (`:batch` sem endpoint no snapshot; `:free`/roteador com criador
// desconhecido) — um `:free` com endpoint ZDR passaria assim que o criador
// fosse classificado. E endpoints com `supports_implicit_caching` entravam em
// `provider.only` (18 rotas da área "saúde" no snapshot real iam SÓ por
// endpoints com cache implícita, que fica fora da definição de ZDR).
//
// Critérios provados aqui (zero rede, zero gasto):
//   (1) roteamento: `*:batch`, `*:free` e `openrouter/auto` ⇒ recusa no modo
//       sensível — com motivo PRÓPRIO, mesmo com endpoint ZDR no snapshot;
//   (2) a requisição sensível nunca carrega `X-OpenRouter-Cache` nem um array
//       `models` de fallback na raiz do corpo (snapshot do fio, chat e stream);
//   (3) 0 endpoint com cache implícita na allowlist sensível (snapshot REAL,
//       todo modelo × toda área sensível) — e a redução de oferta é CONTADA por
//       motivo no relatório, nunca escondida.

import { describe, expect, it } from 'vitest';
import * as core from '../src/engine/lgpdCore.js';
import { sensitiveRoutingFor } from '../src/engine/sensitiveRouting.js';
import * as nodeLgpd from '../src/lgpd.js';
import * as nodeGw from '../src/openrouter.js';
import * as webGw from '../web/src/engine/openrouter.js';
import { BudgetLedger } from '../src/budget.js';
import { fakeOpenRouter, noSleep } from './fakeOpenRouter.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const REAL = nodeLgpd.getLgpdData();
const BASE: core.LgpdData = { ...REAL, allowlist: null };
const SENSIVEIS = REAL.areas.filter((a) => core.isSensitiveArea(a.id, REAL)).map((a) => a.id);
/** "Agora" = dia da geração do snapshot real (o teste não envelhece com o calendário). */
const AGORA_REAL = Date.parse(`${REAL.allowlist!.data_geracao}T12:00:00Z`);

type ZdrRow = { model_id: string; provider_name: string; tag: string; supports_implicit_caching?: boolean };

/** Snapshot sintético fresco a partir de linhas de /endpoints/zdr. */
function dadosCom(rows: ZdrRow[]): core.LgpdData {
  const ids = [...new Set(rows.map((r) => r.model_id))];
  const snap = core.buildAllowlistSnapshot({
    models: { data: ids.map((id) => ({ id, name: id })) },
    zdr: { data: rows },
    now: Date.now(),
    fonte: 'teste',
  });
  return { ...BASE, allowlist: snap };
}

// Criadores CONHECIDOS e provedores MAPEADOS — o único motivo de recusa que
// sobra para cada id é o que o IMPL-101 introduz.
const ROWS: ZdrRow[] = [
  // Variantes e roteador COM endpoint ZDR de provedor mapeado (o caso perigoso).
  { model_id: 'mistralai/mistral-large:free', provider_name: 'Mistral', tag: 'mistral/eu' },
  { model_id: 'mistralai/mistral-large:batch', provider_name: 'Mistral', tag: 'mistral/eu' },
  { model_id: 'openrouter/auto', provider_name: 'Mistral', tag: 'mistral/eu' },
  // Só endpoint com cache implícita.
  { model_id: 'mistralai/so-cache', provider_name: 'Mistral', tag: 'mistral/eu', supports_implicit_caching: true },
  // Misto: o endpoint com cache sai de `only`, o outro fica.
  { model_id: 'mistralai/misto', provider_name: 'Mistral', tag: 'mistral/eu' },
  { model_id: 'mistralai/misto', provider_name: 'Mistral', tag: 'mistral/cache', supports_implicit_caching: true },
  // Controle: modelo limpo passa.
  { model_id: 'mistralai/limpo', provider_name: 'Mistral', tag: 'mistral/eu' },
];

describe('IMPL-101 (1) — :batch, :free e openrouter/* recusados no modo sensível (motivo próprio)', () => {
  const data = dadosCom(ROWS);

  it('sensitiveIdBlock reconhece a forma do id (maiúsculas, ~prefixo) e não pega id comum', () => {
    expect(core.sensitiveIdBlock('x/y:batch')).toBe('variante_batch');
    expect(core.sensitiveIdBlock('X/Y:FREE')).toBe('variante_free');
    expect(core.sensitiveIdBlock('openrouter/auto')).toBe('roteador_openrouter');
    expect(core.sensitiveIdBlock('~openrouter/qualquer')).toBe('roteador_openrouter');
    expect(core.sensitiveIdBlock('mistralai/mistral-large')).toBeNull();
    expect(core.sensitiveIdBlock('mistralai/free-model')).toBeNull(); // "free" no nome ≠ variante
  });

  it('sensitiveRoute recusa as 3 formas em TODA área sensível — mesmo com endpoint ZDR elegível no snapshot', () => {
    const casos: Array<[string, core.LgpdBlockReason]> = [
      ['mistralai/mistral-large:batch', 'variante_batch'],
      ['mistralai/mistral-large:free', 'variante_free'],
      ['openrouter/auto', 'roteador_openrouter'],
    ];
    for (const area of [...SENSIVEIS, 'geral']) {
      for (const [id, motivo] of casos) {
        const r = core.sensitiveRoute(id, area, data);
        expect(r.ok, `${id}/${area}`).toBe(false);
        if (!r.ok) {
          expect(r.motivo, `${id}/${area}`).toBe(motivo);
          expect(r.message).toContain(core.LGPD_BLOCK_REASON_TEXT[motivo]);
        }
      }
      // Controle: o modelo limpo do MESMO snapshot passa (a recusa é da forma, não do snapshot).
      const limpo = core.sensitiveRoute('mistralai/limpo', area, data);
      expect(limpo.ok, `limpo/${area}`).toBe(true);
    }
  });

  it('o pré-voo da run recusa qualquer papel com essas formas; o filtro da UI diz o motivo', () => {
    for (const area of SENSIVEIS) {
      const chk = core.checkRunCompliance(
        {
          compliance: { area, includeRessalvas: true },
          datagenModelId: 'mistralai/limpo',
          judgeModelIds: ['openrouter/auto'],
          competitorModelIds: ['mistralai/mistral-large:free', 'mistralai/mistral-large:batch'],
        },
        data,
      );
      expect(chk.violations.map((v) => [v.role, v.motivo]).sort()).toEqual(
        [
          ['competitor', 'variante_batch'],
          ['competitor', 'variante_free'],
          ['judge', 'roteador_openrouter'],
        ].sort(),
      );
      const f = core.filterModels(
        ['mistralai/mistral-large:free', 'openrouter/auto', 'mistralai/limpo'].map((id) => ({ id })),
        area,
        true,
        data,
      );
      expect(f.allowed.map((m) => m.id)).toEqual(['mistralai/limpo']);
      expect(f.reasons.get('mistralai/mistral-large:free')).toBe('variante_free');
      expect(f.reasons.get('openrouter/auto')).toBe('roteador_openrouter');
    }
  });

  it('área "geral" consultiva (sem modo sensível forçado) NÃO passa a recusar variantes', () => {
    expect(core.permissionOf('mistralai/mistral-large:free', 'geral', data).motivo).not.toBe('variante_free');
    expect(core.checkRunCompliance({ compliance: { area: 'geral', includeRessalvas: true }, competitorModelIds: ['openrouter/auto'] }, data).violations).toEqual([]);
  });
});

describe('IMPL-101 (3) — endpoint com cache implícita fica FORA da allowlist sensível', () => {
  const data = dadosCom(ROWS);

  it('endpointExclusion: provedor aceitável + cache implícita ⇒ cache_implicito (provedor ruim ainda vence)', () => {
    expect(core.endpointExclusion({ tag: 'mistral/eu', provider: 'Mistral', implicitCaching: true }, BASE)).toBe('cache_implicito');
    expect(core.endpointExclusion({ tag: 'mistral/eu', provider: 'Mistral' }, BASE)).toBeNull();
    expect(core.endpointExclusion({ tag: 'x', provider: 'ProvedorNovo', implicitCaching: true }, BASE)).toBe('provedor_desconhecido');
  });

  it('só-cache ⇒ recusa com motivo cache_implicito; misto ⇒ `only` sem o endpoint com cache', () => {
    for (const area of SENSIVEIS) {
      const so = core.sensitiveRoute('mistralai/so-cache', area, data);
      expect(so.ok).toBe(false);
      if (!so.ok) expect(so.motivo).toBe('cache_implicito');
      const misto = core.sensitiveRoute('mistralai/misto', area, data);
      expect(misto.ok).toBe(true);
      if (misto.ok) {
        expect(misto.only).toEqual(['mistral/eu']);
        expect(misto.endpoints.some((e) => e.implicitCaching)).toBe(false);
      }
    }
  });

  it('snapshot REAL: 0 endpoint com cache implícita em rota sensível — e a regra MORDE (há modelo barrado por ela)', () => {
    const ids = Object.keys(REAL.allowlist!.modelos);
    let barradosPeloCache = 0;
    for (const area of SENSIVEIS) {
      for (const id of ids) {
        const r = core.sensitiveRoute(id, area, REAL, AGORA_REAL);
        if (r.ok) {
          expect(r.endpoints.filter((e) => e.implicitCaching), `${id}/${area}`).toEqual([]);
          expect(core.sensitiveIdBlock(id), `${id}/${area}`).toBeNull();
        } else if (r.motivo === 'cache_implicito') {
          barradosPeloCache += 1;
        }
      }
    }
    expect(barradosPeloCache).toBeGreaterThan(0);
    // Os `:free` com endpoint ZDR no snapshot real são recusados pela forma.
    const freeComZdr = ids.filter((id) => id.endsWith(':free') && REAL.allowlist!.modelos[id].length > 0);
    for (const id of freeComZdr) {
      const r = core.sensitiveRoute(id, 'saude', REAL, AGORA_REAL);
      expect(r.ok ? null : r.motivo, id).toBe('variante_free');
    }
  });

  it('a redução de oferta é CONTADA por motivo no relatório (models allowlist / gerador)', () => {
    const rep = core.allowlistReport(REAL, AGORA_REAL);
    for (const area of SENSIVEIS) {
      const a = rep.porArea[area];
      const soma = Object.values(a.bloqueados_por_motivo).reduce((s, n) => s + (n ?? 0), 0);
      expect(soma, area).toBe(a.bloqueados);
      expect(a.bloqueados_por_motivo.cache_implicito ?? 0, area).toBeGreaterThan(0);
      expect(a.bloqueados_por_motivo.variante_batch ?? 0, area).toBeGreaterThan(0);
      expect(a.bloqueados_por_motivo.variante_free ?? 0, area).toBeGreaterThan(0);
    }
  });
});

describe('IMPL-101 (2) — o fio sensível nunca leva X-OpenRouter-Cache nem `models` de fallback na raiz', () => {
  const MSGS = [{ role: 'user' as const, content: 'Qual o preparo do exame agendado?' }];
  const GATEWAYS = [
    ['Node (src/openrouter)', nodeGw.createGateway],
    ['navegador (web/src/engine/openrouter)', webGw.createGateway],
  ] as const;

  for (const [nome, criar] of GATEWAYS) {
    it(`${nome}: chat e stream sensíveis — snapshot de headers e corpo`, async () => {
      const routing = sensitiveRoutingFor({ compliance: { area: 'saude', includeRessalvas: true } }, dadosCom(ROWS));
      expect(routing).toBeDefined();
      const fake = fakeOpenRouter();
      const gw = criar({ fetch: fake.fetch, sleep: noSleep });
      const sink = new BudgetLedger({ budgetUsd: 10, estimateCall: () => 0.01 });
      sink.setSensitiveRouting(routing);
      const params = { apiKey: KEY, modelId: 'mistralai/misto', messages: MSGS, role: 'judge' as const, sink };
      await gw.chatCompletion(params);
      await gw.chatCompletionStream(params);
      const chats = fake.chatRequests();
      expect(chats).toHaveLength(2);
      for (const req of chats) {
        const headers = Object.keys(req.headers).map((h) => h.toLowerCase());
        expect(headers, 'X-OpenRouter-Cache nunca vai no fio sensível').not.toContain('x-openrouter-cache');
        expect(req.body && 'models' in req.body, 'sem array `models` de fallback na raiz').toBe(false);
        // O endpoint com cache implícita não entra em `provider.only`.
        expect(req.body?.provider).toMatchObject({
          zdr: true,
          data_collection: 'deny',
          only: ['mistral/eu'],
          allow_fallbacks: false,
        });
        expect(req.model).toBe('mistralai/misto');
      }
    });
  }
});
