/**
 * IMPL-003 — corpus HOLDOUT do verificador estrito.
 *
 * Variações naturais das famílias adversariais (negação, hesitação,
 * autocorreção, multi-rótulo, JSON) e positivos legítimos escritos FORA do
 * corpus de desenvolvimento (`groundtruth.test.ts`): as listas `REVISAO_*` vêm
 * verbatim das sondas da revisão independente 2; as `FRESCAS_*` foram escritas
 * na correção da revisão 2 e só rodadas DEPOIS do código pronto. Não ajuste o
 * verificador olhando este arquivo caso a caso — se uma variação nova falhar,
 * ela entra aqui e a correção tem de valer para a família inteira.
 */
import { describe, expect, it } from 'vitest';
import { matchExpected } from '../src/engine/groundTruth.js';

const SENT = ['positivo', 'negativo', 'neutro'];
const SIMNAO = ['sim', 'nao'];
const URG = ['urgente', 'normal'];
const EN = ['positive', 'negative', 'neutral'];
const YN = ['yes', 'no'];
const INTENT = ['edit', 'create', 'delete', 'help'];
type C = [texto: string, expected: string, labelSet: string[]];

/** Sondas adversariais da revisão 2 (139): nenhuma pode dar 'resolve'. */
const REVISAO_ADVERSARIAIS: C[] = [
  ['Negativo não.', 'negativo', SENT],
  ['Negativo? Não!', 'negativo', SENT],
  ['Não negativo', 'negativo', SENT],
  ['Não é negativo', 'negativo', SENT],
  ['Negativo não', 'negativo', SENT],
  ['Negativo\nnão', 'negativo', SENT],
  ['negativo\n\nBrincadeira, é positivo.', 'negativo', SENT],
  ['negativo\nerrei: positivo', 'negativo', SENT],
  ['negativo\nCorrigindo: positivo', 'negativo', SENT],
  ['negativo\nResposta final: positivo', 'negativo', SENT],
  ['negativo\nResposta: positivo', 'negativo', SENT],
  ['negativo\nLabel: positivo', 'negativo', SENT],
  ['negativo\nSentimento: positivo', 'negativo', SENT],
  ['Negativo\n\nPositivo', 'negativo', SENT],
  ['Negativo\n**Positivo**', 'negativo', SENT],
  ['Negativo / Positivo', 'negativo', SENT],
  ['Negativo & positivo', 'negativo', SENT],
  ['Negativo + positivo', 'negativo', SENT],
  ['Negativo e positivo', 'negativo', SENT],
  ['Negativo e neutro', 'negativo', SENT],
  ['Negativo, e também neutro', 'negativo', SENT],
  ['Negativo vs positivo', 'negativo', SENT],
  ['Negativo x positivo', 'negativo', SENT],
  ['Negativo -> positivo', 'negativo', SENT],
  ['Negativo → positivo', 'negativo', SENT],
  ['negativo (50%), positivo (50%)', 'negativo', SENT],
  ['Negativo: 50%. Positivo: 50%.', 'negativo', SENT],
  ['Negativo 60% / neutro 40%', 'negativo', SENT],
  ['Negativo (baixa confiança)', 'negativo', SENT],
  ['Negativo (confiança: 30%)', 'negativo', SENT],
  ['Negativo, mas com dúvidas.', 'negativo', SENT],
  ['Negativo, embora eu esteja em dúvida.', 'negativo', SENT],
  ['Negativo. Mas estou em dúvida.', 'negativo', SENT],
  ['Negativo. Pouca certeza.', 'negativo', SENT],
  ['Negativo (incerto)', 'negativo', SENT],
  ['Negativo (?)', 'negativo', SENT],
  ['Negativo (talvez)', 'negativo', SENT],
  ['Negativo(?)', 'negativo', SENT],
  ['Negativo?!', 'negativo', SENT],
  ['Negativo??', 'negativo', SENT],
  ['Negativo ?', 'negativo', SENT],
  ['negativo ¿', 'negativo', SENT],
  ['Negativo… acho.', 'negativo', SENT],
  ['Negativo, suponho.', 'negativo', SENT],
  ['Negativo, imagino.', 'negativo', SENT],
  ['Negativo, se não me engano.', 'negativo', SENT],
  ['Negativo, eu acho.', 'negativo', SENT],
  ['Negativo, I guess', 'negativo', SENT],
  ['Negative, I guess.', 'negative', EN],
  ['Negative, probably.', 'negative', EN],
  ['Negative? Not sure.', 'negative', EN],
  ['Negative. Or neutral.', 'negative', EN],
  ['Negative. Wait, neutral.', 'negative', EN],
  ['Negative — no, neutral.', 'negative', EN],
  ['Negativo — não, neutro.', 'negativo', SENT],
  ['Negativo. Não: neutro.', 'negativo', SENT],
  ['Negativo. Errado, é neutro.', 'negativo', SENT],
  ['Negativo. Corrijo: neutro.', 'negativo', SENT],
  ['Negativo, quer dizer, neutro', 'negativo', SENT],
  ['Negativo… não, neutro.', 'negativo', SENT],
  ['negativo\n\nPS: talvez neutro', 'negativo', SENT],
  ['negativo\nObs.: pode ser neutro', 'negativo', SENT],
  ['negativo\n(ou neutro)', 'negativo', SENT],
  ['negativo\nneutro', 'negativo', SENT],
  ['negativo\n- neutro', 'negativo', SENT],
  ['negativo\n2. neutro', 'negativo', SENT],
  ['1. negativo\n2. positivo', 'negativo', SENT],
  ['Opção A: negativo\nOpção B: positivo', 'negativo', SENT],
  ['Sim/Não', 'sim', SIMNAO],
  ['Sim ou não', 'sim', SIMNAO],
  ['Sim e não.', 'sim', SIMNAO],
  ['Sim. Quer dizer, não.', 'sim', SIMNAO],
  ['Sim... não.', 'sim', SIMNAO],
  ['Sim — ou não.', 'sim', SIMNAO],
  ['Sim, talvez.', 'sim', SIMNAO],
  ['Sim? Não.', 'sim', SIMNAO],
  ['Sim\nNão', 'sim', SIMNAO],
  ['Não sei se sim.', 'sim', SIMNAO],
  ['Não, sim.', 'sim', SIMNAO],
  ['Urgente (não)', 'urgente', URG],
  ['Urgente: nope', 'urgente', URG],
  ['Urgente? Nem tanto.', 'urgente', URG],
  ['Urgente, nem tanto.', 'urgente', URG],
  ['Urgente... só que não.', 'urgente', URG],
  ['Urgente. Só que não.', 'urgente', URG],
  ['Urgente, só que não', 'urgente', URG],
  ['Urgente — mentira, normal.', 'urgente', URG],
  ['Urgente. Brincadeira: normal.', 'urgente', URG],
  ['{"label": "negativo"}\n\nPositivo', 'negativo', SENT],
  ['{"label": "negativo", "alternativa": "neutro"}', 'negativo', SENT],
  ['{"label": "negativo", "confidence": 0.1}', 'negativo', SENT],
  ['{"label": "negativo", "certeza": "baixa"}', 'negativo', SENT],
  ['{"label": "negativo", "labels": ["negativo","positivo"]}', 'negativo', SENT],
  ['{"label": ["negativo","positivo"]}', 'negativo', SENT],
  ['{"label": "negativo ou positivo"}', 'negativo', SENT],
  ['{"label": "não negativo"}', 'negativo', SENT],
  ['{"label": "talvez negativo"}', 'negativo', SENT],
  ['{"label": "negativo?"}', 'negativo', SENT],
  ['{"resposta": "negativo", "sentimento": "positivo"}', 'negativo', SENT],
  ['{"sentiment": "negativo", "sentiment_alt": "positivo"}', 'negativo', SENT],
  ['{"label": "negativo"} {"label": "negativo"} {"label":"positivo"}', 'negativo', SENT],
  ['[{"label": "negativo"}, {"label": "positivo"}]', 'negativo', SENT],
  ['{"results": [{"label": "negativo"}, {"label": "positivo"}]}', 'negativo', SENT],
  ['{"a": {"b": {"label": "positivo"}}, "label": "negativo"}', 'negativo', SENT],
  ['{"label": "negativo", "nota": "na verdade é positivo"}', 'negativo', SENT],
  ['{"label": "negativo", "explicacao": "talvez seja positivo"}', 'negativo', SENT],
  ['```json\n{"label": "negativo"}\n```\nOu positivo.', 'negativo', SENT],
  ['"negativo" ou "positivo"', 'negativo', SENT],
  ['`negativo` | `positivo`', 'negativo', SENT],
  ['negativo|positivo', 'negativo', SENT],
  ['negativo;positivo', 'negativo', SENT],
  ['negativo positivo neutro', 'negativo', SENT],
  ['negativo positivo', 'negativo', SENT],
  ['Resposta: negativo ou positivo', 'negativo', SENT],
  ['Resposta: não negativo', 'negativo', SENT],
  ['Resposta: talvez negativo', 'negativo', SENT],
  ['Label: negative?', 'negative', EN],
  ['Not negative', 'negative', EN],
  ['NOT negative.', 'negative', EN],
  ['Negative: no', 'negative', EN],
  ['Negative - no.', 'negative', EN],
  ['Negative, no.', 'negative', EN],
  ['Negative? No.', 'negative', EN],
  ['Negative; no.', 'negative', EN],
  ['Negative. No.', 'negative', EN],
  ['Negative. Nope.', 'negative', EN],
  ['edit, create', 'edit', INTENT],
  ['edit & create', 'edit', INTENT],
  ['edit or create', 'edit', INTENT],
  ['edit (or create)', 'edit', INTENT],
  ['edit + create', 'edit', INTENT],
  ['edit\ncreate', 'edit', INTENT],
  ['edit; create', 'edit', INTENT],
  ['edit. create.', 'edit', INTENT],
  ['edit. Create too.', 'edit', INTENT],
  ['edit — though maybe help', 'edit', INTENT],
  ['edit, maybe', 'edit', INTENT],
  ['edit, perhaps help', 'edit', INTENT],
  ['edit (50%) / help (50%)', 'edit', INTENT],
];

/** Adversariais frescas (revisão 3). */
const FRESCAS_ADVERSARIAIS: C[] = [
  ['Negativo. Mas não tenho tanta certeza assim.', 'negativo', SENT],
  ['Negativo, acho eu.', 'negativo', SENT],
  ['Negativo (chute).', 'negativo', SENT],
  ['Negativo. É o que parece.', 'negativo', SENT],
  ['Negativo. Não descarto positivo.', 'negativo', SENT],
  ['Negativo\nNão descarto neutro.', 'negativo', SENT],
  ['Negativo. Ou quase isso.', 'negativo', SENT],
  ['Negativo. Hmm, positivo.', 'negativo', SENT],
  ['Negativo. Opa, positivo.', 'negativo', SENT],
  ['Negativo. Ops: positivo.', 'negativo', SENT],
  ['Negativo. Retiro o que disse: positivo.', 'negativo', SENT],
  ['Negativo. Me enganei, é neutro.', 'negativo', SENT],
  ['Negativo 70%, neutro 30%', 'negativo', SENT],
  ['Negativo (70%) — neutro (30%)', 'negativo', SENT],
  ['Negativo: 0.6, Neutro: 0.4', 'negativo', SENT],
  ['negativo\nneutro\npositivo', 'negativo', SENT],
  ['Negativo\nPositivo também.', 'negativo', SENT],
  ['Negativo\nMas também positivo.', 'negativo', SENT],
  ['Negativo. Talvez neutro.', 'negativo', SENT],
  ['Negativo. Quiçá neutro.', 'negativo', SENT],
  ['Negative. Or maybe neutral.', 'negative', EN],
  ['Negative. Actually, neutral.', 'negative', EN],
  ['Negative. Scratch that, neutral.', 'negative', EN],
  ['Negative. Just kidding, positive.', 'negative', EN],
  ['Negative (not sure).', 'negative', EN],
  ['Negative, I think.', 'negative', EN],
  ['Negative. Hard to say.', 'negative', EN],
  ['Yes. No.', 'yes', YN],
  ['Yes, or no.', 'yes', YN],
  ['Yes\nNo', 'yes', YN],
  ['Yes. Actually no.', 'yes', YN],
  ['Sim. Aliás, não.', 'sim', SIMNAO],
  ['Sim. Pensando melhor, não.', 'sim', SIMNAO],
  ['Sim, não sei.', 'sim', SIMNAO],
  ['Urgente. Ou normal.', 'urgente', URG],
  ['Urgente/normal', 'urgente', URG],
  ['Urgente. Na dúvida, normal.', 'urgente', URG],
  ['edit/help', 'edit', INTENT],
  ['edit. Or help.', 'edit', INTENT],
  ['edit. Actually help.', 'edit', INTENT],
  ['{"label":"negativo","alt":["neutro"]}', 'negativo', SENT],
  ['{"label":"negativo","obs":"ou talvez neutro"}', 'negativo', SENT],
  ['{"label":"negativo","confidence":"20%"}', 'negativo', SENT],
  ['{"label":"negativo?!"}', 'negativo', SENT],
  ['{"x":[{"y":{"label":"positivo"}}],"label":"negativo"}', 'negativo', SENT],
];

/** Positivos legítimos da revisão 2 (amostra independente). */
const REVISAO_LEGITIMOS: C[] = [
  ['Negativo.\n\nJustificativa: o cliente reclama do atraso e não há nada positivo.', 'negativo', SENT],
  ['Negativo\n\nJustificativa: o cliente reclama; não é neutro nem positivo.', 'negativo', SENT],
  ['**Classificação:** Negativo', 'negativo', SENT],
  ['**Sentimento**: negativo', 'negativo', SENT],
  ['Sentimento: **negativo**', 'negativo', SENT],
  ['### Classificação\nNegativo', 'negativo', SENT],
  ['Classificação final: negativo', 'negativo', SENT],
  ['Resposta final: negativo', 'negativo', SENT],
  ['A classificação é: negativo', 'negativo', SENT],
  ['negativo.', 'negativo', SENT],
  ['  negativo  ', 'negativo', SENT],
  ["'negativo'", 'negativo', SENT],
  ['«negativo»', 'negativo', SENT],
  ['{"sentiment":"negativo","confidence":0.92}', 'negativo', SENT],
  ['{"label":"negativo","confianca":"alta"}', 'negativo', SENT],
  ['{"label":"negativo","explicacao":"O cliente está irritado, não é positivo."}', 'negativo', SENT],
  ['{"label":"negativo","reason":"The customer is angry; not positive at all."}', 'negativo', SENT],
  ['{"classificacao":"negativo","justificativa":"Embora comece neutro, termina com reclamação."}', 'negativo', SENT],
  ['{\n  "label": "negativo",\n  "motivo": "atraso na entrega"\n}', 'negativo', SENT],
  ['```\nnegativo\n```', 'negativo', SENT],
  ['```json\n{"label":"negativo"}\n```\nO cliente reclama do atraso.', 'negativo', SENT],
  ['Aqui está a classificação:\n\n```json\n{"label": "negativo", "motivo": "reclamação"}\n```', 'negativo', SENT],
  ['Negativo — o cliente não gostou do produto.', 'negativo', SENT],
  ['Negativo: cliente insatisfeito com o atraso.', 'negativo', SENT],
  ['Negativo. Não há elogio algum.', 'negativo', SENT],
  ['Negativo. O cliente não recomendaria a loja.', 'negativo', SENT],
  ['Negativo, pois o cliente não recebeu o pedido.', 'negativo', SENT],
  ['Negativo, porque não houve resposta do suporte.', 'negativo', SENT],
  ['Negativo\n\nO cliente não está satisfeito.', 'negativo', SENT],
  ['Negativo\n\nNão é neutro, porque há queixa explícita.', 'negativo', SENT],
  ['Negativo\n\nNão há como classificar como positivo.', 'negativo', SENT],
  ['Negativo\n\nPode parecer neutro, mas há ironia.', 'negativo', SENT],
  ['Negativo\n\nTalvez o cliente volte, mas o tom é negativo.', 'negativo', SENT],
  ['Negativo\n\nO cliente provavelmente vai cancelar.', 'negativo', SENT],
  ['Sim\n\nO cliente pode pedir reembolso, pois não passou o prazo.', 'sim', SIMNAO],
  ['Sim. O prazo não expirou.', 'sim', SIMNAO],
  ['Sim, ele tem direito — não há exceção aplicável.', 'sim', SIMNAO],
  ['Não. O prazo expirou há 3 dias.', 'nao', SIMNAO],
  ['Não, pois o prazo expirou.', 'nao', SIMNAO],
  ['NÃO', 'nao', SIMNAO],
  ['Não!', 'nao', SIMNAO],
  ['Urgente\n\nO servidor de produção está fora do ar; talvez afete todos os clientes.', 'urgente', URG],
  ['Urgente. Provavelmente é incidente de produção.', 'urgente', URG],
  ['Normal\n\nNão é urgente: o usuário só pediu informação.', 'normal', URG],
  ['Normal — não urgente.', 'normal', URG],
  ['Negative\n\nThe customer is not happy.', 'negative', EN],
  ['Negative. The customer probably won\'t return.', 'negative', EN],
  ['Negative — not neutral, because of the explicit complaint.', 'negative', EN],
  ['Label: negative', 'negative', EN],
  ['edit\n\nThe user wants to change the existing text, not create a new one.', 'edit', INTENT],
  ['Intent: edit\nReason: user asked to change a paragraph; maybe also help, but edit dominates.', 'edit', INTENT],
  ['help', 'help', INTENT],
];

/** Positivos legítimos frescos (revisão 3). */
const FRESCOS_LEGITIMOS: C[] = [
  ['Negativo. Acho que o cliente está irritado.', 'negativo', SENT],
  ['Negativo. O cliente talvez volte, mas está irritado.', 'negativo', SENT],
  ['Negativo\nO cliente elogia o produto, mas reclama da entrega.', 'negativo', SENT],
  ['Negativo. A mensagem soa positiva no começo, mas é uma reclamação.', 'negativo', SENT],
  ['Negativo. Nada de positivo na mensagem.', 'negativo', SENT],
  ['Negativo\nEmbora cordial, o cliente reclama.', 'negativo', SENT],
  ['Positivo. O cliente agradece e elogia.', 'positivo', SENT],
  ['Neutro. É só uma pergunta sobre o prazo.', 'neutro', SENT],
  ['Neutro\nNão há elogio nem reclamação.', 'neutro', SENT],
  ['Yes. There is no exception here.', 'yes', YN],
  ['No. The deadline has passed.', 'no', YN],
  ['No\nThere is no refund after 30 days.', 'no', YN],
  ['Yes\nThe policy does not forbid it.', 'yes', YN],
  ['Sim\nNão existe impedimento contratual.', 'sim', SIMNAO],
  ['Sim. Nada impede o reembolso, e não há multa.', 'sim', SIMNAO],
  ['Não\nO cliente não tem direito.', 'nao', SIMNAO],
  ['Urgente\nNão dá para esperar: o checkout está fora do ar.', 'urgente', URG],
  ['Urgente. O servidor caiu e provavelmente afeta todos.', 'urgente', URG],
  ['Normal. Parece urgente, mas é só uma dúvida.', 'normal', URG],
  ['edit\nThe user wants to fix a typo; this is not a new document.', 'edit', INTENT],
  ['Intent: help\nThe user asks how to use the feature.', 'help', INTENT],
  ['{"label":"negativo","confidence":0.85,"reason":"cliente irritado"}', 'negativo', SENT],
  ['{"label":"negativo","explicacao":"Não há nada positivo, apenas queixas."}', 'negativo', SENT],
  ['{"intent":"edit","notes":"not a create request"}', 'edit', INTENT],
];

/**
 * Resposta correta e firme cuja explicação usa o contraste "parece/pode
 * parecer <outro rótulo>, mas…": nunca 'nao' (o risco aceito do R-03b é
 * rebaixar para 'parcial', nunca zerar), e o veredito não depende da quebra
 * de linha.
 */
const CONTRASTE: C[] = [
  ['Negativo\n\nPode parecer neutro, mas há ironia.', 'negativo', SENT],
  ['Negativo\n\nÀ primeira vista parece neutro, mas há ironia.', 'negativo', SENT],
  ["Negativo\n\nPoderia parecer positivo pelo 'obrigado', mas é sarcasmo.", 'negativo', SENT],
  ['Negativo. Pode soar neutro, mas há ironia.', 'negativo', SENT],
  ['Negativo\n\nNão é neutro nem positivo.', 'negativo', SENT],
  ['Negativo\nParece neutro, mas não é.', 'negativo', SENT],
  ['Negativo\nParece positivo, mas é ironia.', 'negativo', SENT],
  ['Negativo\n\nTalvez pareça positivo pelo elogio inicial, porém a queixa domina.', 'negativo', SENT],
  ['Negative\n\nIt might look neutral, but there is sarcasm.', 'negative', EN],
  ['Negative\n\nIt may seem positive, but it is sarcastic.', 'negative', EN],
  ['Urgente\n\nPode parecer normal, mas o servidor caiu.', 'urgente', URG],
  ['Normal\n\nParece urgente pelo tom, mas é só dúvida de uso.', 'normal', URG],
  ['Normal\n\nEmbora pareça urgente, é só uma dúvida.', 'normal', URG],
];

function falsosResolve(casos: readonly C[]): string[] {
  return casos
    .map(([t, e, ls]) => ({ t, r: matchExpected(t, e, { labelSet: ls }) }))
    .filter(({ r }) => r.verdict === 'resolve')
    .map(({ t, r }) => `${JSON.stringify(t)} → ${r.rule}`);
}

function naoResolvidos(casos: readonly C[]): string[] {
  return casos
    .map(([t, e, ls]) => ({ t, r: matchExpected(t, e, { labelSet: ls }) }))
    .filter(({ r }) => r.verdict !== 'resolve')
    .map(({ t, r }) => `${JSON.stringify(t)} → ${r.verdict}/${r.rule}`);
}

describe('IMPL-003 holdout — 0 falso resolve', () => {
  it(`sondas da revisão 2 (${REVISAO_ADVERSARIAIS.length})`, () => {
    expect(falsosResolve(REVISAO_ADVERSARIAIS)).toEqual([]);
  });

  it(`variações frescas (${FRESCAS_ADVERSARIAIS.length})`, () => {
    expect(falsosResolve(FRESCAS_ADVERSARIAIS)).toEqual([]);
  });

  it('pergunta com "!"/"?" extra ou dentro do JSON nunca resolve', () => {
    for (const t of ['Negativo?!', 'Negativo??', 'Negativo (?)', '¿Negativo', '{"label":"negativo?"}', '{"label":"negativo?!"}']) {
      expect(matchExpected(t, 'negativo', { labelSet: SENT }).verdict, t).toBe('nao');
    }
    // modo campo→valor também
    expect(matchExpected('{"intent":"edit?"}', { intent: 'edit' }).verdict).toBe('nao');
  });

  it('multi-rótulo com porcentagem e retratação/hesitação solta dão nao (não só "não resolve")', () => {
    const casos: C[] = [
      ['negativo (50%), positivo (50%)', 'negativo', SENT],
      ['Negativo: 50%. Positivo: 50%.', 'negativo', SENT],
      ['edit (50%) / help (50%)', 'edit', INTENT],
      ['Negativo. Errado, é neutro.', 'negativo', SENT],
      ['Negative. Wait, neutral.', 'negative', EN],
      ['Urgente — mentira, normal.', 'urgente', URG],
      ['Urgente. Só que não.', 'urgente', URG],
      ['Opção A: negativo\nOpção B: positivo', 'negativo', SENT],
      ['negativo\nCorrigindo: positivo', 'negativo', SENT],
      ['Negativo, mas com dúvidas.', 'negativo', SENT],
      ['Negativo, se não me engano.', 'negativo', SENT],
    ];
    for (const [t, e, ls] of casos) expect(matchExpected(t, e, { labelSet: ls }).verdict, t).not.toBe('resolve');
    for (const [t, e, ls] of casos.slice(0, 9)) expect(matchExpected(t, e, { labelSet: ls }).verdict, t).toBe('nao');
    // sem sujeito vira distribuição; com sujeito é explicação (parcial, não zera)
    expect(matchExpected('Negativo. O início é positivo (20% do texto), o resto reclama.', 'negativo', { labelSet: SENT }).verdict).toBe('parcial');
  });

  it('JSON: texto livre com conflito duro, lista com 2 rótulos e rótulo em qualquer profundidade → nao', () => {
    const casos = [
      '{"label":"negativo","nota":"na verdade é positivo"}',
      '{"label":"negativo","labels":["negativo","positivo"]}',
      '{"a":{"b":{"label":"positivo"}},"label":"negativo"}',
      '{"x":[{"y":{"label":"positivo"}}],"label":"negativo"}',
    ];
    for (const t of casos) expect(matchExpected(t, 'negativo', { labelSet: SENT }).verdict, t).toBe('nao');
    // explicação que só menciona outro rótulo NEGADO continua resolvendo
    expect(matchExpected('{"label":"negativo","motivo":"não é positivo"}', 'negativo', { labelSet: SENT }).verdict).toBe('resolve');
  });

  it('sem labelSet (config legada): lista de rótulos nunca resolve; dúvida solta dá nao', () => {
    for (const t of ['negativo, positivo, neutro', 'Negativo; positivo; neutro', 'negativo\npositivo\nneutro', 'negativo\npositivo']) {
      expect(matchExpected(t, 'negativo').verdict, t).not.toBe('resolve');
    }
    for (const t of ['Negativo. Talvez.', 'Negativo. Não sei.', 'Negativo. Não.']) {
      expect(matchExpected(t, 'negativo').verdict, t).toBe('nao');
    }
    // uma linha só com o rótulo continua resolvendo sem labelSet
    expect(matchExpected('negativo', 'negativo').verdict).toBe('resolve');
    expect(matchExpected('negativo\n\nO cliente reclama do atraso na entrega.', 'negativo').verdict).toBe('resolve');
  });
});

describe('IMPL-003 holdout — positivos legítimos ≥95%', () => {
  it(`amostra da revisão 2 + frescos (${REVISAO_LEGITIMOS.length + FRESCOS_LEGITIMOS.length})`, () => {
    const todos = [...REVISAO_LEGITIMOS, ...FRESCOS_LEGITIMOS];
    const erros = naoResolvidos(todos);
    expect((todos.length - erros.length) / todos.length, erros.join('\n')).toBeGreaterThanOrEqual(0.95);
  });

  it('"parece <outro rótulo>, mas…" nunca zera a resposta correta', () => {
    for (const [t, e, ls] of CONTRASTE) {
      expect(matchExpected(t, e, { labelSet: ls }).verdict, t).not.toBe('nao');
    }
    // e a quebra de linha não muda o veredito
    const umaLinha = matchExpected('Negativo. Pode parecer neutro, mas há ironia.', 'negativo', { labelSet: SENT });
    const duasLinhas = matchExpected('Negativo\n\nPode parecer neutro, mas há ironia.', 'negativo', { labelSet: SENT });
    expect(umaLinha.verdict).toBe(duasLinhas.verdict);
  });
});
