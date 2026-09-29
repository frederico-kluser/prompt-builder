// Meta-prompts EMBUTIDOS do pipeline, por papel (IMPL-070, R-20:REC-8/M-120).
//
// O hash do contrato do juiz cobre só o julgamento. Os prompts internos do
// reescritor, da reflexão, das técnicas, do datagen e do gabarito mudavam sem
// rastro: duas sessões com meta-prompts diferentes ficavam "comparáveis" por
// acaso. Este módulo junta o texto de TODOS eles num mapa de chaves estáveis e
// o fingerprint (JCS + SHA-256, idêntico nos dois runtimes) entra no pin da run
// como `runContractHash` — qualquer edição de texto muda o hash da run, sem
// mexer no hash do JUIZ (o `baseline check` do CI continua só sobre o juízo).
// A suíte `prompts regression` imprime o MESMO fingerprint: é a cadência "rode
// de novo quando o texto de um prompt mudar".
//
// Revisão w2: o mapa cobria só os SYSTEM do reescritor/reflexão/lote do
// datagen/gabarito. A instrução de reposição por diversidade do datagen, o
// gerador adversarial (guarda), o system do gerador por etapa, os templates de
// USER (lote do datagen, reescritor, gabarito) e o verificador de gabaritos
// mudavam sem mudar o `runContractHash`. `test/prompts-regression.test.ts`
// agora varre os `role: 'system'` dos módulos do pipeline: mensagem de sistema
// nova sem registro aqui derruba o teste.
//
// Sem Node (entra no bundle do navegador pelo orquestrador do SPA).

import { buildRewriterUserPrompt, metaPromptTexts } from './variator.js';
import {
  ADVERSARIAL_CATEGORIES,
  buildAdversarialMessages,
  buildBatchMessages,
  DATAGEN_STAGE_SYSTEM_PROMPT,
  diversityInstruction,
} from './datagen.js';
import { buildGabaritoMessages, GABARITO_ROLE_PROMPT, GABARITO_VERIFIER_SYSTEM_PROMPT } from './gabarito.js';
import { TECHNIQUE_LIBRARY } from './techniques.js';
import { metaPromptsFingerprint } from './engine/contracts.js';
import { DIFF_JUDGE_SYSTEM } from './engine/contractLayers.js';

/** Conteúdo das mensagens, na ordem, num texto só (forma canônica de um builder). */
function juntar(msgs: readonly { content: unknown }[]): string {
  return msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\u0003');
}

/** Papel → texto do meta-prompt (chaves estáveis; a ordem não importa no hash). */
export function pipelineMetaPromptTexts(): Record<string, string> {
  // Formas CANÔNICAS dos builders: sem o que a config acrescenta (tema,
  // briefing, regras, idiomas — isso já está na config), só o molde fixo.
  const lote = buildBatchMessages({ theme: '', count: 1, excludePrompts: [], batchIndex: 0, batchCount: 2 });
  const tecnica = TECHNIQUE_LIBRARY[0];
  return {
    ...metaPromptTexts(),
    // O system do LOTE do datagen é montado por função: a forma canônica (sem
    // briefing/regras/idiomas — o que a config acrescenta já está na config).
    'datagen/batch-system': lote[0]?.content ?? '',
    'datagen/batch-user': lote[1]?.content ?? '',
    'datagen/stage-system': DATAGEN_STAGE_SYSTEM_PROMPT,
    'datagen/backfill-diversity': diversityInstruction(1, 1, 1),
    'datagen/adversarial': ADVERSARIAL_CATEGORIES.map((category) =>
      juntar(buildAdversarialMessages({ category, count: 1, baseSystemPrompt: '' })),
    ).join('\u0002'),
    // Juiz do DIFF do gate de contrato (camada 2): decide quais reescritas
    // sobrevivem — muda o conjunto de variantes da run.
    'rewriter/contract-diff-judge': DIFF_JUDGE_SYSTEM,
    'rewriter/user-template': tecnica
      ? buildRewriterUserPrompt({ theme: '', technique: tecnica, baseText: '' })
      : '',
    'gabarito/role': GABARITO_ROLE_PROMPT,
    'gabarito/user-template': juntar(
      buildGabaritoMessages({ question: '', productContext: '', maxTokens: 1, rubric: 'R' }).slice(1),
    ),
    'gabarito/verifier-system': GABARITO_VERIFIER_SYSTEM_PROMPT,
  };
}

/** Fingerprint dos meta-prompts em vigor neste binário. */
export function pipelineMetaPromptsFingerprint(): string {
  return metaPromptsFingerprint(pipelineMetaPromptTexts());
}
