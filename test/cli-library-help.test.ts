// cli#16 — `prompt-builder library --help` mostrava um stub que apontava para
// ele mesmo ("veja `prompt-builder library --help`"): o `main` intercepta
// `--help` antes do dispatch, então o HELP detalhado de `commands/library.ts`
// nunca era impresso. Agora o texto real mora SÓ no help central.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { renderCommandHelp } from '../src/cli/help.js';
import { cmdLibrary } from '../src/cli/commands/library.js';
import { EXIT } from '../src/cli/output.js';
import { ROOT, nodeOrTsx } from './support/cli.js';

const TRECHOS = [
  'library init --profile <id>',
  '--rules <arq.json>',
  '--targets <arq.json>',
  'library add --profile <id> --file <arq|dir>',
  'library seed --profile <id> --file <arq|dir>',
  '--generate <N> --theme <t> --model <id>',
  '--tier adversarial',
  '--base-prompt-file <arq>',
  '--languages pt-BR,en',
  'library verify --profile <id>',
  'library coverage --profile <id>',
  'library export --profile <id>',
  '--format exchange|pack',
  'prompt-builder-exchange@1',
  'library rm --profile <id> <itemId>',
  'library drop --profile <id>',
  'labelSet',
  '--limit N',
];

afterEach(() => vi.restoreAllMocks());

describe('cli#16 — library --help mostra a ajuda REAL', () => {
  it('o help central cobre init/add/seed/--generate/--tier/--rules/export e não aponta para si mesmo', () => {
    const texto = renderCommandHelp('library');
    for (const t of TRECHOS) expect(texto, t).toContain(t);
    expect(texto).not.toContain('veja `prompt-builder library --help`');
  });

  it('chamada direta de `library --help` imprime o MESMO texto (fonte única)', async () => {
    const saida: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      saida.push(String(c));
      return true;
    });
    expect(await cmdLibrary(['--help'])).toBe(EXIT.OK);
    expect(saida.join('')).toBe(renderCommandHelp('library'));
  });

  it('processo real: `library --help` (e `library seed -h`) sai 0 com a ajuda detalhada', () => {
    const { cmd, entry } = nodeOrTsx(path.join(ROOT, 'src', 'cli', 'index.ts'));
    for (const argv of [['library', '--help'], ['library', 'seed', '-h']]) {
      const r = spawnSync(cmd, [entry, ...argv], { encoding: 'utf-8', env: { ...process.env, CLAUDECODE: '' } });
      expect(r.status, r.stderr).toBe(0);
      for (const t of TRECHOS) expect(r.stdout, t).toContain(t);
    }
  });
});
