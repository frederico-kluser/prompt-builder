// IMPL-063 (R-05:REC-7) — dedup semântico por embeddings + cosseno sobre o PAR
// (pergunta+contexto), com checagem auxiliar só-pergunta para eco de template.
//
// A sonda N1 mediu os dois erros da antiga camada ROUGE-L ≥ 0,7 sobre a
// pergunta: paráfrases REAIS passavam (similaridade 0,00 e 0,12) e perguntas
// que diferem só por entidade COLAPSAM (0,88 e 0,91 → viravam duplicata e eram
// descartadas). A fixture abaixo reproduz o regime medido e cobra a correção:
// 0 falso-positivo nos pares por entidade, recall ≥ 0,9 nas paráfrases.
//
// O embedder é injetado (`EmbedFn`) — aqui um stand-in determinístico com a
// geometria realista do caso (paráfrase ≈ 0,93 de cosseno; par por entidade
// também ALTO, ≈ 0,95: quem impede o colapso é o VETO de entidade, não uma
// sorte de geometria). Em produção a rota é /v1/embeddings do OpenRouter (Node)
// ou transformers.js (navegador).

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COSINE_THRESHOLD,
  DEFAULT_ECHO_THRESHOLD,
  DEDUP_ALERT_RATE,
  combineDedupeReports,
  cosine,
  dedupeAdvanced,
  dedupeSemantic,
  entityConflict,
  rougeL,
  salientTokens,
  type DedupeReport,
  type EmbedFn,
} from '../src/dedup.js';
import * as dedupWeb from '../web/src/engine/dedup.js';

interface Item {
  question: string;
  productContext: string;
  rubric?: string;
}

// ---------------------------------------------------------------------------
// Pares da medida N1
// ---------------------------------------------------------------------------

/** Paráfrases verdadeiras (mesma resposta esperada; ROUGE-L ≈ 0,12 e ≈ 0,00). */
const PARAFRASES: { a: Item; b: Item }[] = [
  {
    a: {
      question: 'Posso desistir da compra depois de fechar o pedido?',
      productContext: 'Política ACME: trocas e devoluções em até 30 dias com nota fiscal.',
      rubric: 'Deve citar a janela de 30 dias.',
    },
    b: {
      question: 'Qual é o prazo para trocar o produto?',
      productContext: 'Política ACME: trocas e devoluções em até 30 dias com nota fiscal.',
      rubric: 'Deve citar a janela de 30 dias.',
    },
  },
  {
    a: {
      question: 'Consigo reverter cobrança indevida?',
      productContext: 'Faturamento ACME: estorno de cobrança errada em até 2 ciclos.',
      rubric: 'Deve citar o estorno em 2 ciclos.',
    },
    b: {
      question: 'Como anular valor errado?',
      productContext: 'Faturamento ACME: estorno de cobrança errada em até 2 ciclos.',
      rubric: 'Deve citar o estorno em 2 ciclos.',
    },
  },
  {
    a: {
      question: 'Onde vejo o andamento do pedido 4471?',
      productContext: 'Rastreio ACME: status do pedido no app, seção Pedidos.',
      rubric: 'Deve apontar a seção Pedidos.',
    },
    b: {
      question: 'Qual página mostra a situação da compra 4471?',
      productContext: 'Rastreio ACME: status do pedido no app, seção Pedidos.',
      rubric: 'Deve apontar a seção Pedidos.',
    },
  },
  {
    a: {
      question: 'Quanto custa o frete para Manaus?',
      productContext: 'Frete ACME: R$ 25 para a região Norte, grátis acima de R$ 300.',
      rubric: 'Deve citar R$ 25 ou a isenção acima de R$ 300.',
    },
    b: {
      question: 'Qual a taxa de remessa à capital amazonense?',
      productContext: 'Frete ACME: R$ 25 para a região Norte, grátis acima de R$ 300.',
      rubric: 'Deve citar R$ 25 ou a isenção acima de R$ 300.',
    },
  },
  {
    a: {
      question: 'Posso pagar em parcelas?',
      productContext: 'Pagamento ACME: até 12x sem juros no cartão.',
      rubric: 'Deve citar até 12x sem juros.',
    },
    b: {
      question: 'Existe parcelamento no cartão?',
      productContext: 'Pagamento ACME: até 12x sem juros no cartão.',
      rubric: 'Deve citar até 12x sem juros.',
    },
  },
  {
    a: {
      question: 'A garantia cobre quebra acidental?',
      productContext: 'Garantia ACME: 12 meses para defeito de fabricação, sem cobertura de quebra acidental.',
      rubric: 'Deve dizer que quebra acidental não entra.',
    },
    b: {
      question: 'Queda do aparelho está coberta?',
      productContext: 'Garantia ACME: 12 meses para defeito de fabricação, sem cobertura de quebra acidental.',
      rubric: 'Deve dizer que quebra acidental não entra.',
    },
  },
  {
    a: {
      question: 'Como falo com um atendente humano?',
      productContext: 'Suporte ACME: atendimento humano pelo chat, das 8h às 20h.',
      rubric: 'Deve apontar o chat 8h-20h.',
    },
    b: {
      question: 'Qual canal me atende com pessoa de verdade?',
      productContext: 'Suporte ACME: atendimento humano pelo chat, das 8h às 20h.',
      rubric: 'Deve apontar o chat 8h-20h.',
    },
  },
  {
    a: {
      question: 'É possível trocar só a cor do item?',
      productContext: 'Trocas ACME: troca de variação (cor/tamanho) sem custo em 30 dias.',
      rubric: 'Deve permitir troca de variação em 30 dias.',
    },
    b: {
      question: 'Mudar o tom do produto conta como troca?',
      productContext: 'Trocas ACME: troca de variação (cor/tamanho) sem custo em 30 dias.',
      rubric: 'Deve permitir troca de variação em 30 dias.',
    },
  },
  {
    a: {
      question: 'Vocês emitem nota fiscal para CNPJ?',
      productContext: 'Fiscal ACME: nota fiscal para CNPJ informando o CNPJ no checkout.',
      rubric: 'Deve pedir o CNPJ no checkout.',
    },
    b: {
      question: 'Preciso de documento tributário pra firmar com a empresa?',
      productContext: 'Fiscal ACME: nota fiscal para CNPJ informando o CNPJ no checkout.',
      rubric: 'Deve pedir o CNPJ no checkout.',
    },
  },
  {
    a: {
      question: 'O que fazer se vier faltando peça?',
      productContext: 'Pós-venda ACME: item incompleto tem reposição em até 7 dias.',
      rubric: 'Deve citar reposição em 7 dias.',
    },
    b: {
      question: 'Como resolver produto incompleto?',
      productContext: 'Pós-venda ACME: item incompleto tem reposição em até 7 dias.',
      rubric: 'Deve citar reposição em 7 dias.',
    },
  },
];

/**
 * Pares que diferem SÓ por entidade (ROUGE-L alto: 0,88–0,91) — no mundo real
 * o par tem RESPOSTA diferente (cada produto tem o seu prazo/preço). Colapsar
 * qualquer um deles é falso-positivo.
 */
const ENTIDADES: { a: Item; b: Item }[] = [
  {
    a: {
      question: 'Qual o prazo de troca do Fone Aurora com nota fiscal?',
      productContext: 'Fone Aurora: troca em 30 dias com nota fiscal.',
    },
    b: {
      question: 'Qual o prazo de troca do Fone Eclipse com nota fiscal?',
      productContext: 'Fone Eclipse: troca em 7 dias com nota fiscal.',
    },
  },
  {
    a: {
      question: 'Qual é o prazo de troca do Fone Aurora para defeito de fabricação dentro da garantia legal do fornecedor?',
      productContext: 'Fone Aurora: defeito de fabricação trocado em 90 dias.',
    },
    b: {
      question: 'Qual é o prazo de troca do TV Prism para defeito de fabricação dentro da garantia legal do fornecedor?',
      productContext: 'TV Prism: defeito de fabricação trocado em 180 dias.',
    },
  },
  {
    a: {
      question: 'Qual o preço da TV Prism de 50 polegadas?',
      productContext: 'TV Prism 50": R$ 3.200 à vista.',
    },
    b: {
      question: 'Qual o preço da TV Prism de 55 polegadas?',
      productContext: 'TV Prism 55": R$ 4.100 à vista.',
    },
  },
  {
    a: {
      question: 'Qual o prazo de entrega do Notebook Vega para São Paulo?',
      productContext: 'Notebook Vega: entrega em SP em 3 dias úteis.',
    },
    b: {
      question: 'Qual o prazo de entrega do Tablet Vega para São Paulo?',
      productContext: 'Tablet Vega: entrega em SP em 10 dias úteis.',
    },
  },
  {
    a: {
      question: 'A TV Prism tem garantia estendida disponível?',
      productContext: 'TV Prism: garantia estendida de 24 meses por R$ 199.',
    },
    b: {
      question: 'A TV Íris tem garantia estendida disponível?',
      productContext: 'TV Íris: sem garantia estendida à venda.',
    },
  },
  {
    a: {
      question: 'Qual o peso do Notebook Vega para despacho postal?',
      productContext: 'Notebook Vega: 1,8 kg.',
    },
    b: {
      question: 'Qual o peso do Notebook Hércules para despacho postal?',
      productContext: 'Notebook Hércules: 2,6 kg.',
    },
  },
  {
    a: {
      question: 'O Fone Aurora acompanha estojo rígido de transporte?',
      productContext: 'Fone Aurora: acompanha estojo rígido.',
    },
    b: {
      question: 'O Fone Pulse acompanha estojo rígido de transporte?',
      productContext: 'Fone Pulse: não acompanha estojo.',
    },
  },
  {
    a: {
      question: 'Qual o prazo de reembolso do pedido 4471 pago no Pix?',
      productContext: 'Pedido 4471: reembolso Pix em 5 dias úteis.',
    },
    b: {
      question: 'Qual o prazo de reembolso do pedido 8812 pago no Pix?',
      productContext: 'Pedido 8812: reembolso Pix em 2 dias úteis.',
    },
  },
];

// ---------------------------------------------------------------------------
// Embedder stand-in determinístico (geometria realista; zero rede)
// ---------------------------------------------------------------------------

const DIMS = 24;

function unit(...entries: [number, number][]): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const [i, x] of entries) v[i] = x;
  return v;
}

/**
 * Vetores por item: cada par tem um eixo próprio. Paráfrases ficam em cosseno
 * ≈ 0,93 (acima do limiar 0,9 → fundem); pares por entidade ficam em ≈ 0,95
 * (TAMBÉM acima do limiar — só o veto de entidade impede o colapso).
 */
const VETORES = new Map<string, number[]>();
PARAFRASES.forEach((par, k) => {
  VETORES.set(par.a.question, unit([k, 1], [20, 0.19]));
  VETORES.set(par.b.question, unit([k, 1], [20, -0.19]));
});
ENTIDADES.forEach((par, k) => {
  VETORES.set(par.a.question, unit([10 + k, 1], [21, 0.16]));
  VETORES.set(par.b.question, unit([10 + k, 1], [21, -0.16]));
});

const embedFixture: EmbedFn = async (texts) =>
  texts.map((t) => {
    const pergunta = t.split('\n')[0];
    return VETORES.get(pergunta) ?? unit();
  });

const todos = (): Item[] => [...PARAFRASES.flatMap((p) => [p.a, p.b]), ...ENTIDADES.flatMap((p) => [p.a, p.b])];

describe('IMPL-063 — fixture reproduz o regime medido pela sonda N1', () => {
  it('paráfrases verdadeiras têm ROUGE-L baixo (≈0,00 e ≈0,12) e pares por entidade alto (0,88–0,91)', () => {
    const rougePar = PARAFRASES.map((p) => rougeL(p.a.question, p.b.question));
    const rougeEnt = ENTIDADES.map((p) => rougeL(p.a.question, p.b.question));
    // As paráfrases escapam do léxico (o que fazia o ROUGE-L perdê-las)…
    expect(Math.min(...rougePar)).toBeCloseTo(0, 1);
    expect(Math.max(...rougePar)).toBeLessThan(0.15);
    expect(rougePar.some((r) => r >= 0.1 && r <= 0.15)).toBe(true);
    // …e os pares por entidade têm sobreposição léxica ALTA (o que fazia o
    // ROUGE-L ≥ 0,7 colapsá-los).
    expect(Math.min(...rougeEnt)).toBeGreaterThan(0.85);
    expect(Math.max(...rougeEnt)).toBeLessThan(0.95);
    // Conflito de entidade é reconhecido em todos os pares por entidade…
    for (const p of ENTIDADES) expect(entityConflict(p.a.question, p.b.question)).toBe(true);
    // …e NUNCA nas paráfrases (mesmo cenário, mesmas entidades).
    for (const p of PARAFRASES) expect(entityConflict(p.a.question, p.b.question)).toBe(false);
  });
});

describe('IMPL-063 — decisões do dedup semântico', () => {
  it('0 falsos positivos: nenhum par que difere só por entidade colapsa (mesmo com cosseno alto)', async () => {
    const itens = ENTIDADES.flatMap((p) => [p.a, p.b]);
    const res = await dedupeSemantic(itens, { embed: embedFixture });
    expect(res.kept).toHaveLength(itens.length);
    expect(res.dropped).toHaveLength(0);
    for (const p of ENTIDADES) {
      expect(res.kept).toContain(p.a);
      expect(res.kept).toContain(p.b);
    }
  });

  it('recall ≥ 0,9 em paráfrases verdadeiras (o léxico puro deixava todas passar)', async () => {
    const res = await dedupeSemantic(PARAFRASES.flatMap((p) => [p.a, p.b]), { embed: embedFixture });
    // Cada par fundido derruba exatamente 1 dos 2 itens.
    const fundidos = PARAFRASES.filter((p) => res.dropped.includes(p.a) !== res.dropped.includes(p.b)).length;
    expect(fundidos / PARAFRASES.length).toBeGreaterThanOrEqual(0.9);
    expect(res.kept.length).toBeLessThanOrEqual(PARAFRASES.length);
    expect(res.method).toBe('semantic');
  });

  it('completo (paráfrases + entidades): paráfrases fundem, entidades sobrevivem', async () => {
    const res = await dedupeSemantic(todos(), { embed: embedFixture });
    const entidadesVivas = ENTIDADES.every((p) => res.kept.includes(p.a) && res.kept.includes(p.b));
    expect(entidadesVivas).toBe(true);
    expect(res.dropped.length).toBeGreaterThanOrEqual(Math.floor(PARAFRASES.length * 0.9));
  });

  it('limiar default documentado e calibrável por config', async () => {
    expect(DEFAULT_COSINE_THRESHOLD).toBe(0.9);
    expect(DEFAULT_ECHO_THRESHOLD).toBeGreaterThan(0.7);
    // Mais estrito que o default: as paráfrases (≈0,93) deixam de fundir.
    const estrito = await dedupeSemantic(PARAFRASES.flatMap((p) => [p.a, p.b]), {
      embed: embedFixture,
      cosineThreshold: 0.99,
    });
    expect(estrito.dropped).toHaveLength(0);
    // Mais frouxo: fundem ainda mais (e as entidades continuam protegidas).
    const frouxo = await dedupeSemantic(todos(), { embed: embedFixture, cosineThreshold: 0.5 });
    for (const p of ENTIDADES) {
      expect(frouxo.kept).toContain(p.a);
      expect(frouxo.kept).toContain(p.b);
    }
    expect(frouxo.dropped.length).toBeGreaterThan(0);
  });

  it('sem embedder a camada semântica fica desligada: só a exata age (sem erro)', async () => {
    const res = await dedupeSemantic(PARAFRASES.flatMap((p) => [p.a, p.b]));
    expect(res.dropped).toHaveLength(0);
    expect(res.method).toBe('none');
  });

  it('a passe exata compara o PAR (pergunta + contexto), não só a pergunta', async () => {
    const base = { question: 'Qual o prazo de troca?', productContext: 'Política A: 30 dias.' };
    const outroCtx = { question: 'Qual o prazo de troca?', productContext: 'Política B: 7 dias.' };
    const igual = { ...base };
    // Mesma pergunta com contexto DIFERENTE = cenário diferente (resposta
    // diferente) — antes colapsava porque a chave era só a pergunta.
    const res = await dedupeSemantic([base, outroCtx, igual], { embed: embedFixture });
    expect(res.kept).toHaveLength(2);
    expect(res.kept).toContain(base);
    expect(res.kept).toContain(outroCtx);
    expect(res.dropped).toHaveLength(1);
    expect(res.report.exactDropped).toBe(1);
    expect(res.method).toBe('exact');
  });

  it('eco de template é RELATADO e nunca descartado (checagem auxiliar só-pergunta)', async () => {
    const res = await dedupeSemantic(ENTIDADES.flatMap((p) => [p.a, p.b]), { embed: embedFixture });
    // As perguntas dos pares por entidade são quase idênticas (0,88–0,91 de
    // ROUGE-L ≥ limiar de eco): a assinatura de template reaproveitado entra no
    // relatório, mas os itens permanecem.
    expect(res.report.templateEcho).toBeGreaterThanOrEqual(ENTIDADES.length);
    expect(res.kept).toHaveLength(ENTIDADES.length * 2);
    expect(res.dropped).toHaveLength(0);
    // Só-pergunta: as entidades salientes são as dos números/nomes próprios.
    expect(salientTokens('Qual o prazo de troca do Fone Aurora com nota fiscal?')).toContain('aurora');
    expect(salientTokens('Qual o prazo de troca do Fone Aurora com nota fiscal?')).not.toContain('qual');
  });
});

describe('IMPL-063 — relatório de duplicatas removidas por run (taxa + alerta > 20%)', () => {
  it('reporta contagem, taxa e dispara alerta acima de 20%', async () => {
    // 5 cenários únicos + 5 cópias exatas = 50% de descarte.
    const unicos = PARAFRASES.slice(0, 5).map((p) => p.a);
    const copias = unicos.map((c) => ({ ...c }));
    const res = await dedupeSemantic([...unicos, ...copias], { embed: embedFixture });
    const r: DedupeReport = res.report;
    expect(r.total).toBe(10);
    expect(r.kept).toBe(5);
    expect(r.dropped).toBe(5);
    expect(r.exactDropped).toBe(5);
    expect(r.rate).toBeCloseTo(0.5);
    expect(r.alertRate).toBe(DEDUP_ALERT_RATE);
    expect(DEDUP_ALERT_RATE).toBe(0.2);
    expect(r.alert).toBe(true);
  });

  it('abaixo de 20% não dispara alerta; combineDedupeReports soma os lotes', async () => {
    const unicos = PARAFRASES.slice(0, 9).map((p) => p.a);
    const res = await dedupeSemantic([...unicos, { ...unicos[0] }], { embed: embedFixture });
    expect(res.report.rate).toBeLessThanOrEqual(0.2);
    expect(res.report.alert).toBe(false);

    const soma = combineDedupeReports(res.report, res.report);
    expect(soma.total).toBe(res.report.total * 2);
    expect(soma.dropped).toBe(res.report.dropped * 2);
    expect(soma.rate).toBeCloseTo(res.report.rate);
  });

  it('dedupeAdvanced (síncrono) também reporta — nada de resultado descartado em silêncio', () => {
    const unicos = PARAFRASES.slice(0, 4).map((p) => p.a);
    const res = dedupeAdvanced([...unicos, { ...unicos[0] }, { ...unicos[1] }]);
    expect(res.kept).toHaveLength(4);
    expect(res.report.total).toBe(6);
    expect(res.report.exactDropped).toBe(2);
  });
});

describe('IMPL-063 — fonte única (web re-exporta; engine-sync verde)', () => {
  it('o shim do web é o MESMO módulo de src/', () => {
    expect(dedupWeb.dedupeSemantic).toBe(dedupeSemantic);
    expect(dedupWeb.dedupeAdvanced).toBe(dedupeAdvanced);
    expect(dedupWeb.rougeL).toBe(rougeL);
    expect(dedupWeb.cosine).toBe(cosine);
    expect(dedupWeb.DEFAULT_COSINE_THRESHOLD).toBe(DEFAULT_COSINE_THRESHOLD);
  });

  it('cosene entre vetores: 1 para iguais, 0 para ortogonais', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([], [1])).toBe(0);
  });
});
