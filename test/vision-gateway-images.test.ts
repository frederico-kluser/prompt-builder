// Contrato MULTIMODAL do gateway — a única porta para mandar imagem ao modelo.
//
// O que protege:
//   • a mensagem no fio leva texto PRIMEIRO e imagem depois, em partes
//     (`image_url` + data URL), sem reescrever a mensagem protegida pela cascata;
//   • URL fora de `data:image/...;base64` ou `https://` é recusada (nada de
//     `file://`, que só existiria na máquina de quem roda);
//   • modo LGPD sensível RECUSA imagem antes do fetch (imagem não passa pela
//     cascata de dado pessoal);
//   • a reserva de tokens conta a imagem (senão a porta dura autoriza de menos).

import { describe, expect, it } from 'vitest';
import {
  APPROX_IMAGE_TOKENS,
  createGateway,
  guessPromptTokens,
  hasImages,
  wireMessages,
  type ChatMessage,
} from '../src/openrouter.js';
import { BudgetLedger } from '../src/budget.js';
import { fakeOpenRouter } from './fakeOpenRouter.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const KEY = 'sk-or-v1-teste';

describe('wireMessages', () => {
  it('sem imagem mantém o formato histórico (content string)', () => {
    const m: ChatMessage[] = [{ role: 'user', content: 'oi' }];
    expect(wireMessages(m)).toEqual([{ role: 'user', content: 'oi' }]);
  });

  it('com imagem, o texto vem ANTES da imagem e o detail vai junto', () => {
    const m: ChatMessage[] = [
      { role: 'system', content: 'contrato' },
      { role: 'user', content: 'liste os controles', images: [{ url: PNG, detail: 'high' }] },
    ];
    const w = wireMessages(m);
    expect(w[0]).toEqual({ role: 'system', content: 'contrato' });
    const partes = w[1]!.content as Array<Record<string, unknown>>;
    expect(partes[0]).toEqual({ type: 'text', text: 'liste os controles' });
    expect(partes[1]).toEqual({ type: 'image_url', image_url: { url: PNG, detail: 'high' } });
  });

  it('recusa file:// e aceita https', () => {
    expect(() => wireMessages([{ role: 'user', content: '', images: [{ url: 'file:///etc/passwd' }] }])).toThrow(/inválida/);
    expect(() =>
      wireMessages([{ role: 'user', content: 'x', images: [{ url: 'https://exemplo.com/a.png' }] }]),
    ).not.toThrow();
  });

  it('hasImages e a reserva de tokens contam a imagem', () => {
    const sem = [{ role: 'user', content: 'a'.repeat(400) }] as ChatMessage[];
    const com = [{ role: 'user', content: 'a'.repeat(400), images: [{ url: PNG }] }] as ChatMessage[];
    expect(hasImages(sem)).toBe(false);
    expect(hasImages(com)).toBe(true);
    expect(guessPromptTokens(com)).toBe(guessPromptTokens(sem) + APPROX_IMAGE_TOKENS);
  });
});

describe('gateway — imagem no corpo real do POST', () => {
  it('manda partes text+image_url no /chat/completions', async () => {
    const fake = fakeOpenRouter({ chat: () => ({ text: '{"elements":[]}' }) });
    const gw = createGateway({ fetch: fake.fetch });
    await gw.chatCompletion({
      apiKey: KEY,
      modelId: 'google/gemini-3-pro',
      messages: [
        { role: 'system', content: 'contrato' },
        { role: 'user', content: 'liste os controles', images: [{ url: PNG }] },
      ],
      maxTokens: 256,
    });
    const enviado = fake.requests.find((r) => r.path.endsWith('/chat/completions'))!;
    const msgs = enviado.body!.messages as Array<{ role: string; content: unknown }>;
    expect(msgs[0]).toEqual({ role: 'system', content: 'contrato' });
    const partes = msgs[1]!.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(partes[0]).toMatchObject({ type: 'text', text: 'liste os controles' });
    expect(partes[1]!.type).toBe('image_url');
    expect(partes[1]!.image_url!.url).toBe(PNG);
  });

  it('modo LGPD sensível recusa imagem ANTES do fetch', async () => {
    const fake = fakeOpenRouter({ chat: () => ({ text: 'ok' }) });
    const gw = createGateway({ fetch: fake.fetch });
    const ledger = new BudgetLedger({});
    ledger.setSensitiveRouting({ area: 'saude', routeFor: () => ({ ok: false, motivo: 'modelo_fora_da_allowlist' }) as never });
    await expect(
      gw.chatCompletion({
        apiKey: KEY,
        modelId: 'google/gemini-3-pro',
        messages: [{ role: 'user', content: 'veja', images: [{ url: PNG }] }],
        role: 'competitor',
        sink: ledger,
      }),
    ).rejects.toThrow(/imagem não passa pela cascata/);
    expect(fake.requests.filter((r) => r.path.endsWith('/chat/completions'))).toHaveLength(0);
  });
});
