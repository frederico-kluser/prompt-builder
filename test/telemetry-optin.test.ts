// IMPL-120 (R-01b:REC-8) — telemetria opt-in + IMPL-120/R-01b:REC-9 (flag de
// supressão de atribuição):
//   (1) com telemetria desligada (default) saem 0 requisições de telemetria;
//   (2) com opt-in, o payload é 1:1 com o schema PUBLICADO (snapshot);
//   (3) nenhum envio em CI/agente salvo opt-in explícito;
//   (4) `PROMPT_BUILDER_NO_ATTRIBUTION` suprime os headers de atribuição
//       (HTTP-Referer/X-Title/X-OpenRouter-Categories — dado enviado ao
//       OpenRouter). ⚠️ A aplicação da flag no gateway (src/openrouter.ts e o
//       shim web) e a menção em help/agent-docs ficaram FORA da fronteira do
//       lote O-p2-resto: aqui se prova o contrato canónico que o gateway passa
//       a consumir (`attributionHeadersFor`), não o fio ainda por ligar.
//
// Tudo com transporte falso: zero rede, zero gasto.

import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTION_HEADER_NAMES,
  TELEMETRY_ALLOWLIST,
  TELEMETRY_EVENT_NAMES,
  TELEMETRY_PAYLOAD_SCHEMA,
  TELEMETRY_PUBLICATION_POLICY,
  TelemetryCounters,
  attributionHeadersFor,
  buildTelemetryPayload,
  isAgentOrCiEnv,
  isAttributionSuppressed,
  isTelemetryEnabled,
  isTelemetryUploadEnabled,
  telemetryEndpoint,
  uploadTelemetry,
  type TelemetryFetchLike,
} from '../src/cli/commands/telemetry.js';

/** fetch gravador: conta chamadas e guarda o corpo enviado. */
function fetchGravador(): { fetch: TelemetryFetchLike; urls: string[]; bodies: string[] } {
  const urls: string[] = [];
  const bodies: string[] = [];
  const fetch: TelemetryFetchLike = async (url, init) => {
    urls.push(url);
    bodies.push(String(init?.body ?? ''));
    return new Response('{}', { status: 200 });
  };
  return { fetch, urls, bodies };
}

describe('IMPL-120 (1) — telemetria DESLIGADA por default: 0 requisições', () => {
  it('sem env nenhum, nada liga e nada é enviado', async () => {
    expect(isTelemetryEnabled({})).toBe(false);
    expect(isTelemetryUploadEnabled({})).toBe(false);
    const g = fetchGravador();
    const r = await uploadTelemetry(buildTelemetryPayload(new TelemetryCounters(), { appVersion: '0.0.0' }), {
      env: {},
      fetch: g.fetch,
    });
    expect(r).toEqual({ sent: false, reason: 'disabled' });
    expect(g.urls).toHaveLength(0); // proxy/strace veria silêncio
  });

  it('valor qualquer que não seja opt-in explícito continua DESLIGADO', async () => {
    for (const v of ['', 'off', 'maybe', 'PROMPT_BUILDER_TELEMETRY']) {
      expect(isTelemetryEnabled({ PROMPT_BUILDER_TELEMETRY: v }), v).toBe(false);
    }
    for (const v of ['on', '1', 'true', ' ON ']) {
      expect(isTelemetryEnabled({ PROMPT_BUILDER_TELEMETRY: v }), v).toBe(true);
    }
  });
});

describe('IMPL-120 (2) — payload 1:1 com o schema publicado (snapshot)', () => {
  it('snapshot do payload: campos exatos, SEM id persistente', () => {
    const counters = new TelemetryCounters();
    counters.record('docs.list');
    counters.record('budget.exhausted', 2);
    const payload = buildTelemetryPayload(counters, {
      appVersion: '0.1.0',
      now: new Date('2026-09-30T12:00:00.000Z'),
    });
    // SNAPSHOT do contrato público — mudou aqui, mudou o schema (e vice-versa).
    expect(payload).toEqual({
      schema: 'prompt-builder-telemetry@1',
      schemaVersion: 1,
      sentAt: '2026-09-30T12:00:00.000Z',
      appVersion: '0.1.0',
      counters: {
        'docs.list': 1,
        'run.first_completed': 0,
        'budget.exhausted': 2,
        'runs.export': 0,
      },
    });
    // SEM id persistente: nem utilizador, nem máquina, nem instalação, nem sessão.
    expect(Object.keys(payload).sort()).toEqual(['appVersion', 'counters', 'schema', 'schemaVersion', 'sentAt']);
    expect(/id|uuid|machine|user|session/i.test(JSON.stringify(payload).replace('appVersion', ''))).toBe(false);
  });

  it('payload 1:1 com TELEMETRY_PAYLOAD_SCHEMA (required/properties batem)', () => {
    const payload = buildTelemetryPayload(new TelemetryCounters(), { appVersion: '0.1.0' });
    const schema = TELEMETRY_PAYLOAD_SCHEMA as unknown as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(Object.keys(payload).sort()).toEqual([...schema.required].sort());
    expect(Object.keys(schema.properties).sort()).toEqual([...schema.required].sort());
    expect(schema.properties.counters).toMatchObject({ additionalProperties: false });
    // Allowlist publicada = eventos do payload (allowlist versionada).
    expect(TELEMETRY_EVENT_NAMES.map((n) => n).sort()).toEqual(
      TELEMETRY_ALLOWLIST.map((e) => e.name).sort(),
    );
    for (const e of TELEMETRY_ALLOWLIST) expect(e.description.trim().length).toBeGreaterThan(10);
    // Política de publicação versionada: retenção 90 dias, células só com k >= 20.
    expect(TELEMETRY_PUBLICATION_POLICY).toEqual({ retentionDays: 90, minCellCount: 20 });
  });

  it('evento FORA da allowlist nunca entra no payload (nem engolido em silêncio)', () => {
    const counters = new TelemetryCounters();
    expect(counters.record('evento-que-ninguem-conhece')).toBe(false);
    expect(counters.record('docs.list')).toBe(true);
    const payload = buildTelemetryPayload(counters, { appVersion: '0.1.0' });
    expect(payload.counters).toEqual({
      'docs.list': 1,
      'run.first_completed': 0,
      'budget.exhausted': 0,
      'runs.export': 0,
    });
    // Auditável à parte (o "whitelist engole campo novo" é o pesadelo da casa).
    expect(counters.droppedUnknown).toEqual({ 'evento-que-ninguem-conhece': 1 });
  });

  it('opt-in envia o payload EXATO por POST no endpoint', async () => {
    const g = fetchGravador();
    const payload = buildTelemetryPayload(new TelemetryCounters(), { appVersion: '0.1.0' });
    const env = { PROMPT_BUILDER_TELEMETRY: 'on', PROMPT_BUILDER_TELEMETRY_URL: 'https://telemetria.exemplo/v1' };
    expect(isTelemetryUploadEnabled(env)).toBe(true);
    const r = await uploadTelemetry(payload, { env, fetch: g.fetch });
    expect(r).toEqual({ sent: true, status: 200 });
    expect(g.urls).toEqual(['https://telemetria.exemplo/v1']);
    expect(JSON.parse(g.bodies[0])).toEqual(JSON.parse(JSON.stringify(payload)));
  });

  it('opt-in SEM endpoint não envia nada (nunca inventa destino)', async () => {
    const g = fetchGravador();
    const env = { PROMPT_BUILDER_TELEMETRY: 'on' };
    expect(telemetryEndpoint(env)).toBeNull();
    const r = await uploadTelemetry(buildTelemetryPayload(new TelemetryCounters(), { appVersion: '0.1.0' }), {
      env,
      fetch: g.fetch,
    });
    expect(r).toEqual({ sent: false, reason: 'no-endpoint' });
    expect(g.urls).toHaveLength(0);
  });
});

describe('IMPL-120 (3) — CI/agente: nenhum envio salvo opt-in explícito', () => {
  it('CI=true e CLAUDECODE=1 continuam mudos sem a variável de opt-in', async () => {
    for (const env of [{ CI: 'true' }, { CLAUDECODE: '1' }, { CI: 'true', CLAUDECODE: '1' }]) {
      expect(isAgentOrCiEnv(env), JSON.stringify(env)).toBe(true);
      expect(isTelemetryEnabled(env), JSON.stringify(env)).toBe(false);
      const g = fetchGravador();
      const r = await uploadTelemetry(buildTelemetryPayload(new TelemetryCounters(), { appVersion: '0.0.0' }), {
        env: { ...env, PROMPT_BUILDER_TELEMETRY_URL: 'https://telemetria.exemplo/v1' },
        fetch: g.fetch,
      });
      expect(r.sent).toBe(false);
      expect(g.urls).toHaveLength(0);
    }
  });

  it('em CI, SÓ o opt-in explícito (=on) liga — e aí envia', async () => {
    const env = {
      CI: 'true',
      PROMPT_BUILDER_TELEMETRY: 'on',
      PROMPT_BUILDER_TELEMETRY_URL: 'https://telemetria.exemplo/v1',
    };
    const g = fetchGravador();
    const r = await uploadTelemetry(buildTelemetryPayload(new TelemetryCounters(), { appVersion: '0.0.0' }), {
      env,
      fetch: g.fetch,
    });
    expect(r.sent).toBe(true);
    expect(g.urls).toHaveLength(1);
  });
});

describe('IMPL-120 (4) — flag PROMPT_BUILDER_NO_ATTRIBUTION suprime os headers de atribuição', () => {
  it('sem a flag os headers saem; com a flag, NENHUM (objeto vazio)', () => {
    const base = { appUrl: 'https://app.exemplo', appTitle: 'Prompt Builder', categories: 'agriculture' };
    expect(attributionHeadersFor(base, {})).toEqual({
      'HTTP-Referer': 'https://app.exemplo',
      'X-Title': 'Prompt Builder',
      'X-OpenRouter-Categories': 'agriculture',
    });
    for (const v of ['on', '1', 'true', 'yes']) {
      expect(isAttributionSuppressed({ PROMPT_BUILDER_NO_ATTRIBUTION: v }), v).toBe(true);
      expect(attributionHeadersFor(base, { PROMPT_BUILDER_NO_ATTRIBUTION: v }), v).toEqual({});
    }
    for (const v of ['', 'off', '0']) {
      expect(isAttributionSuppressed({ PROMPT_BUILDER_NO_ATTRIBUTION: v }), v).toBe(false);
    }
  });

  it('o contrato dos 3 headers é público e nominal (eles são dado enviado ao OpenRouter)', () => {
    expect([...ATTRIBUTION_HEADER_NAMES]).toEqual(['HTTP-Referer', 'X-Title', 'X-OpenRouter-Categories']);
    // A supressão cobre exatamente a lista publicada: nenhum header sobra.
    const suprimido = attributionHeadersFor(
      { appUrl: 'https://app.exemplo', appTitle: 'Prompt Builder', categories: 'x' },
      { PROMPT_BUILDER_NO_ATTRIBUTION: 'on' },
    );
    for (const h of ATTRIBUTION_HEADER_NAMES) expect(suprimido[h]).toBeUndefined();
  });
});