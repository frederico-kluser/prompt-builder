// IMPL-022 (a) — navigator.storage.persist() é pedido na PRIMEIRA run, pela
// porta de lançamento da SPA (api.createRun/createSession), ANTES de qualquer
// await: o pedido tem de sair ainda dentro da ativação do clique em Iniciar
// (no Firefox ele vira um prompt ao usuário). Arquivo próprio porque troca o
// motor por mocks — nenhum LLM é chamado, nada é gasto.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { startRun, startTraining } = vi.hoisted(() => ({
  startRun: vi.fn(() => ({ runId: 'run-mock', record: { id: 'run-mock', status: 'running' } })),
  startTraining: vi.fn(async () => ({ sessionId: 'sess-mock', record: { id: 'sess-mock', status: 'running' } })),
}));

vi.mock('../web/src/engine/orchestrator', () => ({
  startRun,
  cancelRun: () => false,
  isRunCancellable: () => false,
}));
vi.mock('../web/src/engine/trainer', () => ({
  startTraining,
  cancelTraining: () => false,
  isTrainingCancellable: () => false,
}));

const api = await import('../web/src/api.js');
const health = await import('../web/src/storageHealth.js');

function memoryLocalStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  } as Storage;
}

let persist: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryLocalStorage());
  // O portão BYOK (IMPL-082) rejeita rotas que gastam sem key (re-prompt): o
  // teste de persistência instala uma de teste, como a UI faria.
  api.setStoredKey('sk-or-v1-teste-persistencia', { remember: true });
  persist = vi.fn(async () => false);
  health.setStorageManager({ persist, persisted: async () => false });
  startRun.mockClear();
  startTraining.mockClear();
});

afterEach(() => {
  health.setStorageManager(undefined);
  vi.unstubAllGlobals();
});

const CONFIG = {
  mode: 'compare',
  theme: 'suporte',
  stages: 1,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  competitorModelIds: ['fake/a', 'fake/b'],
  // IMPL-048: o portão da SPA exige gabarito próprio em training (o teste
  // reusa este config como sessão).
  referenceModelId: 'fake/ref',
} as never;

describe('IMPL-022 (a) persist() na primeira run da página', () => {
  it('createRun pede persist() SÍNCRONO (antes do 1º await) e só na primeira run', async () => {
    const pendente = api.createRun(CONFIG, { costConfirmed: true });
    // Ainda sem nenhum await resolvido: o pedido já saiu (ativação do clique).
    expect(persist).toHaveBeenCalledTimes(1);
    expect(await pendente).toBe('run-mock');
    expect(startRun).toHaveBeenCalledTimes(1);

    await api.createRun(CONFIG, { costConfirmed: true });
    await api.createSession({ ...(CONFIG as object), mode: 'training' } as never, { costConfirmed: true });
    expect(persist).toHaveBeenCalledTimes(1); // memoizado por página
    // Negado => estado visível para a UI (StorageNotice / Configurações).
    expect(api.getStorageHealth()).toMatchObject({ persist: 'denied', persistRequested: true });
    expect(api.storageNoticeContent(api.getStorageHealth(), 'all')).toMatchObject({ kind: 'persist-denied' });
  });

  it('createSession também pede (quando é a primeira run da página)', async () => {
    await api.createSession({ ...(CONFIG as object), mode: 'training' } as never, { costConfirmed: true });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(startTraining).toHaveBeenCalledTimes(1);
  });

  it('o pedido sai mesmo quando a run é recusada pelo portão de custo (clique = gesto do usuário)', async () => {
    // Sem catálogo => preço desconhecido => exige confirmação (IMPL-020).
    const gw = await import('../src/openrouter.js');
    const prev = gw.setDefaultGateway(
      gw.createGateway({ fetch: async () => new Response('{"data":[]}', { status: 200 }) }),
    );
    try {
      const err = await api.createRun(CONFIG).catch((e: unknown) => e);
      expect(api.isCostConfirmationRequired(err)).toBe(true);
      expect(persist).toHaveBeenCalledTimes(1);
      expect(startRun).not.toHaveBeenCalled();
    } finally {
      gw.setDefaultGateway(prev);
    }
  });
});
