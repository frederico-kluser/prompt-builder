// IMPL-082 (R-10:REC-4) — BYOK: a key não vivia SEMPRE no localStorage.
//
// Antes: `setStoredKey` gravava direto no localStorage sem alternativa — a key
// ficava exposta por meses a qualquer XSS do domínio e o cenário "key sumida"
// (Safari ITP apagando dados após 7 dias, limpeza manual) virava erro de fetch
// opaco. O contrato novo, verificado aqui:
//  (i) SEM "lembrar" a key vive só em memória e NÃO sobrevive ao reload; COM
//      "lembrar" persiste no localStorage e `keyPersistence()` declara isso;
//  (iv) "key sumida" é RE-PROMPT (`KeyMissingError` detectado por propriedade,
//      nunca `instanceof`) — nenhuma chamada que gasta dinheiro sai para a rede
//      sem key;
//  — migração: key de versão antiga (sem flag) é tratada como "lembrada" e
//    DECLARADA (o usuário a salvou; apagar em silêncio seria perda surpresa);
//  — localStorage bloqueado/ausente degrada para memória, sem lançar.
//
// O que fica pendente (fora da fronteira do item — UI): checkbox "lembrar neste
// dispositivo" e a declaração no KeySetup e a página "como sua key é tratada"
// com frases amarradas a evidência.
//
// DECISÃO sobre OAuth PKCE (IMPL-082 crit. iii) — registada com evidência de
// documentação oficial (OpenRouter, consultada 2026-09-27):
//  • o PKCE EXISTE e é compatível com o deploy em *.vercel.app: o fluxo
//    `GET /auth?callback_url=…&code_challenge=…` devolve `code` no callback e a
//    troca por API key é feita em seguida; `callback_url` aceita qualquer URL
//    https (porta 443; localhost/127.0.0.1 em qualquer porta p/ CLI) e o
//    *.vercel.app serve https na 443 — domínio aceite pelo contrato documentado.
//    Fontes: https://openrouter.ai/docs/use-cases/oauth-pkce e
//    https://openrouter.ai/docs/api/api-reference/oauth/create-authorization-code
//  • o fluxo troca o code por uma API key da conta OpenRouter do usuário
//    (mesma natureza da key colada à mão — não resolve o XSS por si só; o ganho
//    é UX e key nunca digitada). Adoção fica para a UI.
//  • FALTA fechar o critério (iii): rodar o callback de VERDADE em *.vercel.app
//    (abrir /auth, autorizar, voltar com `code`, trocar por key) — exige
//    deploy + navegador + login do usuário; nada fora da fronteira deste lote
//    consegue registar essa evidência.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// localStorage falso (o vitest roda em Node, sem storage de navegador).
// ---------------------------------------------------------------------------

class FakeLocalStorage {
  private mapa = new Map<string, string>();
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

/** localStorage que lança em qualquer acesso (modo privado/iframe bloqueado). */
class BrokenLocalStorage extends FakeLocalStorage {
  override getItem(): string | null {
    throw new DOMException('blocked', 'SecurityError');
  }
  override setItem(): void {
    throw new DOMException('blocked', 'SecurityError');
  }
  override removeItem(): void {
    throw new DOMException('blocked', 'SecurityError');
  }
}

const KEY_STORAGE = 'openrouter_api_key';
const KEY_REMEMBER = 'openrouter_api_key:remember';

let ls: FakeLocalStorage;

beforeEach(() => {
  ls = new FakeLocalStorage();
  vi.stubGlobal('localStorage', ls);
  vi.unstubAllGlobals(); // zera stubs antigos…
  vi.stubGlobal('localStorage', ls); // …e instala o fake limpo desta iteração
  vi.resetModules(); // "reload": estado em memória da key nasce do zero
});

/** Importa o api.ts "desta sessão" (estado em memória novo). */
async function abrirApi() {
  return (await import('../web/src/api.js')) as typeof import('../web/src/api.js');
}

describe('BYOK: key em memória por default, localStorage só com "lembrar" (IMPL-082)', () => {
  it("sem 'lembrar', a key não sobrevive ao reload (crit. i)", async () => {
    const api = await abrirApi();
    api.setStoredKey('sk-or-v1-memoria');
    expect(api.getStoredKey()).toBe('sk-or-v1-memoria');
    expect(ls.getItem(KEY_STORAGE), 'sem opt-in nada vai para o localStorage').toBeNull();
    expect(api.keyPersistence()).toBe('memory');

    vi.resetModules(); // reload da página
    const aposReload = await abrirApi();
    expect(aposReload.getStoredKey(), 'key morre no reload').toBe('');
    expect(aposReload.keyPersistence()).toBe('memory');
  });

  it("com 'lembrar', persiste, sobrevive ao reload e a UI declara (crit. i)", async () => {
    const api = await abrirApi();
    api.setStoredKey('sk-or-v1-lembrada', { remember: true });
    expect(ls.getItem(KEY_STORAGE)).toBe('sk-or-v1-lembrada');
    expect(ls.getItem(KEY_REMEMBER)).toBe('1');
    expect(api.keyPersistence(), 'a UI é obrigada a declarar a persistência').toBe('remembered');

    vi.resetModules(); // reload da página
    const aposReload = await abrirApi();
    expect(aposReload.getStoredKey()).toBe('sk-or-v1-lembrada');
    expect(aposReload.keyPersistence(), 'sobreviveu E continua declarada').toBe('remembered');
  });

  it('trocar para versão sem "lembrar" remove a cópia persistida', async () => {
    const api = await abrirApi();
    api.setStoredKey('sk-or-v1-a', { remember: true });
    api.setStoredKey('sk-or-v1-b'); // salvou de novo sem o opt-in
    expect(ls.getItem(KEY_STORAGE)).toBeNull();
    expect(api.keyPersistence()).toBe('memory');

    vi.resetModules();
    expect((await abrirApi()).getStoredKey()).toBe('');
  });

  it('remover a key limpa memória e localStorage', async () => {
    const api = await abrirApi();
    api.setStoredKey('sk-or-v1-x', { remember: true });
    api.setStoredKey('');
    expect(api.getStoredKey()).toBe('');
    expect(ls.getItem(KEY_STORAGE)).toBeNull();
    expect(ls.getItem(KEY_REMEMBER)).toBeNull();
  });

  it('migração: key de versão antiga (sem flag) é tratada como "lembrada" e declarada', async () => {
    ls.setItem(KEY_STORAGE, 'sk-or-v1-legada'); // gravada pelo setStoredKey antigo
    const api = await abrirApi();
    expect(api.getStoredKey()).toBe('sk-or-v1-legada');
    expect(api.keyPersistence(), 'o upgrade não pode perder a key do usuário em silêncio').toBe('remembered');
  });

  it('localStorage bloqueado/ausente degrada para memória, sem lançar', async () => {
    vi.stubGlobal('localStorage', new BrokenLocalStorage());
    const api = await abrirApi();
    expect(() => api.setStoredKey('sk-or-v1-quebrada')).not.toThrow();
    expect(api.getStoredKey()).toBe('sk-or-v1-quebrada');
    expect(() => api.setStoredKey('')).not.toThrow();
    expect(api.getStoredKey()).toBe('');
    // sem localStorage global algum (SSR/Node puro) também não quebra:
    vi.stubGlobal('localStorage', undefined);
    vi.resetModules();
    const semStorage = await abrirApi();
    expect(() => semStorage.setStoredKey('sk-or-v1-ssr', { remember: true })).not.toThrow();
    expect(semStorage.getStoredKey()).toBe('sk-or-v1-ssr');
  });

  it("key sumida é re-prompt, não erro de fetch (crit. iv)", async () => {
    const api = await abrirApi();
    // Sem key nenhuma: o que gasta dinheiro recusa ANTES de qualquer rede.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    let erroRun: unknown;
    try {
      await api.createRun({} as never);
    } catch (err) {
      erroRun = err;
    }
    expect(api.isKeyMissing(erroRun), 'createRun sem key = KeyMissingError (re-prompt)').toBe(true);

    let erroPrompt: unknown;
    try {
      await api.generateBasePrompt('descrever tarefa', 'openai/gpt-4o');
    } catch (err) {
      erroPrompt = err;
    }
    expect(api.isKeyMissing(erroPrompt), 'generateBasePrompt sem key = re-prompt').toBe(true);

    let erroSessao: unknown;
    try {
      await api.createSession({} as never);
    } catch (err) {
      erroSessao = err;
    }
    expect(api.isKeyMissing(erroSessao), 'createSession sem key = re-prompt').toBe(true);

    expect(fetchSpy, 'nenhum fetch sem key — nada de erro de rede opaco').not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('KeyMissingError é reconhecido por PROPRIEDADE, nunca por instanceof', async () => {
    const api = await abrirApi();
    let capturado: unknown;
    try {
      api.requireKey();
    } catch (e) {
      capturado = e;
    }
    expect(api.isKeyMissing(capturado)).toBe(true);
    expect(capturado).toBeInstanceOf(api.KeyMissingError); // mesma instância: ok…
    // …mas a detecção não DEPENDE disso (instância dupla do módulo em ESM):
    expect(api.isKeyMissing({ code: 'key-missing', message: 'x' })).toBe(true);
    expect(api.isKeyMissing(new Error('falha de rede'))).toBe(false);
    expect(api.isKeyMissing(null)).toBe(false);
    // com key presente, requireKey devolve a key sem lançar
    api.setStoredKey('sk-or-v1-ok');
    expect(api.requireKey()).toBe('sk-or-v1-ok');
  });
});