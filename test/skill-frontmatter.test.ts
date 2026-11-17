// Guarda do frontmatter YAML das skills embarcadas (skills/*/SKILL.md).
//
// O `skill-filesystem` do DSH chama `parseYaml` no bloco `---…---` e, quando o
// parse falha, IGNORA o arquivo com um `logger.warn` — a skill some do catálogo
// e do menu `/` sem erro visível para quem usa. Aconteceu com a skill do
// produto: a `description` era um escalar plano com `TypeSafe: noul/choice/score`
// no meio, e o YAML lia isso como mapping aninhado ("Nested mappings are not
// allowed in compact mappings at line 2, column 14").
//
// O parser aqui é o MESMO `yaml` que o DSH usa, para o teste reprovar pelo
// mesmo motivo que o loader reprovaria — não por uma imitação da regra.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = path.join(ROOT, 'skills');

interface Frontmatter {
  name?: unknown;
  description?: unknown;
}

/** Bloco `---\n…\n---` do começo do arquivo, ou `null` se não houver. */
function frontmatterBlock(source: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  return match?.[1] ?? null;
}

function skillDirs(): string[] {
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(SKILLS_DIR, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
}

describe('frontmatter das skills embarcadas', () => {
  const dirs = skillDirs();

  it('encontra ao menos a skill do produto', () => {
    expect(dirs).toContain('prompt-builder');
  });

  for (const dir of dirs) {
    describe(`skills/${dir}/SKILL.md`, () => {
      const file = path.join(SKILLS_DIR, dir, 'SKILL.md');
      const source = fs.readFileSync(file, 'utf-8');
      const block = frontmatterBlock(source);

      it('tem bloco de frontmatter delimitado', () => {
        expect(block, 'frontmatter `---…---` ausente').not.toBeNull();
      });

      it('faz o parse YAML como o loader do DSH', () => {
        // Sem try/catch de propósito: a mensagem do parser (ex.: "Nested
        // mappings are not allowed…") é o diagnóstico que se quer no CI.
        const data = parseYaml(block ?? '') as Frontmatter;
        expect(data).toBeTypeOf('object');
        expect(data).not.toBeNull();
        expect(typeof data.name).toBe('string');
        expect(typeof data.description).toBe('string');
        expect((data.description as string).trim().length).toBeGreaterThan(0);
      });

      it('declara o nome igual ao diretório', () => {
        const data = parseYaml(block ?? '') as Frontmatter;
        expect(data.name).toBe(dir);
      });
    });
  }
});
