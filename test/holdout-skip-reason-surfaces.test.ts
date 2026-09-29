// Integração da onda 1 — o MOTIVO do holdout pulado (cli#9, trainer-core) chega
// às superfícies de agente que o mcp/CLI montaram em paralelo: o resumo de
// sessão do run_status/get_result/detach (`trainingSummary`) e o evento
// `session.finished` do NDJSON. Antes só o record completo e o `train --json`
// traziam `holdoutSkipReason`; o agente que lia o resumo via só
// `holdoutSkipped: true` e não sabia se o remédio era orçamento ou cenários.

import { describe, expect, it, vi } from 'vitest';
import { trainingSummary } from '../src/jobManager.js';
import { emitSessionEventNdjson } from '../src/cli/ndjson.js';
import { Output } from '../src/cli/output.js';
import type { SessionRecord } from '../src/types.js';

function sessao(extra: Partial<SessionRecord>): SessionRecord {
  return {
    id: 's-w1',
    status: 'finished',
    bestPromptByIteration: [],
    runIds: [],
    totalCostUsd: 0,
    ...extra,
  } as unknown as SessionRecord;
}

async function capturar(fn: () => unknown): Promise<string> {
  const chunks: string[] = [];
  const spyOut = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
    chunks.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf-8'));
    return true;
  });
  const spyErr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await fn();
    return chunks.join('');
  } finally {
    spyOut.mockRestore();
    spyErr.mockRestore();
  }
}

describe('holdoutSkipReason nas superfícies enxutas (MCP/detach e NDJSON)', () => {
  it('trainingSummary: motivo gravado sai; sessão antiga tem o motivo DERIVADO; holdout rodado não inventa motivo', () => {
    expect(trainingSummary(sessao({ holdoutSkipped: true, holdoutSkipReason: 'min-scenarios' }))).toMatchObject({
      holdoutSkipped: true,
      holdoutSkipReason: 'min-scenarios',
    });
    // Record anterior ao campo: parada por orçamento ⇒ 'budget' (holdoutSkipReasonOf).
    expect(
      trainingSummary(sessao({ holdoutSkipped: true, stoppedReason: 'budget', status: 'aborted' } as Partial<SessionRecord>)),
    ).toMatchObject({ holdoutSkipReason: 'budget' });
    expect(trainingSummary(sessao({}))).not.toHaveProperty('holdoutSkipReason');
  });

  it('session.finished em NDJSON leva o motivo', async () => {
    const out = new Output({ format: 'ndjson' });
    const stdout = await capturar(() =>
      emitSessionEventNdjson(out, {
        type: 'session.finished',
        sessionId: 's-w1',
        record: sessao({ holdoutSkipped: true, holdoutSkipReason: 'disabled' }),
      } as never),
    );
    const ev = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(ev).toMatchObject({ type: 'session.finished', holdoutSkipped: true, holdoutSkipReason: 'disabled' });
  });
});
