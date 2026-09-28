// IMPL-116 (R-08:REC-6) — VETO DE CACHE SEMÂNTICO DE VEREDITOS: arch test.
//
// Decisão NEGATIVA documentada em `src/engine/judgeCalibration.ts` (o módulo de
// contrato do juiz): nenhum caminho de avaliação pode REUSAR vereditos por
// similaridade semântica (embeddings/vetores/cosseno/limiar de parecença).
// Motivo medido: 3–7% de falsos positivos nos limiares úteis ("sort an array"
// vs "sort an array in descending order" ficam a 0,94) = veredito reusado errado
// — a MESMA gravidade de um estouro de orçamento. O reuso EXATO por hash de
// contrato/pedido (R-08:REC-3) fica FORA do veto.
//
// Contratos provados aqui:
//  (i)   a decisão está documentada no repositório (judgeCalibration.ts);
//  (ii)  o detector reprova a introdução de similaridade/embeddings em QUALQUER
//        módulo de avaliação (incluindo o mirror do web) — com prova de que o
//        detector não é vazio (controle positivo sobre um trecho violador);
//  (iii) nenhum modo de run reusa veredito por similaridade: os módulos que
//        produzem/consumem vereditos não têm máquina de parecença nenhuma.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const raiz = fileURLToPath(new URL('..', import.meta.url));

/** Módulos do CAMINHO DE AVALIAÇÃO (produzem/consumem vereditos). */
const CAMINHO_AVALIACAO = [
  'src/refJudge.ts', // juiz pointwise por referência
  'src/judge.ts', // juiz listwise (fallback)
  'src/duels.ts', // finais/duelos
  'src/gabarito.ts', // referência (gabarito temp-0)
  'src/engine/judgeCalibration.ts', // contrato/calibração do juiz
  'src/engine/duelCore.ts', // matemática do duelo
  'src/engine/duelPrompt.ts', // prompts do duelo
  'src/engine/verdictAggregate.ts', // agregação de vereditos
  'src/engine/verdictIntegrity.ts', // integridade de vereditos
  'src/engine/groundTruth.ts', // rótulos determinísticos
  'web/src/engine/refJudge.ts', // mirrors/shims do browser
  'web/src/engine/judge.ts',
  'web/src/engine/duels.ts',
  'web/src/engine/gabarito.ts',
];

/** Código sem comentários: a prosa cita o veto; o detector olha o CÓDIGO. */
function semComentarios(texto: string): string {
  return texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * O detector do veto. Procura a máquina de parecença — imports de
 * embeddings/similaridade, funções de cosseno/vetores, reuso de veredito por
 * cache de similaridade. Dedup EXATO (por id/hash) não é parecença: fica fora.
 */
function violacoesVeto(codigo: string): string[] {
  const padroes: Array<[string, RegExp]> = [
    ['import de módulo de embeddings/similaridade/dedup-semântico', /from\s+['"][^'"]*(embed|similar|vector|dedup)[^'"]*['"]/i],
    ['função de similaridade (cosine/cosseno)', /cosine|cosseno/i],
    ['representação vetorial (embedding)', /embedding/i],
    ['medida de similaridade', /similarity|similaridade/i],
    ['reuso de veredito por cache', /verdict\w*Cache|cache\w*Verdict|reuse\w*Verdict|verdict\w*Reuse/i],
  ];
  return padroes.filter(([, re]) => re.test(codigo)).map(([nome]) => nome);
}

describe('IMPL-116 (i) — a decisão negativa está documentada no repositório', () => {
  it('judgeCalibration.ts regista o veto (R-08:REC-6) e o que fica fora (hash exato)', () => {
    const fonte = readFileSync(join(raiz, 'src', 'engine', 'judgeCalibration.ts'), 'utf-8');
    expect(fonte).toMatch(/R-08:REC-6/);
    expect(fonte).toMatch(/VETO DE CACHE SEMÂNTICO/);
    expect(fonte).toMatch(/similaridade semântica/i);
    // O reuso por IGUALDADE EXATA (hash) é explicitamente fora do veto.
    expect(fonte).toMatch(/IGUALDADE\s+EXATA/);
    expect(fonte).toMatch(/R-08:REC-3/);
  });
});

describe('IMPL-116 (ii/iii) — nenhum módulo de avaliação reusa veredito por similaridade', () => {
  it('varredura do caminho de avaliação: zero máquina de parecença', () => {
    const apanhados: string[] = [];
    for (const rel of CAMINHO_AVALIACAO) {
      const codigo = semComentarios(readFileSync(join(raiz, rel), 'utf-8'));
      for (const v of violacoesVeto(codigo)) apanhados.push(`${rel}: ${v}`);
    }
    expect(apanhados, 'similaridade semântica em caminho de avaliação (veto R-08:REC-6)').toEqual([]);
  });

  it('controle positivo: o detector REPROVA um trecho violador (não é guarda vazia)', () => {
    const violador = `
      import { cosineSim } from './engine/embeddings.js';
      const cache = new Map<string, Verdict>();
      export function vereditoPorParecenca(texto: string): Verdict | undefined {
        const alvo = embed(texto);
        return cache.get(melhorSimilaridade(alvo, 0.94));
      }
    `;
    const apanhados = violacoesVeto(violador);
    expect(apanhados.length).toBeGreaterThan(0);
    expect(apanhados).toContain('função de similaridade (cosine/cosseno)');
    expect(apanhados).toContain('representação vetorial (embedding)');
  });

  it('controle negativo: dedup EXATO por id/hash não dispara o veto (fora dele por decisão)', () => {
    const legitimo = `
      // dedup defensivo: a 1ª ocorrência do id vence (igualdade exata).
      const vistos = new Set<string>();
      export function umaVezPorId(id: string): boolean {
        if (vistos.has(id)) return false;
        vistos.add(id);
        return true;
      }
    `;
    expect(violacoesVeto(semComentarios(legitimo))).toEqual([]);
  });
});
