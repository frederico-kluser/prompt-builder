// Pipeline FALSO para os testes de retomada (IMPL-081). Não é arquivo de teste
// (sem `.test.`): helper compartilhado pelos testes em processo e pelo FILHO
// SIGKILL-ável de test/storage-journal.test.ts. Zero rede, zero gasto real.
//
// O pipeline é DETERMINÍSTICO no conteúdo (mesmo cenário, mesma resposta de
// competidor/gabarito) — é o que torna a retomada replayável — e cada chamada
// servida custa `usage.cost` diferente, para o teste conferir a fatura contra
// o ledger. `hangAfter: K` segura para sempre toda chamada de chat a partir da
// (K+1)-ésima: o motor fica com K chamadas concluídas (e gravadas no journal)
// e o resto em voo — o ponto exato para matar o processo. `failAfter: K`
// responde 402 (sem crédito) a partir da (K+1)-ésima.

import type { FetchLike } from '../src/openrouter.js';
import { catalogItem, fakeOpenRouter, type FakeOpenRouter, type FakeRequest } from './fakeOpenRouter.js';
import { duelReply, pointwiseReply } from './judgeReplies.js';

export const JOURNAL_KEY = 'sk-or-v1-fake-key-para-teste-journal-000000';

export const JOURNAL_MODELS = ['fake/gen', 'fake/ref', 'fake/judge', 'fake/a', 'fake/b'];

export const JOURNAL_SCENARIOS = [
  {
    question: 'Qual o prazo para trocar um tenis comprado na loja online?',
    productContext: 'Politica de trocas: 30 dias corridos a partir do recebimento, com nota fiscal.',
    maxTokens: 300,
    rubric: 'Deve citar 30 dias e a nota fiscal.',
  },
  {
    question: 'Explique como calcular juros compostos de um investimento mensal em renda fixa.',
    productContext: 'Voce e um assistente financeiro. Formula: M = C (1 + i)^n.',
    maxTokens: 400,
    rubric: 'Deve apresentar a formula M = C(1+i)^n corretamente.',
  },
  {
    question: 'Como cancelo a assinatura mensal do aplicativo de musica sem pagar multa?',
    productContext: 'Assinatura mensal sem fidelidade: cancelamento pelo app, efetivo no fim do ciclo pago.',
    maxTokens: 300,
    rubric: 'Deve dizer que nao ha multa e que vale no fim do ciclo.',
  },
  {
    question: 'Minha geladeira nova chegou com a porta amassada, o que devo fazer?',
    productContext: 'Avaria no transporte: recusar ou abrir chamado em ate 7 dias com fotos da embalagem.',
    maxTokens: 300,
    rubric: 'Deve citar 7 dias e as fotos.',
  },
  {
    question: 'Quais documentos preciso levar para retirar um pedido na agencia dos Correios?',
    productContext: 'Retirada em agencia: documento oficial com foto e codigo de rastreio do objeto.',
    maxTokens: 300,
    rubric: 'Deve citar documento com foto e codigo de rastreio.',
  },
];

/**
 * compare por referência com 5 cenários (o piso de n efetivo para a run sair
 * `finished`, não `inconclusive`): datagen + gabaritos + respostas + vereditos
 * + duelos das finais.
 */
export const JOURNAL_COMPARE = {
  mode: 'compare',
  theme: 'suporte ao cliente',
  stages: 5,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  referenceModelId: 'fake/ref',
  referenceJudging: true,
  competitorModelIds: ['fake/a', 'fake/b'],
  finalists: 2,
  timeoutMs: 60_000,
} as const;

/**
 * Chamadas pagas de uma run COMPLETA de {@link JOURNAL_COMPARE}: 2 lotes de
 * datagen + 5 gabaritos + 10 respostas + 10 vereditos + 10 duelos. Conferido
 * contra uma run real em test/run-resume.test.ts (os demais testes usam a
 * constante em vez de pagar uma run de referência a mais).
 */
export const JOURNAL_COMPARE_CALLS = 37;

/** Papel de um pedido de chat do fake (pelo que ele pede). */
export function journalRoleOf(req: Pick<FakeRequest, 'model' | 'system'>): string {
  if (req.model === 'fake/gen') return 'datagen';
  if (req.model === 'fake/ref') return 'gabarito';
  if (req.model === 'fake/judge') return req.system.includes('DUELO') ? 'duel' : 'judge';
  return 'competitor';
}

export interface JournalPipeline extends FakeOpenRouter {
  /** Pedidos de chat que CHEGARAM ao transporte, por papel. */
  byRole(): Record<string, number>;
  /** Libera as chamadas seguradas por `hangAfter` (fim de teste). */
  release(): void;
}

export function journalPipeline(opts: { hangAfter?: number; failAfter?: number; price?: number } = {}): JournalPipeline {
  const segurando: Array<() => void> = [];
  let liberado = false;
  const fake = fakeOpenRouter({
    catalog: JOURNAL_MODELS.map((id) => catalogItem(id, opts.price ?? 1e-6, 2 * (opts.price ?? 1e-6))),
    chat: async (req, n) => {
      if (opts.hangAfter !== undefined && n >= opts.hangAfter && !liberado) {
        await new Promise<void>((resolve) => segurando.push(resolve));
      }
      // `failAfter: K`: a conta fica SEM CRÉDITO a partir da (K+1)-ésima (402 —
      // falha FATAL do gateway: a run sai 'error', retomável depois de recarregar).
      if (opts.failAfter !== undefined && n >= opts.failAfter) {
        return { status: 402, bodyText: '{"error":{"message":"Insufficient credits","code":402}}' };
      }
      const usage = { prompt_tokens: 100, completion_tokens: 20, cost: Number((0.0001 * (n + 1)).toFixed(6)) };
      const papel = journalRoleOf(req);
      if (papel === 'datagen') return { text: JSON.stringify({ stages: JOURNAL_SCENARIOS }), usage };
      if (papel === 'gabarito') return { text: `Gabarito: ${req.user.slice(0, 40)}`, usage };
      if (papel === 'duel') return { text: duelReply(req, 'A', 'A melhor'), usage };
      if (papel === 'judge') return { text: pointwiseReply(req, 'resolve', 'confere'), usage };
      return { text: `Resposta de ${req.model}: ${req.user.slice(0, 24)}`, usage };
    },
  });
  // Chamada segurada que é ABORTADA (Cancelar/SIGINT) rejeita como o fetch do
  // navegador/undici faz — senão o motor ficaria esperando a promise do fake.
  const fetch: FetchLike = (url, init) => {
    const signal = init?.signal;
    if (!signal) return fake.fetch(url, init);
    return new Promise<Response>((resolve, reject) => {
      const onAbort = (): void => reject(new DOMException('The operation was aborted.', 'AbortError'));
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      fake.fetch(url, init).then(
        (r) => {
          signal.removeEventListener('abort', onAbort);
          resolve(r);
        },
        (e: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });
  };
  return {
    ...fake,
    fetch,
    byRole: () => {
      const out: Record<string, number> = {};
      for (const r of fake.chatRequests()) out[journalRoleOf(r)] = (out[journalRoleOf(r)] ?? 0) + 1;
      return out;
    },
    release: () => {
      liberado = true;
      segurando.splice(0).forEach((f) => f());
    },
  };
}
