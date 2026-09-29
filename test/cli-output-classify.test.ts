// cli#19 / cli#20 (restante, onda 3) — classificação do envelope em `output.ts`.
//
//   cli#19: `EPIPE` saiu de NET_ERRNO. O EPIPE do stdout (`| head`) já é
//     tratado pela guarda do pipe antes de chegar aqui (sai 0); um EPIPE cru
//     que escape (stdin de processo filho, …) não é "falha de rede" — a dica
//     mandava conferir a conexão com openrouter.ai. O EPIPE de SOCKET real
//     chega do undici como `fetch failed`/`UND_ERR_SOCKET` e continua rede (8).
//   cli#20: a dica padrão de `config` não supõe mais que houve arquivo — a
//     config também vem de flags — e cita os três dialetos que o
//     `config validate` aceita.

import { describe, expect, it } from 'vitest';
import { DEFAULT_HINT, EXIT, toCliError, errorObject } from '../src/cli/output.js';

describe('cli#19 — EPIPE cru não é falha de rede', () => {
  it('EPIPE de escrita (sem undici) → internal (exit 1), nunca network.unreachable', () => {
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE', syscall: 'write', errno: -32 });
    const e = toCliError(epipe);
    expect(e.code).toBe(EXIT.ERROR);
    expect(e.errorCode).not.toMatch(/^network\./);
    expect(e.message).not.toMatch(/Falha de rede/);
    expect(errorObject(e).hint).not.toMatch(/openrouter\.ai/);
  });

  it('EPIPE de SOCKET chega do undici como `fetch failed` → continua rede (exit 8)', () => {
    const viaUndici = new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'EPIPE' }) });
    expect(toCliError(viaUndici)).toMatchObject({ code: EXIT.NETWORK, errorCode: 'network.unreachable' });
    const socket = Object.assign(new Error('socket hang up'), { code: 'UND_ERR_SOCKET' });
    expect(toCliError(socket)).toMatchObject({ code: EXIT.NETWORK, errorCode: 'network.unreachable' });
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(toCliError(reset).code).toBe(EXIT.NETWORK);
  });
});

describe('cli#20 — dica padrão de config honesta', () => {
  it('não supõe arquivo: cobre flags e os três dialetos do `config validate`', () => {
    const hint = DEFAULT_HINT.config;
    expect(hint).toContain('config validate');
    expect(hint).toMatch(/veio de arquivo/);
    expect(hint).toMatch(/flags/);
    for (const formato of ['arena-config@1', 'arena-agent-config@1|@2', 'RunConfig cru']) {
      expect(hint).toContain(formato);
    }
    expect(hint).toContain('config example');
  });
});
