// Re-tentativa SELETIVA das chamadas de juiz (IMPL-004, R-03b:REC-4).
//
// Fonte única para os 3 prompts de juiz (pointwise `refJudge`, listwise
// `judge`, duelos `duels` + espelho web): mesma política, mesma classificação
// de erro, nos dois motores. Puro (sem Node): o web importa direto daqui.
//
// A política, e por quê:
//   • transientes (429/5xx/rede) — JÁ re-tentados pelo gateway (`MAX_RETRIES`, 4, com
//     backoff) e preservam a validade: nada a fazer aqui;
//   • timeout — re-tenta UMA vez. Timeout pode ser informativo (resposta longa
//     → juiz lento), então insistir mais viesaria a amostra contra respostas
//     longas; uma segunda chance cobre o soluço de rede;
//   • saída inválida (JSON/schema) — UM novo pedido com lembrete de formato.
//     Antes caía num parse heurístico e o lixo virava 'parcial': uma nota
//     inventada que entrava nas médias e nas lições do reescritor;
//   • saída CORTADA (IMPL-015: `finish_reason` length/timeout) — checada
//     ANTES do parse: veredito inválido (`truncated`/`timeout`), nunca lido
//     do pedaço truncado; truncamento não repete nem ganha lembrete;
//   • o resto — falha. Quem chama registra `VerdictError`, NUNCA um veredito.
//
// `BudgetExceeded`/`RunCancelled` sobem intactos (controle, não erro), e um
// abort externo no meio da chamada vira `RunCancelled`: cancelamento não é
// falha do juiz e não pode inflar `failureCountByRole`. Key recusada (401) e
// sem crédito (402) também sobem (cli#3): nenhum retry nem outro juiz conserta,
// e degradar para veredito ausente deixava a run "concluir" e sair com exit 1
// em vez do 4/5 documentado.

import { isControlSignal, RunCancelled } from '../budget.js';
import { isFatalGatewayError } from '../openrouter.js';
import { judgeReplyCut, type JudgeReplyFinish } from './truncation.js';
import { sha256Hex } from './hash.js';
import type { JudgeCallFinish, VerdictError } from '../types.js';

/**
 * `finish` = sinais de fim + artefato da ÚLTIMA chamada que devolveu resposta
 * (IMPL-014/IMPL-117): quem registra o voto/ordem copia para o record — antes
 * só o histograma por papel sobrevivia e não dava para saber qual veredito
 * terminou com qual `finish_reason`. Ausente = nenhuma chamada respondeu
 * (exceção/timeout do transporte).
 */
export type JudgeAttempt<T> =
  | { ok: true; value: T; calls: number; finish?: JudgeCallFinish }
  | { ok: false; error: VerdictError; calls: number; finish?: JudgeCallFinish };

/** Resultado do gateway que o retry sabe ler (o `ChatCompletionResult` serve). */
export type JudgeCallReply = JudgeReplyFinish & { raw?: unknown };

/**
 * Sinais de fim + artefato de UMA resposta de juiz: `finish_reason` normalizado
 * e o cru do provedor, `truncated` (só quando true), o id da geração (`gen-…`,
 * do corpo — auditoria/conciliação) e o SHA-256 do texto devolvido (IMPL-117:
 * prova de qual resposta produziu o veredito, sem guardar o texto duas vezes).
 */
export function judgeCallFinishOf(reply: JudgeCallReply): JudgeCallFinish {
  const raw = reply.raw as { id?: unknown } | null | undefined;
  const generationId = raw && typeof raw === 'object' && typeof raw.id === 'string' && raw.id ? raw.id : undefined;
  return {
    ...(reply.finishReason ? { finishReason: reply.finishReason } : {}),
    ...(reply.nativeFinishReason ? { nativeFinishReason: reply.nativeFinishReason } : {}),
    ...(reply.truncated === true ? { truncated: true } : {}),
    ...(generationId ? { generationId } : {}),
    responseSha256: sha256Hex(reply.text ?? ''),
  };
}

export interface JudgeRetryOptions<T> {
  /**
   * UMA chamada ao juiz. `reminder` presente = o novo pedido com lembrete de
   * formato. Devolva o RESULTADO do gateway (texto + sinais de fim), nao so o
   * `.text`: e dele que sai a checagem de truncamento ANTES do parse
   * (IMPL-015). Texto puro segue aceito (sem sinal de fim = nada a checar).
   */
  call: (reminder: string | undefined) => Promise<string | JudgeCallReply>;
  /** Parse ESTRITO: `null` = saída inválida (nunca um veredito inventado). */
  parse: (text: string) => T | null;
  /** Lembrete anexado ao pedido depois de uma saída inválida. */
  formatReminder: string;
  /** Sinal da run: abortado => cancelamento, não falha do juiz. */
  signal?: AbortSignal;
}

/** Máximo de chamadas por veredito: original + 1 timeout + 1 lembrete de formato. */
export const MAX_JUDGE_CALLS = 3;

/**
 * Temperatura de amostragem de TODA chamada de juízo (pointwise, listwise,
 * duelo e verificador de gabarito) — fonte ÚNICA (IMPL-117, R-07b:REC-5). É ela
 * que entra no hash do contrato do juiz (`judgeTemperature`): um número
 * espalhado em cada papel podia mudar sem o contrato perceber.
 */
export const JUDGE_TEMPERATURE = 0;

/** Timeout do gateway (`abort(new Error('timeout'))`) ou `TimeoutError` do runtime. */
export function isTimeoutError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; message?: unknown };
  if (e.name === 'TimeoutError') return true;
  return typeof e.message === 'string' && /\btime-?out\b|\btimed out\b/i.test(e.message);
}

/** Converte a exceção de uma chamada de juiz no motivo do veredito ausente. */
export function describeJudgeError(err: unknown): VerdictError {
  const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
  return { kind: isTimeoutError(err) ? 'timeout' : 'judge_failed', message: message.slice(0, 200) };
}

function snippet(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t ? `"${t.slice(0, 80)}${t.length > 80 ? '…' : ''}"` : '(vazia)';
}

/**
 * Executa a chamada de juiz com a política seletiva acima. Nunca lança erro
 * comum: devolve `{ ok: false, error }` para quem registra o veredito ausente.
 */
export async function callJudgeWithRetry<T>(opts: JudgeRetryOptions<T>): Promise<JudgeAttempt<T>> {
  let calls = 0;
  let timeoutRetried = false;
  let reminder: string | undefined;
  /** Sinais da última chamada que RESPONDEU (IMPL-014) — vão junto do desfecho. */
  let finish: JudgeCallFinish | undefined;
  const comFinish = (): { finish?: JudgeCallFinish } => (finish ? { finish } : {});
  for (;;) {
    let reply: JudgeCallReply;
    try {
      calls += 1;
      const raw = await opts.call(reminder);
      reply = typeof raw === 'string' ? { text: raw } : raw;
    } catch (err) {
      if (isControlSignal(err) || isFatalGatewayError(err)) throw err;
      if (opts.signal?.aborted) throw new RunCancelled(opts.signal.reason);
      const error = describeJudgeError(err);
      if (error.kind === 'timeout' && !timeoutRetried) {
        timeoutRetried = true;
        continue;
      }
      return { ok: false, error, calls, ...comFinish() };
    }
    finish = judgeCallFinishOf(reply);
    // IMPL-015 (R-08:REC-11): saida CORTADA (finish_reason length/timeout)
    // e checada ANTES do parse — conteudo truncado nunca vira veredito, nem
    // quando o pedaco por acaso parseia. Truncamento nao repete (mesmo teto,
    // mesma temperatura 0 => mesmo corte; so gastaria) e NAO ganha lembrete de
    // formato (o formato nao e o problema). O timeout declarado no fim segue a
    // politica do timeout por excecao: 1 nova chance.
    const cut = judgeReplyCut(reply);
    if (cut) {
      if (cut.kind === 'timeout' && !timeoutRetried) {
        timeoutRetried = true;
        continue;
      }
      return { ok: false, error: cut, calls, ...comFinish() };
    }
    const text = reply.text;
    const parsed = opts.parse(text);
    if (parsed !== null) return { ok: true, value: parsed, calls, ...comFinish() };
    if (reminder === undefined) {
      reminder = opts.formatReminder;
      continue;
    }
    return {
      ok: false,
      error: {
        kind: 'invalid_output',
        message: `saída fora do formato mesmo após o lembrete: ${snippet(text)}`,
      },
      calls,
      ...comFinish(),
    };
  }
}

/**
 * Anexa o lembrete ao conteúdo do usuário (sem mensagem `assistant` com a saída
 * inválida: ela pode conter texto do candidato e reabrir a injeção).
 */
export function withReminder(userContent: string, reminder: string | undefined): string {
  return reminder ? `${userContent}\n\n${reminder}` : userContent;
}
