// IMPL-119 (R-19:REC-1) — lint da documentação embarcada (agent-docs/):
//   (1) exemplos de configuração da doc são EXECUTADOS no validador real
//       (`config validate` / parser de arena-agent-config) e saem exit 0 — ou
//       estão marcados como negativos e são RECUSADOS;
//   (2) exemplo novo adicionado à doc reprova o CI se não validar;
//   (3) snapshot de `--help` por subcomando com cobertura 100% dos COMMANDS e
//       "gerado ≠ commitado" reprova.
// Mais: comandos dos blocos bash conferidos contra COMMANDS + help, e o drift
// CONHECIDO só é isento com registo auditável (file+kind+hash do bloco).

import { describe, expect, it } from 'vitest';
import { COMMANDS, renderCommandHelp } from '../src/cli/help.js';
import {
  KNOWN_DOC_DRIFT,
  blockHash,
  helpSnapshot,
  helpSnapshotFindings,
  lintDocs,
  readHelpSnapshot,
  type DocSource,
} from '../scripts/docs-lint.js';

const doc = (markdown: string, file = 'agent-docs/teste.md'): DocSource[] => [{ file, markdown }];

const CONFIG_VALIDO = `{
  "format": "arena-config@1",
  "mode": "compare",
  "theme": "Tema de teste do lint",
  "models": {
    "datagen": "openai/gpt-5-mini",
    "judges": ["anthropic/claude-sonnet-5"],
    "competitors": ["google/gemini-2.5-flash", "openai/gpt-4.1-mini"]
  }
}`;

describe('IMPL-119 (1) — exemplos da doc passam pelo validador REAL', () => {
  it('a doc embarcada de hoje: 0 achado (exit 0 no config validate real) e cobertura de verdade', async () => {
    const r = await lintDocs();
    expect(r.findings).toEqual([]);
    // Exemplos de configuração EXECUTADOS no validador real (não "bonitos à vista").
    expect(r.checked.configExamples).toBeGreaterThanOrEqual(2);
    expect(r.checked.files).toBeGreaterThanOrEqual(10);
    // Comandos conferidos contra COMMANDS + help (critério dos blocos bash).
    expect(r.checked.commandInvocations).toBeGreaterThan(20);
  });

  it('todo drift conhecido é AUDITÁVEL (motivo + correção) e keyed por hash do bloco', () => {
    expect(KNOWN_DOC_DRIFT.length).toBeGreaterThan(0); // o exemplo de compare.md é drift REAL e está registado
    for (const d of KNOWN_DOC_DRIFT) {
      expect(d.reason.trim().length, 'isenção sem motivo não entra').toBeGreaterThan(20);
      expect(d.fix.trim().length, 'isenção sem correção esperada não entra').toBeGreaterThan(20);
      expect(d.blockHash).toMatch(/^[0-9a-f]{16}$/);
    }
    // Isenção não é licença permanente: o hash é do bloco EXATO — editar o
    // exemplo derruba a isenção e o CI reprova de novo.
    const hashDoExemploDeCompare = blockHash(`{
  "format": "arena-config@1",
  "mode": "compare",
  "theme": "…",
  "models": {
    "datagen": "openai/gpt-5-mini",
    "judges": ["anthropic/claude-sonnet-5"],
    "competitorConfigs": [
      { "model": "openai/gpt-5-mini", "reasoning": "low" },
      { "model": "openai/gpt-5-mini", "reasoning": "high" }
    ]
  }
}`);
    expect(KNOWN_DOC_DRIFT.some((d) => d.blockHash === hashDoExemploDeCompare)).toBe(true);
  });
});

describe('IMPL-119 (2) — exemplo novo na doc reprova o CI se não validar', () => {
  it('exemplo válido passa sem achado', async () => {
    const r = await lintDocs(doc(`# Doc de teste\n\n\`\`\`json\n${CONFIG_VALIDO}\n\`\`\`\n`));
    expect(r.findings).toEqual([]);
    expect(r.checked.configExamples).toBe(1);
  });

  it('exemplo com chave que o parser engoliria é ERRO (fail-closed do validador real)', async () => {
    const invalido = CONFIG_VALIDO.replace('"theme"', '"them": "x",\n  "theme"');
    const r = await lintDocs(doc(`\`\`\`json\n${invalido}\n\`\`\`\n`));
    expect(r.findings.map((f) => f.kind)).toEqual(['config-invalid']);
    expect(r.findings[0].message).toMatch(/them|desconhecid/i);
  });

  it('exemplo com JSON quebrado reprova (não passa por "não é bem um exemplo")', async () => {
    const quebrado = `${CONFIG_VALIDO}\n  ,,,`;
    const r = await lintDocs(doc(`\`\`\`json\n${quebrado}\n\`\`\`\n`));
    expect(r.findings.map((f) => f.kind)).toEqual(['config-unparseable']);
  });

  it('regra cruzada do validador real também reprova a doc (datagen ≠ competidor)', async () => {
    const cruzado = `{
  "format": "arena-config@1",
  "mode": "compare",
  "theme": "…",
  "models": {
    "datagen": "openai/gpt-5-mini",
    "judges": ["anthropic/claude-sonnet-5"],
    "competitorConfigs": [
      { "model": "openai/gpt-5-mini", "reasoning": "low" },
      { "model": "openai/gpt-5-mini", "reasoning": "high" }
    ]
  }
}`;
    const r = await lintDocs(doc(`\`\`\`json\n${cruzado}\n\`\`\`\n`, 'agent-docs/outro.md'));
    // Fora do registro de drift conhecido (arquivo/hash diferentes) ⇒ reprova.
    expect(r.findings.map((f) => f.kind)).toEqual(['config-invalid']);
    expect(r.waived).toEqual([]);
  });
});

describe('IMPL-119 (1) — exemplos NEGATIVOS exigem marcação explícita', () => {
  const invalido = CONFIG_VALIDO.replace('compare', 'compareX'); // mode recusado

  it('negativo marcado (fence) é recusado pelo validador e o lint fica calado', async () => {
    const r = await lintDocs(doc(`\`\`\`json expect-invalid\n${invalido}\n\`\`\`\n`));
    expect(r.findings).toEqual([]);
  });

  it('negativo marcado por comentário HTML antes da cerca', async () => {
    const r = await lintDocs(doc(`<!-- docs-lint: expect-invalid -->\n\`\`\`json\n${invalido}\n\`\`\`\n`));
    expect(r.findings).toEqual([]);
  });

  it('negativo marcado que o validador ACEITA reprova (marcação que sobrou/validador que mudou)', async () => {
    const r = await lintDocs(doc(`\`\`\`json expect-invalid\n${CONFIG_VALIDO}\n\`\`\`\n`));
    expect(r.findings.map((f) => f.kind)).toEqual(['config-negative-passed']);
  });

  it('snippet marcado (fragmento de config) não roda no validador', async () => {
    const r = await lintDocs(doc(`\`\`\`json snippet\n"scenarios": { "from": "library", "profile": "x" }\n\`\`\`\n`));
    expect(r.findings).toEqual([]);
    expect(r.checked.snippets).toBe(1);
    expect(r.checked.configExamples).toBe(0);
  });
});

describe('IMPL-119 — comandos da doc conferidos contra COMMANDS + help', () => {
  it('comando real da doc passa; comando fantasma reprova', async () => {
    const md = `\`\`\`bash\nprompt-builder runs show <id> --json | jq .\nprompt-builder frobnicate --now\n\`\`\`\n`;
    const r = await lintDocs(doc(md));
    expect(r.findings.map((f) => f.kind)).toEqual(['command-unknown']);
    expect(r.findings[0].message).toMatch(/frobnicate/);
  });

  it('subcomando que não existe no help reprova; placeholders e valores de flag não', async () => {
    const md = `\`\`\`bash\nprompt-builder runs naoExiste <id>\nprompt-builder models show <id> --json | jq .model.thinkLevels\necho "$OPENROUTER_API_KEY" | npx prompt-builder-cli key set --stdin\n\`\`\`\n`;
    const r = await lintDocs(doc(md));
    expect(r.findings.map((f) => f.kind)).toEqual(['subcommand-unknown']);
    expect(r.checked.commandInvocations).toBe(3);
  });
});

describe('IMPL-119 (3) — snapshot de --help: cobertura 100% e gerado ≠ commitado reprova', () => {
  it('o snapshot commitado cobre TODO subcomando e bate com o gerado', () => {
    const commitado = readHelpSnapshot();
    // Cobertura 100%: cada subcomando da tabela COMMANDS tem snapshot…
    expect(Object.keys(commitado).sort()).toEqual([...COMMANDS].sort());
    // …e o texto gerado hoje é o commitado (gerado ≠ commitado reprova).
    expect(helpSnapshotFindings(commitado)).toEqual([]);
  });

  it('help que muda sem regenerar o snapshot reprova', () => {
    const commitado = readHelpSnapshot();
    const mudado = { ...commitado, runs: `${commitado.runs}\nlinha nova` };
    const achados = helpSnapshotFindings(mudado);
    expect(achados.map((f) => f.kind)).toEqual(['help-changed']);
  });

  it('subcomando novo sem snapshot reprova; snapshot de comando morto reprova', () => {
    const commitado = readHelpSnapshot();
    const { runs: _omitido, ...semRuns } = commitado;
    expect(helpSnapshotFindings(semRuns).map((f) => f.kind)).toEqual(['help-missing']);
    const comMorto = { ...commitado, 'frobnicate': renderCommandHelp('runs') };
    expect(helpSnapshotFindings(comMorto).map((f) => f.kind)).toEqual(['help-extra']);
  });
});
describe('agent-docs — os números do holdout batem com src/holdout.ts (fonte única)', () => {
  it('padrão do holdoutRatio, piso de cenários reservados e seleção mínima', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { HOLDOUT_RATIO_DEFAULT, MIN_HOLDOUT_SCENARIOS, MIN_SCENARIOS_FOR_HOLDOUT } = await import('../src/holdout.js');
    const md: string[] = [];
    const varrer = (dir: string): void => {
      for (const nome of readdirSync(dir)) {
        const p = join(dir, nome);
        if (statSync(p).isDirectory()) varrer(p);
        else if (p.endsWith('.md')) md.push(p);
      }
    };
    for (const raiz of ['agent-docs', 'skills']) varrer(join(process.cwd(), raiz));
    expect(md.length).toBeGreaterThan(5);
    const razao = String(HOLDOUT_RATIO_DEFAULT).replace('.', ',');
    const achados: string[] = [];
    let conferidos = 0;
    for (const arq of md) {
      // Parágrafo = bloco entre linhas em branco, item de lista ou linha de tabela.
      const blocos = readFileSync(arq, 'utf-8').split(/\n\s*\n|\n(?=\s*(?:[-*|]|\d+\.)\s)/u);
      for (const bloco of blocos) {
        const texto = bloco.replace(/\s+/gu, ' ');
        if (!/holdout/iu.test(texto)) continue;
        if (/holdout[-_]?ratio/iu.test(texto)) {
          for (const m of texto.matchAll(/padr[ãa]o:? (\d+[.,]\d+)/giu)) {
            conferidos += 1;
            if (m[1].replace('.', ',') !== razao) achados.push(`${arq}: holdoutRatio "padrão ${m[1]}" ≠ ${razao}`);
          }
        }
        for (const m of texto.matchAll(/(\d+) cen[áa]rios reservados|piso absoluto de (\d+) cen[áa]rios/giu)) {
          conferidos += 1;
          const n = Number(m[1] ?? m[2]);
          if (n !== MIN_HOLDOUT_SCENARIOS) achados.push(`${arq}: piso "${m[0]}" ≠ ${MIN_HOLDOUT_SCENARIOS}`);
        }
        for (const m of texto.matchAll(/sele[çc][ãa]o (?:com menos de|≥) (\d+) cen[áa]rios|sele[çc][ãa]o ≥ (\d+)/giu)) {
          conferidos += 1;
          const n = Number(m[1] ?? m[2]);
          if (n !== MIN_SCENARIOS_FOR_HOLDOUT) achados.push(`${arq}: seleção mínima "${m[0]}" ≠ ${MIN_SCENARIOS_FOR_HOLDOUT}`);
        }
      }
    }
    expect(achados).toEqual([]);
    // A checagem viu os números de verdade (overview + train), não passou no vazio.
    expect(conferidos).toBeGreaterThanOrEqual(4);
  });
});
