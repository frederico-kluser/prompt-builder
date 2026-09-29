// web-code#3 + IMPL-082 (R-10:REC-4) — a key persiste quando o usuário opta, e
// a tela "como sua key é tratada" só diz o que o código FAZ.
//
// O defeito (auditoria web-code#3, severidade alta): o KeySetup chamava
// `setStoredKey(target)` SEM `remember` — a key vivia só em memória, morria em
// todo reload (o KeyFirstGate mandava qualquer rota, inclusive /runs/:id, para
// /welcome) e revalidar uma key lembrada APAGAVA a cópia persistida; enquanto
// isso KeySetup, KeyGate e Ajuda diziam "salva só no localStorage".
//
// Contratos:
//  (i)  «Lembrar neste dispositivo» (opt-in, default desligado) → a key
//       sobrevive ao reload; sem ele, não — e a tela declara o estado real;
//       revalidar uma key lembrada a mantém lembrada;
//  (ii) checklist: CADA afirmação de `keyHandlingFacts` tem um verificador
//       amarrado a um fato do código (cobertura 100% — frase nova sem
//       verificador reprova aqui);
//  (iv) "key sumida" = re-prompt: gate com rota de volta + KeySetup no
//       formulário, nunca erro de fetch.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { accessibleText } from './uxHtml';

const ROOT = process.cwd();
const WEB_SRC = join(ROOT, 'web', 'src');
const WEB_REACT = join(ROOT, 'web', 'node_modules', 'react', 'index.js');
const WEB_REACT_DOM_SERVER = join(ROOT, 'web', 'node_modules', 'react-dom', 'server.node.js');
const temWebDeps = existsSync(WEB_REACT) && existsSync(WEB_REACT_DOM_SERVER);
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/* ------------------------------------------------------------- stubs da UI */

vi.mock('@/lib/utils', () => ({ cn: (...a: unknown[]) => a.filter(Boolean).join(' ') }));
vi.mock('@/components/motion-ui/ui-theme', () => ({
  useMotionUITransition: () => ({}),
  useMotionUITheme: () => ({ motionMode: 'off' }),
}));
vi.mock('@/components/motion-ui/stagger-reveal', () => ({
  StaggerReveal: (p: { children?: unknown }) => p.children,
  StaggerRevealHeadline: (p: { children?: unknown }) => p.children,
  StaggerRevealItem: (p: { children?: unknown }) => p.children,
}));
vi.mock('@/components/motion-ui/multi-state-button', () => ({
  MultiStateButton: (p: { children?: unknown }) => p.children,
}));
vi.mock('@/components/ui/button', () => ({ Button: (p: { children?: unknown }) => p.children }));
vi.mock('@/components/ui/input', () => ({ Input: () => null }));
vi.mock('@/components/ui/switch', async () => {
  const { createElement } = await import(pathToFileURL(WEB_REACT).href);
  return {
    Switch: (p: Record<string, unknown>) =>
      createElement('input', {
        type: 'checkbox',
        role: 'switch',
        'data-lembrar': '',
        defaultChecked: p.checked,
        'aria-labelledby': p['aria-labelledby'],
      }),
  };
});

/* --------------------------------------------------------- storage falso */

const KEY_STORAGE = 'openrouter_api_key';
const KEY_REMEMBER = 'openrouter_api_key:remember';

class FakeLocalStorage {
  mapa = new Map<string, string>();
  getItem(k: string): string | null {
    return this.mapa.has(k) ? this.mapa.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.mapa.set(k, String(v));
  }
  removeItem(k: string): void {
    this.mapa.delete(k);
  }
  clear(): void {
    this.mapa.clear();
  }
  get length(): number {
    return this.mapa.size;
  }
}

let ls: FakeLocalStorage;

beforeEach(() => {
  vi.unstubAllGlobals();
  ls = new FakeLocalStorage();
  vi.stubGlobal('localStorage', ls);
  vi.resetModules(); // "reload": a key em memória nasce do zero
});

async function abrirApi() {
  return (await import('../web/src/api.js')) as typeof import('../web/src/api.js');
}

async function renderKeySetup(): Promise<string> {
  const { createElement } = await import(pathToFileURL(WEB_REACT).href);
  const { renderToStaticMarkup } = await import(pathToFileURL(WEB_REACT_DOM_SERVER).href);
  const { KeySetup } = await import('../web/src/components/KeySetup');
  return renderToStaticMarkup(createElement(KeySetup, {}));
}

/** Transporte falso que registra url + headers de TODA chamada de rede. */
function gravarRede() {
  const chamadas: { url: string; headers: string }[] = [];
  const fetchFalso = vi.fn(async (input: unknown, init?: { headers?: unknown }) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string }).url ?? input);
    const h = init?.headers;
    const headers =
      h instanceof Headers ? JSON.stringify([...h.entries()]) : JSON.stringify(h ?? {});
    chamadas.push({ url, headers });
    const body = url.includes('/key')
      ? { data: { label: 'teste', usage: 0, limit: null, is_free_tier: false } }
      : { data: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchFalso);
  return chamadas;
}

/* ===================================================== (i) lembrar ou não */

describe('web-code#3 (i) — «Lembrar neste dispositivo»: persiste só com opt-in e a tela declara', () => {
  it('o KeySetup grava COM a escolha do usuário (nunca mais setStoredKey sem opts)', () => {
    const src = read('web/src/components/KeySetup.tsx');
    expect(src).toMatch(/store\(target, remember\)/);
    expect(src).toMatch(/setStoredKey\(k, \{ remember: lembrar \}\)/);
    expect(src).not.toMatch(/setStoredKey\(target\)/);
    // Default = opt-in: o switch nasce do estado REAL (lembrada → ligado).
    expect(src).toMatch(/useState\(\(\) => keyPersistence\(\) === 'remembered'\)/);
    // Desmarcar com key conectada vale na hora (tira do disco já).
    expect(src).toMatch(/if \(atual && status === 'valid'\) store\(atual, v\)/);
    // Enter valida e NUNCA submete o <form> em volta (o re-prompt da Nova Run
    // vive dentro do formulário da run: Enter lá iniciaria a run).
    expect(src).toMatch(/if \(e\.key === 'Enter'\) \{\s*e\.preventDefault\(\);\s*void handleValidate\(\);/);
  });

  it('com lembrar: sobrevive ao reload e o revalidar NÃO apaga a cópia persistida', async () => {
    const api = await abrirApi();
    api.setStoredKey('sk-or-v1-lembrada', { remember: true });
    vi.resetModules();
    const depois = await abrirApi();
    expect(depois.getStoredKey()).toBe('sk-or-v1-lembrada');
    expect(depois.keyPersistence()).toBe('remembered');
    // O KeySetup nasce com o switch LIGADO para a key lembrada: revalidar grava
    // com remember=true (antes: sem opts → lsDel da cópia).
    depois.setStoredKey(depois.getStoredKey(), { remember: depois.keyPersistence() === 'remembered' });
    expect(ls.getItem(KEY_STORAGE)).toBe('sk-or-v1-lembrada');
  });

  it.skipIf(!temWebDeps)('a tela declara o estado REAL: memória vs localStorage', async () => {
    // Sem key lembrada: switch desligado + "só na memória desta aba".
    const semLembrar = accessibleText(await renderKeySetup());
    expect(semLembrar).toContain('Lembrar neste dispositivo');
    expect(semLembrar).toMatch(/Onde ela fica: só na memória desta aba — recarregar/);
    expect(semLembrar).not.toMatch(/no localStorage deste navegador, até você a remover/);

    // Key lembrada (reload): switch ligado + "no localStorage deste navegador".
    ls.setItem(KEY_STORAGE, 'sk-or-v1-x');
    ls.setItem(KEY_REMEMBER, '1');
    vi.resetModules();
    const html = await renderKeySetup();
    const lembrada = accessibleText(html);
    expect(lembrada).toMatch(/no localStorage deste navegador, até você a remover/);
    expect(lembrada).not.toMatch(/Onde ela fica: só na memória desta aba/);
    expect(html).toMatch(/<input[^>]*data-lembrar=""[^>]*checked=""/);
  });

  it('nenhuma tela afirma mais "salva só no localStorage" (texto falso do defeito)', () => {
    for (const f of ['web/src/components/KeySetup.tsx', 'web/src/components/HelpModal.tsx', 'web/src/components/FirstRun.tsx']) {
      const src = read(f);
      expect(src, f).not.toMatch(/salva só no|fica salva só|vive só no localStorage/);
    }
    // A Ajuda de Configurações diz as DUAS situações.
    const help = read('web/src/components/HelpModal.tsx');
    expect(help).toMatch(/só na memória desta aba — ou no localStorage deste navegador, se marcar «Lembrar neste dispositivo»/);
  });
});

/* ============================================ (ii) checklist de afirmações */

type Verificador = () => Promise<void> | void;

const VERIFICADORES: Record<string, Verificador> = {
  // "só na memória desta aba" / "no localStorage deste navegador, até remover".
  async onde() {
    const api = await abrirApi();
    api.setStoredKey('sk-or-v1-memoria');
    expect(ls.getItem(KEY_STORAGE)).toBeNull();
    expect(api.keyPersistence()).toBe('memory');
    vi.resetModules();
    expect((await abrirApi()).getStoredKey(), 'sem lembrar: morre no reload').toBe('');
    const api2 = await abrirApi();
    api2.setStoredKey('sk-or-v1-disco', { remember: true });
    vi.resetModules();
    const api3 = await abrirApi();
    expect(api3.getStoredKey(), 'com lembrar: sobrevive').toBe('sk-or-v1-disco');
    api3.setStoredKey(''); // "até você a remover"
    expect(ls.getItem(KEY_STORAGE)).toBeNull();
  },
  // "sai deste navegador só para openrouter.ai: validação, catálogo e runs".
  async destino() {
    const rede = gravarRede();
    const api = await abrirApi();
    api.setStoredKey('sk-or-v1-destino');
    await api.validateKey('sk-or-v1-destino');
    await api.fetchModels().catch(() => undefined);
    expect(rede.length).toBeGreaterThan(0);
    for (const c of rede) expect(c.url, 'toda chamada vai ao OpenRouter').toMatch(/^https:\/\/openrouter\.ai\//);
    expect(rede.some((c) => c.headers.includes('sk-or-v1-destino')), 'a key foi mesmo enviada').toBe(true);
    // As runs usam o MESMO gateway, com base fixa na API pública.
    const { browserGatewayConfig } = await import('../web/src/engine/openrouter.js');
    expect(browserGatewayConfig().baseUrl).toBe('https://openrouter.ai/api/v1');
  },
  // "nenhum servidor do Prompt Builder recebe a key".
  async servidor() {
    const arquivos: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(n)) arquivos.push(p);
      }
    };
    walk(WEB_SRC);
    const fontes = arquivos.map((f) => [f.slice(ROOT.length + 1), readFileSync(f, 'utf8')] as const);
    // Nenhum header da key para um backend (o modo servidor HTTP não é a SPA).
    expect(fontes.filter(([, s]) => s.includes('x-openrouter-key')).map(([f]) => f)).toEqual([]);
    // Nenhuma rota do backend (/v1…) chamada por fetch literal espalhado pela SPA.
    expect(fontes.filter(([, s]) => /fetch\(\s*['"`]\/v1/.test(s)).map(([f]) => f)).toEqual([]);
    // Fora do gateway, os ÚNICOS fetch diretos são o ranking PÚBLICO do
    // catálogo e o cliente SOMENTE-LEITURA do self-host (http-api#3,
    // web/src/backend.ts) — nenhum dos dois com key.
    const diretos = fontes.filter(([f, s]) => !f.startsWith('web/src/engine/') && /\bfetch\(/.test(s)).map(([f]) => f);
    expect([...diretos].sort()).toEqual(['web/src/backend.ts', 'web/src/components/ModelSelector.tsx']);
    const sel = fontes.find(([f]) => f === 'web/src/components/ModelSelector.tsx')![1];
    const linha = sel.split('\n').find((l) => /\bfetch\(/.test(l))!;
    expect(linha).toContain('DEFAULT_OPENROUTER_BASE_URL');
    expect(linha).not.toMatch(/getStoredKey|Authorization|apiKey/);
    // O cliente do self-host não toca na key: só GET com `accept`, sem
    // Authorization/header de key, e nenhuma função dele recebe a key.
    const back = fontes.find(([f]) => f === 'web/src/backend.ts')![1];
    expect(back).not.toMatch(/getStoredKey|Authorization|apiKey|sk-or-|method\s*:/);
    expect(back).toMatch(/headers: \{ accept: 'application\/json' \}/);
    // E em execução: backend "presente" (probe /health OK) e key conectada —
    // nenhuma chamada ao servidor leva a key (url nem headers).
    const rede = gravarRede();
    const fetchBase = globalThis.fetch as unknown as (u: unknown, i?: unknown) => Promise<Response>;
    vi.stubGlobal('fetch', async (u: unknown, i?: unknown) => {
      const url = String(u);
      if (url.endsWith('/health')) {
        await fetchBase(u, i); // registra a chamada
        return new Response(JSON.stringify({ service: 'prompt-builder' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return fetchBase(u, i);
    });
    vi.stubGlobal('location', new URL('http://127.0.0.1:3001/runs'));
    const api = await abrirApi();
    api.setStoredKey('sk-or-v1-servidor');
    const back2 = (await import('../web/src/backend.js')) as typeof import('../web/src/backend.js');
    back2.resetBackendProbe();
    await back2.fetchBackendRuns();
    await back2.fetchBackendSessions();
    await back2.fetchBackendRun('r1');
    const aoServidor = rede.filter((c) => c.url.startsWith('http://127.0.0.1:3001/'));
    expect(aoServidor.length, 'o modo self-host estava ligado').toBeGreaterThan(1);
    for (const c of aoServidor) {
      expect(c.url + c.headers, `sem key: ${c.url}`).not.toContain('sk-or-v1-servidor');
    }
  },
  // "qualquer script da página consegue ler a key" — não prometemos proteção.
  async riscos() {
    const api = await abrirApi();
    api.setStoredKey('sk-or-v1-visivel', { remember: true });
    expect(localStorage.getItem(KEY_STORAGE), 'texto puro, legível por qualquer script').toBe('sk-or-v1-visivel');
    expect(typeof api.getStoredKey).toBe('function'); // e em memória, exposta ao JS da página
    const { keyHandlingFacts } = await import('../web/src/keyHandling.js');
    for (const p of ['memory', 'remembered'] as const) {
      const texto = keyHandlingFacts(p).map((f) => f.text).join(' ');
      expect(texto).not.toMatch(/criptograf|protegid|segur[ao] contra|inviolável/i);
    }
  },
  // "o navegador pode apagar os dados; aí o app pede a key de novo antes de gastar".
  async sumir() {
    const api = await abrirApi();
    api.setStoredKey('sk-or-v1-itp', { remember: true });
    ls.clear(); // o navegador apagou os dados do site (Safari ITP, limpeza manual)
    vi.resetModules();
    const depois = await abrirApi();
    expect(depois.getStoredKey()).toBe('');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const err = await depois.createRun({} as never).catch((e: unknown) => e);
    expect(depois.isKeyMissing(err), 'recusa = re-prompt, antes de qualquer fetch').toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    // A UI transforma isso em pedir a key: o gate (com rota de volta) e o form.
    const main = read('web/src/main.tsx');
    expect(main).toMatch(/!getStoredKey\(\) && !keyAskSkipped\(\)/);
    expect(main).toMatch(/<Navigate to="\/welcome" replace state=\{\{ from:/);
    const newRun = read('web/src/pages/NewRun.tsx');
    expect(newRun).toMatch(/if \(isKeyMissing\(err\)\) \{\s*setNeedKey\(true\)/);
    expect(newRun).toMatch(/\{needKey && \(/);
    expect(newRun).toMatch(/<KeySetup onSaved=\{\(\) => setNeedKey\(false\)\} \/>/);
  },
  // "revogue-a e crie outra na página de keys do OpenRouter".
  async revogar() {
    const { OPENROUTER_KEYS_URL } = await import('../web/src/keyHandling.js');
    expect(OPENROUTER_KEYS_URL).toBe('https://openrouter.ai/keys');
    expect(read('web/src/components/KeySetup.tsx')).toMatch(/href=\{OPENROUTER_KEYS_URL\}/);
  },
};

describe('IMPL-082 (ii) — "como sua key é tratada": cada afirmação amarrada a um fato do código', () => {
  it('cobertura 100%: toda afirmação tem verificador (e todo verificador, uma afirmação)', async () => {
    const { keyHandlingFacts } = await import('../web/src/keyHandling.js');
    for (const p of ['memory', 'remembered'] as const) {
      const ids = keyHandlingFacts(p).map((f) => f.id).sort();
      expect(ids, `estado ${p}`).toEqual(Object.keys(VERIFICADORES).sort());
    }
  });

  for (const [id, verificar] of Object.entries(VERIFICADORES)) {
    it(`afirmação "${id}" é verdadeira`, async () => {
      await verificar();
    });
  }

  it.skipIf(!temWebDeps)('a tela renderiza exatamente as afirmações verificadas', async () => {
    const html = await renderKeySetup();
    const { keyHandlingFacts } = await import('../web/src/keyHandling.js');
    for (const f of keyHandlingFacts('memory')) expect(html).toContain(`data-key-fact="${f.id}"`);
    expect((html.match(/data-key-fact="/g) ?? []).length).toBe(keyHandlingFacts('memory').length);
  });
});

/* =========================================== (iv) key sumida = re-prompt */

describe('IMPL-082 (iv) — o first-run devolve o usuário à rota de origem', () => {
  it('returnPathFrom: só caminhos internos; raiz e /welcome não contam', async () => {
    vi.doMock('react-router-dom', () => ({ useLocation: () => ({}), useNavigate: () => () => undefined }));
    vi.doMock('../web/src/components/GuidedSetup', () => ({ GoalCard: () => null, GOALS: [] }));
    vi.doMock('../web/src/components/KeySetup', () => ({ KeySetup: () => null }));
    const { returnPathFrom } = await import('../web/src/components/FirstRun');
    expect(returnPathFrom({ from: '/runs/abc?x=1' })).toBe('/runs/abc?x=1');
    expect(returnPathFrom({ from: '/new?objetivo=training' })).toBe('/new?objetivo=training');
    for (const ruim of [{ from: '/' }, { from: '/welcome' }, { from: '//evil.example' }, { from: 'https://x' }, {}, null, undefined])
      expect(returnPathFrom(ruim), JSON.stringify(ruim)).toBeNull();
  });
});
