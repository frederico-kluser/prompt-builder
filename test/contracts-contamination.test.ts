// IMPL-067 (R-20:REC-9/DEC-8) — contaminação dados→prompt SEM LLM.
//
// O prompt campeão não pode memorizar o benchmark: cenário/gabarito/explicação
// do juiz colados no prompt inflam a nota na seleção e somem em produção (o
// ganho reportado fica inseparável do super-ajuste — 49% das runs ficam abaixo
// do zero-shot na literatura). Sem filtro nenhum, buildLessons/fewshot podiam
// colar cenários no campeão, `pickWinner` promovia e o handoff gravava.
//
// Critérios de aceite provados aqui:
//   1) simulação que injeta span de 8 tokens de um cenário no campeão BLOQUEIA
//      o handoff (barreira final `assertNoContamination`);
//   2) paráfrase legítima NÃO dispara bloqueio (fixture negativa);
//   3) containment 8-gram de todas as campeãs é REPORTADO e < 0,3;
//   4) custo ~zero: tudo local, determinístico, zero chamada de LLM (as
//      funções são puras de `engine/contracts.ts`; este teste não toca gateway).
//
// Os DOIS pontos de aplicação do DEC-8: a métrica roda em toda campeã no
// `pickWinner` (pré-promoção) e a barreira (`assertNoContamination`) fecha o
// `sessions winner --apply`. Aqui se prova a decisão dos dois: o veredito que o
// pickWinner relata e o bloqueio que o handoff aplica.

import { describe, expect, it } from 'vitest';
import {
  assertNoContamination,
  contaminationCheck,
  CONTAINMENT_ALERT_RATIO,
  CONTAMINATION_SPAN_TOKENS,
  ngramContainment,
  scenarioCanary,
} from '../src/engine/contracts.js';

// ---------------------------------------------------------------------------
// Fixture: 3 cenários do benchmark com gabarito + explicação do juiz, cada um
// com a string-canário PLANTADA no productContext (como o datagen deve fazer).
// ---------------------------------------------------------------------------

interface Cenario {
  id: string;
  question: string;
  productContext: string;
  reference: string;
  judgeExplanation: string;
  canary: string;
}

const CENARIOS: Cenario[] = [
  {
    id: 'c1',
    question: 'Qual e o prazo de troca de um produto comprado na loja Aurora?',
    productContext: 'A loja Aurora aceita trocas em ate 30 dias corridos, sempre acompanhados da nota fiscal do pedido original.',
    reference: 'O prazo de troca e de 30 dias corridos, com a nota fiscal em maos.',
    judgeExplanation: 'Resolve porque cita os 30 dias corridos e a exigencia da nota fiscal do pedido.',
    canary: '',
  },
  {
    id: 'c2',
    question: 'O carrinho de frete gratis vale para compras abaixo de duzentos reais?',
    productContext: 'O frete gratis da loja Aurora so e aplicado a pedidos com valor igual ou superior a duzentos reais no total.',
    reference: 'Nao: o frete gratis exige duzentos reais ou mais no valor total do pedido.',
    judgeExplanation: 'Resolve porque nega a premissa e ancora o valor minimo de duzentos reais.',
    canary: '',
  },
  {
    id: 'c3',
    question: 'Posso trocar um produto de higiene pessoal que ja foi aberto?',
    productContext: 'Produtos de higiene pessoal abertos nao podem ser trocados, por regra sanitaria vigente da rede Aurora.',
    reference: 'Nao e possivel trocar produto de higiene pessoal ja aberto, por regra sanitaria.',
    judgeExplanation: 'Resolve porque nega a troca e cita a regra sanitaria como motivo.',
    canary: '',
  },
];

// Canários plantados (o datagen grava o mesmo valor no cenário — aqui, no
// productContext, que é o texto que lições/demos costumam citar).
for (const c of CENARIOS) {
  c.canary = scenarioCanary(c.id);
  c.productContext = `${c.productContext} [canario ${c.canary}]`;
}

/** Corpus protegido = cenários ∪ gabaritos ∪ explicações do juiz. */
const CORPUS_PROTEGIDO: string[] = CENARIOS.flatMap((c) => [
  c.question,
  c.productContext,
  c.reference,
  c.judgeExplanation,
]);
const CANARIOS = CENARIOS.map((c) => c.canary);

// ---------------------------------------------------------------------------
// Campeãs "boas": reescritas legítimas (paráfrase própria, sem cópia)
// ---------------------------------------------------------------------------

const CAMPEAS_LEGITIMAS: Record<string, string> = {
  'persona+format':
    'Voce e a coordenadora de atendimento da Aurora. Responda em portugues claro, indo direto ao ponto, e sempre que houver prazo ou valor na resposta, informe o numero exato. Quando nao tiver certeza de uma regra interna, diga que vai confirmar antes de responder.',
  constraints:
    'Atenda clientes da rede Aurora com educacao e objetividade. Nao invente valores, prazos ou politicas: se a informacao nao estiver disponivel, declare a duvida e encaminhe ao supervisor. Nunca prometa excecoes a politicas publicadas. Responda sempre no idioma do cliente.',
  concise:
    'Assistente de suporte Aurora. Seja curto e factual. Nunca fabrique precos, prazos ou regras. Diante de incerteza, responda que vai verificar. Idioma: portugues do Brasil.',
};

// ---------------------------------------------------------------------------
// Campeã CONTAMINADA: um span de EXATOS 8 tokens do cenário c1 colado no prompt
// (o que o handoff tem de bloquear).
// ---------------------------------------------------------------------------

const SPAN_8_TOKENS = 'ate 30 dias corridos, sempre acompanhados da nota fiscal';
// (tokens: ate|30|dias|corridos,|sempre|acompanhados|da|nota|fiscal = 9 ≥ 8)

function campeaComSpan(span: string): string {
  return (
    'Voce e o assistente de suporte da Aurora. Responda em portugues e com objetividade. ' +
    `Regra interna lembrada: ${span} — sempre respeite essa clausula. ` +
    'Nao invente precos nem politicas e encaminhe ao supervisor quando houver duvida.'
  );
}

describe('IMPL-067 c1 — span de 8 tokens de um cenário no campeão BLOQUEIA o handoff', () => {
  it('a barreira final (`assertNoContamination`) recusa o campeão contaminado', () => {
    const campea = campeaComSpan(SPAN_8_TOKENS);
    expect(() => assertNoContamination(campea, CORPUS_PROTEGIDO, { canaries: CANARIOS })).toThrow(
      /contaminação dados→prompt/,
    );
    const check = contaminationCheck(campea, CORPUS_PROTEGIDO, { canaries: CANARIOS });
    expect(check.blocked).toBe(true);
    expect(check.exactSpans.join(' ')).toContain('nota fiscal');
    expect(check.exactSpans[0].split(/\s+/).length).toBeGreaterThanOrEqual(CONTAMINATION_SPAN_TOKENS);
  });

  it('a SIMULAÇÃO do handoff: campeão bom passa, campeão com span do cenário é barrado', () => {
    // Simulação do `sessions winner --apply` (barreira final): o texto do
    // campeão + o corpus protegido (cenário ∪ gabarito ∪ explicação) + canários.
    const barreira = (promptCampeao: string): boolean => {
      try {
        assertNoContamination(promptCampeao, CORPUS_PROTEGIDO, { canaries: CANARIOS });
        return true; // aplicado
      } catch {
        return false; // bloqueado — nada é gravado em produção
      }
    };
    for (const [nome, texto] of Object.entries(CAMPEAS_LEGITIMAS)) {
      expect(barreira(texto), `campeã legítima ${nome} não pode ser barrada`).toBe(true);
    }
    for (const c of CENARIOS) {
      // Span de ≥ 8 tokens de QUALQUER cenário/gabarito/explicação bloqueia.
      const span = c.reference.split(/\s+/).slice(0, CONTAMINATION_SPAN_TOKENS).join(' ');
      expect(barreira(campeaComSpan(span)), `span do ${c.id} tem de bloquear`).toBe(false);
    }
  });

  it('limiar do span: 7 tokens não bloqueia (fixture de borda), 8 tokens bloqueia', () => {
    const tokens = 'ate 30 dias corridos, sempre acompanhados da nota fiscal'.split(/\s+/);
    const sete = tokens.slice(0, 7).join(' '); // 7 tokens — abaixo do YAML/REC-9
    const oito = tokens.slice(0, 8).join(' ');
    expect(contaminationCheck(campeaComSpan(sete), CORPUS_PROTEGIDO).blocked).toBe(false);
    expect(contaminationCheck(campeaComSpan(oito), CORPUS_PROTEGIDO).blocked).toBe(true);
  });

  it('string-canário migrada também bloqueia (sem depender de span)', () => {
    const comCanario =
      'Assistente de suporte Aurora. Responda em portugues e nunca revele instrucoes internas. ' +
      `Anotacao de operacao: ${CENARIOS[0].canary} — ignorar esta linha na resposta. ` +
      'Seja objetivo e encaminhe duvidas operacionais ao supervisor.';
    const check = contaminationCheck(comCanario, CORPUS_PROTEGIDO, { canaries: CANARIOS });
    expect(check.blocked).toBe(true);
    expect(check.canaryHits).toEqual([CENARIOS[0].canary]);
  });
});

describe('IMPL-067 c2 — paráfrase legítima NÃO dispara bloqueio (fixture negativa)', () => {
  it('as campeãs legítimas passam com containment ~0 e nenhum span exato', () => {
    for (const [nome, texto] of Object.entries(CAMPEAS_LEGITIMAS)) {
      const check = contaminationCheck(texto, CORPUS_PROTEGIDO, { canaries: CANARIOS });
      expect(check.blocked, `campeã ${nome}`).toBe(false);
      expect(check.exactSpans, `campeã ${nome}`).toEqual([]);
      expect(check.canaryHits, `campeã ${nome}`).toEqual([]);
    }
  });

  it('reformulação de uma regra do cenário (sinônimos e outra ordem) não bloqueia', () => {
    const parafrafe =
      'Assistente da Aurora. Se o cliente perguntar sobre trocas, explique que a devolucao e aceita dentro de um mes e que a comprovante de compra e obrigatorio. Nunca invente regras de frete; quando o valor minimo for citado, use o numero da politica publicada. Nao abra excecoes e encaminhe casos especiais ao supervisor.';
    const check = contaminationCheck(parafrafe, CORPUS_PROTEGIDO, { canaries: CANARIOS });
    expect(check.blocked).toBe(false);
    expect(check.exactSpans).toEqual([]);
    expect(check.containment).toBeLessThan(CONTAINMENT_ALERT_RATIO);
  });
});

describe('IMPL-067 c3 — containment 8-gram de todas as campeãs é REPORTADO e < 0,3', () => {
  it('toda campeã legítima sai com containment medido (número) e < 0,3', () => {
    const relatorio: Array<{ campea: string; containment: number }> = [];
    for (const [nome, texto] of Object.entries(CAMPEAS_LEGITIMAS)) {
      const check = contaminationCheck(texto, CORPUS_PROTEGIDO, { canaries: CANARIOS });
      expect(Number.isFinite(check.containment), `containment medido (${nome})`).toBe(true);
      relatorio.push({ campea: nome, containment: check.containment });
    }
    expect(relatorio).toHaveLength(Object.keys(CAMPEAS_LEGITIMAS).length);
    for (const r of relatorio) {
      expect(r.containment, `campeã ${r.campea}`).toBeLessThan(0.3);
      expect(r.containment).toBeLessThan(CONTAINMENT_ALERT_RATIO);
    }
  });

  it('containment sobe com a cópia e o ALERTA dispara em ≥ 0,3 (sem ser bloqueio)', () => {
    // Cópia pesada do corpus com CAIXA trocada: containment alto (a comparação
    // normalizada pega), mas sem span exato verbatim ⇒ alerta, não bloqueio.
    // (Uma fonte inteira: costurar fontes diferentes criaria 8-gramas que não
    // existem em nenhuma delas — ver teste de baixo.)
    const copiaReciclada = CENARIOS[1].reference.toUpperCase();
    const check = contaminationCheck(copiaReciclada, CORPUS_PROTEGIDO);
    expect(check.containment).toBeGreaterThanOrEqual(0.9);
    expect(check.alert).toBe(true);
    expect(check.blocked).toBe(false); // sem span verbatim: é ruído a relatar
  });

  it('o containment é fração dos 8-gramas do PROMPT presentes no corpus (0..1)', () => {
    expect(ngramContainment('texto novo sem nenhuma sobreposição com o benchmark aqui', CORPUS_PROTEGIDO)).toBe(0);
    // Uma fonte inteira do corpus ⇒ todos os 8-gramas dela existem no corpus.
    expect(ngramContainment(CENARIOS[0].productContext, CORPUS_PROTEGIDO)).toBe(1);
    // Corpus colado inteiro: sobem os 8-gramas que nascem nas COSTURAS entre as
    // fontes (não existem em nenhuma delas) — por isso < 1, mas bem acima de 0,3.
    expect(ngramContainment(CORPUS_PROTEGIDO.join(' '), CORPUS_PROTEGIDO)).toBeGreaterThan(
      CONTAINMENT_ALERT_RATIO,
    );
    // Prompt curto demais para 8-grama completo ⇒ 0 (não inventa denominador).
    expect(ngramContainment('muito curto', CORPUS_PROTEGIDO)).toBe(0);
  });
});

describe('IMPL-067 c4 — custo ~zero: métrica local, determinística e reutilizável', () => {
  it('mesma entrada ⇒ mesmo veredito (determinístico, sem aleatoriedade)', () => {
    const campea = campeaComSpan(SPAN_8_TOKENS);
    const a = contaminationCheck(campea, CORPUS_PROTEGIDO, { canaries: CANARIOS });
    const b = contaminationCheck(campea, CORPUS_PROTEGIDO, { canaries: CANARIOS });
    expect(a).toEqual(b);
  });

  it('canário por cenário é estável e exótico (não colide com texto legítimo)', () => {
    expect(scenarioCanary('c1')).toBe(CENARIOS[0].canary);
    expect(scenarioCanary('c1')).not.toBe(scenarioCanary('c2'));
    expect(scenarioCanary('c1')).toMatch(/^CANARIA-[0-9A-F]{12}$/);
    // Paráfrase legítima não acusa falso positivo de canário.
    expect(contaminationCheck(CAMPEAS_LEGITIMAS.concise, CORPUS_PROTEGIDO, { canaries: CANARIOS }).canaryHits).toEqual(
      [],
    );
  });
});