// Desfecho de uma run de TESTE que terminou o pipeline (IMPL-004 × fixtures).
//
// Desde o IMPL-004 uma run só é `finished` com >= 5 cenários julgados por
// contestant (`MIN_JUDGED_SCENARIOS`); as fixtures pequenas (1–4 cenários) dos
// testes de outros itens terminam `inconclusive` — e o ÚNICO motivo aceitável
// ali é esse piso de n efetivo (nenhum veredito perdido em papel nenhum).
// `expectPipelineDone` afirma exatamente isso, sem afrouxar o resto do teste.

import { expect } from 'vitest';

export interface RunOutcomeView {
  status: string;
  error?: string;
  verdictIntegrity?: { reasons: string[] };
}

export function expectPipelineDone(rec: RunOutcomeView): void {
  if (rec.status === 'finished') return;
  expect(rec.status, rec.error).toBe('inconclusive');
  const motivos = rec.verdictIntegrity?.reasons ?? [];
  expect(motivos.length, 'inconclusive sem motivo gravado').toBeGreaterThan(0);
  for (const m of motivos) expect(m).toMatch(/^n efetivo < 5 cenários julgados/);
}
