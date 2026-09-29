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
// Sem Node (entra no bundle do navegador pelo orquestrador do SPA).

import { metaPromptTexts } from './variator.js';
import { buildBatchMessages } from './datagen.js';
import { GABARITO_ROLE_PROMPT } from './gabarito.js';
import { metaPromptsFingerprint } from './engine/contracts.js';

/** Papel → texto do meta-prompt (chaves estáveis; a ordem não importa no hash). */
export function pipelineMetaPromptTexts(): Record<string, string> {
  return {
    ...metaPromptTexts(),
    // O system do LOTE do datagen é montado por função: a forma canônica (sem
    // briefing/regras/idiomas — o que a config acrescenta já está na config).
    'datagen/batch-system': buildBatchMessages({ theme: '', count: 1, excludePrompts: [] })[0]?.content ?? '',
    'gabarito/role': GABARITO_ROLE_PROMPT,
  };
}

/** Fingerprint dos meta-prompts em vigor neste binário. */
export function pipelineMetaPromptsFingerprint(): string {
  return metaPromptsFingerprint(pipelineMetaPromptTexts());
}
