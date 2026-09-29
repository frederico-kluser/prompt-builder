// IMPL-063 / IMPL-115 (left#4, onda 3) — o arena-config@1 expressa o dedup
// semântico (`scenarioDedup`) e o modo econômico do juiz (`judgeCascade`).
//
// Antes só o RunConfig cru e as flags (`--semantic-dedup`, `--judge-cascade`)
// os tinham: o `--config arena.json` NÃO conseguia pedir nenhum dos dois (a
// chave era "desconhecida", exit 3). Agora: os dois mirrors do arquivo (Node e
// SPA) validam, `arenaConfigToRunConfig` entrega ao RunConfig, `config
// validate` aceita, a vista arena do `runs reproduce` os devolve e a SPA avisa
// no import (json-only `ignorado`: a tela não os repassa).

import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArenaConfig } from '../src/configFile.js';
import { parseArenaConfig as parseArenaConfigWeb } from '../web/src/engine/configFile.js';
import { arenaConfigToRunConfig } from '../src/arenaConfig.js';
import { runConfigToArenaConfig } from '../src/runArtifact.js';
import { cmdConfig } from '../src/cli/commands/misc.js';
import { readConfigFile } from '../src/cli/commands/run.js';
import { EXIT, resetOutputState, toCliError } from '../src/cli/output.js';
import { applyArenaConfigToForm, defaultArenaFormState } from '../web/src/arenaForm.js';

const BASE = {
  format: 'arena-config@1',
  mode: 'compare',
  theme: 'Classificação de chamados',
  stages: 4,
  models: {
    datagen: 'acme/gen',
    judges: ['acme/judge-forte'],
    competitors: ['acme/alpha', 'acme/beta'],
  },
} as const;

const EXTRA = {
  scenarioDedup: { semantic: true, embedModelId: 'acme/embed', cosineThreshold: 0.92, echoThreshold: 0.88 },
  judgeCascade: { cheap: ['acme/barato-1', 'acme/barato-2'], strong: 'acme/judge-forte' },
};

const PARSERS = [
  ['Node', parseArenaConfig],
  ['SPA', parseArenaConfigWeb],
] as const;

describe('arena-config@1 — scenarioDedup e judgeCascade', () => {
  for (const [nome, parse] of PARSERS) {
    it(`${nome}: aceita os dois blocos e os preserva`, () => {
      const r = parse({ ...BASE, ...EXTRA });
      expect(r.ok, r.ok ? '' : r.error).toBe(true);
      if (!r.ok) return;
      expect(r.config.scenarioDedup).toEqual(EXTRA.scenarioDedup);
      expect(r.config.judgeCascade).toEqual(EXTRA.judgeCascade);
    });

    it(`${nome}: recusa cascata com forte igual a um barato, 1 barato só e limiar fora de 0.5..1`, () => {
      const repetido = parse({ ...BASE, judgeCascade: { cheap: ['a/x', 'a/y'], strong: 'a/x' } });
      expect(repetido.ok).toBe(false);
      if (!repetido.ok) expect(repetido.error).toMatch(/distintos/);
      expect(parse({ ...BASE, judgeCascade: { cheap: ['a/x'], strong: 'a/z' } }).ok).toBe(false);
      expect(parse({ ...BASE, scenarioDedup: { cosineThreshold: 0.3 } }).ok).toBe(false);
      expect(parse({ ...BASE, scenarioDedup: { semantic: 'sim' } }).ok).toBe(false);
    });
  }

  it('arenaConfigToRunConfig entrega os dois ao RunConfig (a run os executa)', () => {
    const r = parseArenaConfig({ ...BASE, ...EXTRA });
    if (!r.ok) throw new Error(r.error);
    const conv = arenaConfigToRunConfig(r.config);
    expect(conv.ok, conv.ok ? '' : conv.error).toBe(true);
    if (!conv.ok) return;
    expect(conv.config.scenarioDedup).toEqual(EXTRA.scenarioDedup);
    expect(conv.config.judgeCascade).toEqual(EXTRA.judgeCascade);
    // A vista arena do `runs reproduce` devolve os dois (round-trip).
    const vista = runConfigToArenaConfig(conv.config);
    expect(vista.scenarioDedup).toEqual(EXTRA.scenarioDedup);
    expect(vista.judgeCascade).toEqual(EXTRA.judgeCascade);
    const volta = arenaConfigToRunConfig(vista);
    expect(volta.ok && volta.config.judgeCascade).toEqual(EXTRA.judgeCascade);
  });

  it('a separação de papéis da run vale para a cascata (juiz barato que compete = exit 3)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pb-cascata-'));
    try {
      const f = path.join(dir, 'arena.json');
      writeFileSync(f, JSON.stringify({ ...BASE, judgeCascade: { cheap: ['acme/alpha', 'acme/barato'], strong: 'acme/judge-forte' } }));
      await expect(readConfigFile(f)).rejects.toMatchObject({ code: EXIT.CONFIG });
      writeFileSync(f, JSON.stringify({ ...BASE, ...EXTRA }));
      const cfg = await readConfigFile(f);
      expect(cfg.judgeCascade).toEqual(EXTRA.judgeCascade);
      expect(cfg.scenarioDedup).toEqual(EXTRA.scenarioDedup);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('`config validate` aceita o arquivo com os dois blocos (sem chave desconhecida)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pb-cascata-cli-'));
    const f = path.join(dir, 'arena.json');
    writeFileSync(f, JSON.stringify({ ...BASE, ...EXTRA }));
    resetOutputState();
    const so = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const se = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await cmdConfig(['validate', f, '--json'])).toBe(EXIT.OK);
      // Typo dentro do bloco continua ERRO (fail-closed, IMPL-093).
      writeFileSync(f, JSON.stringify({ ...BASE, scenarioDedup: { semantik: true } }));
      let code = -1;
      try {
        await cmdConfig(['validate', f, '--json']);
      } catch (e) {
        code = toCliError(e).code;
      }
      expect(code).toBe(EXIT.CONFIG);
    } finally {
      so.mockRestore();
      se.mockRestore();
      resetOutputState();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('SPA: o import AVISA que a tela não repassa (nunca descarta calado)', () => {
    const r = parseArenaConfigWeb({ ...BASE, ...EXTRA });
    if (!r.ok) throw new Error(r.error);
    const { warnings } = applyArenaConfigToForm(defaultArenaFormState(), r.config, { raw: { ...BASE, ...EXTRA } });
    const paths = warnings.map((w) => w.path);
    for (const p of ['scenarioDedup.semantic', 'judgeCascade.cheap', 'judgeCascade.strong']) {
      expect(paths, p).toContain(p);
    }
  });
});
