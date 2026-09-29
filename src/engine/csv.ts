// Célula CSV — FONTE ÚNICA (http-api#9). Antes eram três cópias iguais (rota
// /v1/benchmark, rota /v1/agents e o botão "CSV" do SPA), todas com o mesmo
// furo: aspas só para `"`, `,` e `\n`.
//
//   * Injeção de fórmula: `question` (saída do datagen), `text` (resposta do
//     competidor) e `errorMsg` são texto de LLM/de terceiros. Uma célula que
//     começa com `=`, `+`, `-`, `@`, TAB ou CR é AVALIADA como fórmula pelo
//     Excel/Sheets/LibreOffice ao abrir o arquivo (OWASP "CSV Injection").
//     Neutraliza com um apóstrofo na frente — só em STRING: número negativo
//     (`-0.5`) continua número.
//   * CR solto: sem aspas, um `\r` quebra a linha nos parsers que respeitam
//     CR (Excel, RFC 4180) e desalinha todas as colunas seguintes.
//
// Puro e sem Node: o SPA importa pelo shim `web/src/engine/csv.ts`.

/** Primeiro caractere que planilhas interpretam como início de fórmula. */
const FORMULA_START = /^[=+\-@\t\r]/u;

/** Exige aspas (RFC 4180): separador, aspas ou quebra de linha (LF ou CR). */
const NEEDS_QUOTES = /[",\r\n]/u;

/** Escapa UM valor para uma célula CSV (RFC 4180 + neutralização de fórmula). */
export function csvCell(value: unknown): string {
  let s = value === undefined || value === null ? '' : String(value);
  if (typeof value === 'string' && FORMULA_START.test(s)) s = `'${s}`;
  return NEEDS_QUOTES.test(s) ? `"${s.replace(/"/gu, '""')}"` : s;
}

/** Uma linha CSV (sem o terminador). */
export function csvRow(values: readonly unknown[]): string {
  return values.map(csvCell).join(',');
}
