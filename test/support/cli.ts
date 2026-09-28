import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');

/**
 * Executa um entrypoint de `src/` pelo binário COMPILADO (`dist/`, o que o
 * utilizador real corre) — muito mais rápido que o cold start do tsx por spawn.
 * Cai para o tsx só quando não existe build.
 */
export function nodeOrTsx(srcEntry: string): { cmd: string; entry: string } {
  const rel = path.relative(path.join(ROOT, 'src'), srcEntry);
  const distEntry = path.join(ROOT, 'dist', rel.replace(/\.ts$/, '.js'));
  if (fs.existsSync(distEntry)) return { cmd: process.execPath, entry: distEntry };
  return { cmd: path.join(ROOT, 'node_modules', '.bin', 'tsx'), entry: srcEntry };
}
