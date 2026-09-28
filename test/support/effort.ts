/** Escala de esforço dos testes: `npm test` roda a versão RÁPIDA (sanidade com
 *  folga 3σ); `npm run test:full` (PB_FULL=1) roda os números completos com os
 *  limiares duros. O que se valida é o MESMO contrato — muda a resolução da
 *  simulação estatística. */
export const FULL = process.env.PB_FULL === '1';
export function ensaios(full: number, rapido: number): number {
  return FULL ? full : rapido;
}
