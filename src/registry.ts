// GUARDA DE DRIFT de prompts de produção (F3/P0 do PLANO-PARIDADE, §7.7).
//
// Prompts de produção vivem EM CÓDIGO (um símbolo/needle num fonte). Quando um
// prompt é treinado, o fonte pode mudar depois — o prompt em produção "drifta"
// da base que foi medida. O registro é um JSON versionado junto com o código que
// aponta cada prompt treinado para o símbolo que o materializa no fonte; esta
// guarda valida, SEM LLM e SEM rede, que o needle ainda existe.
//
// `validateRegistry` é PURA (recebe o reader) de propósito: a checagem inteira
// é testável sem disco, e o CLI injeta a leitura real de arquivo.

/** Valor do campo `format` — versão do contrato do registro. */
export const REGISTRY_FORMAT = 'prompt-registry@1';

/** Onde o prompt vive no fonte. Hoje só "needle" (substring literal do arquivo). */
export interface RegistrySourceNeedle {
  kind: 'needle';
  /** Arquivo-fonte (caminho relativo ao diretório de trabalho, ou absoluto). */
  file: string;
  /** Texto literal que precisa continuar existindo no arquivo (ex.: o símbolo exportado). */
  needle: string;
}

export interface RegistryEntry {
  /** Id estável do prompt (ex.: "response-generation"). */
  id: string;
  /** Nome humano (ex.: "Geração de resposta"). */
  name: string;
  source: RegistrySourceNeedle;
  /** ISO-8601 do treino que produziu o prompt registrado. */
  trainedAt: string;
  /** Proveniência do treino (sessão de treino e run da iteração vencedora). */
  trainedFrom?: { sessionId?: string; runId?: string };
}

export interface PromptRegistry {
  format: typeof REGISTRY_FORMAT;
  prompts: RegistryEntry[];
}

/** Relatório de drift: quem ainda bate com o fonte e quem driftou (e por quê). */
export interface DriftReport {
  total: number;
  /** Ids cujo needle ainda existe no fonte. */
  ok: string[];
  /** Ids com problema, cada um com motivo PT-BR (drift real ou arquivo ilegível). */
  drifted: { id: string; reason: string }[];
}

export type ParseRegistryResult =
  | { ok: true; registry: PromptRegistry }
  | { ok: false; error: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Valida o JSON do registro. NUNCA lança: qualquer problema vira
 * `{ ok: false, error }` com mensagem PT-BR citando o campo responsável.
 */
export function parseRegistry(json: unknown): ParseRegistryResult {
  if (!isObject(json)) {
    return { ok: false, error: 'O registro deve ser um objeto JSON com "format" e "prompts".' };
  }
  if (json.format !== REGISTRY_FORMAT) {
    const recebido = typeof json.format === 'string' && json.format.trim() ? json.format : 'ausente';
    return {
      ok: false,
      error: `Campo "format" inválido: esperado "${REGISTRY_FORMAT}", recebi "${recebido}".`,
    };
  }
  if (!Array.isArray(json.prompts)) {
    return { ok: false, error: 'Campo "prompts" ausente ou não é uma lista.' };
  }

  const prompts: RegistryEntry[] = [];
  for (let i = 0; i < json.prompts.length; i++) {
    const where = `prompts[${i}]`;
    const raw = json.prompts[i] as unknown;
    if (!isObject(raw)) {
      return { ok: false, error: `Campo "${where}" deve ser um objeto de prompt.` };
    }

    const id = raw.id;
    if (typeof id !== 'string' || !id.trim()) {
      return { ok: false, error: `Campo "${where}.id" ausente ou vazio.` };
    }
    const name = raw.name;
    if (typeof name !== 'string' || !name.trim()) {
      return { ok: false, error: `Campo "${where}.name" ausente ou vazio.` };
    }

    const source = raw.source;
    if (!isObject(source)) {
      return { ok: false, error: `Campo "${where}.source" ausente ou não é um objeto.` };
    }
    if (source.kind !== 'needle') {
      const recebido = typeof source.kind === 'string' && source.kind.trim() ? source.kind : 'ausente';
      return {
        ok: false,
        error: `Campo "${where}.source.kind" inválido: esperado "needle", recebi "${recebido}".`,
      };
    }
    if (typeof source.file !== 'string' || !source.file.trim()) {
      return { ok: false, error: `Campo "${where}.source.file" ausente ou vazio.` };
    }
    if (typeof source.needle !== 'string' || !source.needle.trim()) {
      return { ok: false, error: `Campo "${where}.source.needle" ausente ou vazio.` };
    }

    const trainedAt = raw.trainedAt;
    if (typeof trainedAt !== 'string' || !trainedAt.trim() || Number.isNaN(Date.parse(trainedAt))) {
      return {
        ok: false,
        error: `Campo "${where}.trainedAt" ausente ou não é uma data ISO-8601 válida.`,
      };
    }

    let trainedFrom: RegistryEntry['trainedFrom'];
    if (raw.trainedFrom !== undefined) {
      const tf = raw.trainedFrom;
      if (!isObject(tf)) {
        return {
          ok: false,
          error: `Campo "${where}.trainedFrom" deve ser um objeto { sessionId?, runId? }.`,
        };
      }
      for (const campo of ['sessionId', 'runId'] as const) {
        if (tf[campo] !== undefined && typeof tf[campo] !== 'string') {
          return { ok: false, error: `Campo "${where}.trainedFrom.${campo}" deve ser texto.` };
        }
      }
      trainedFrom = {
        ...(typeof tf.sessionId === 'string' ? { sessionId: tf.sessionId } : {}),
        ...(typeof tf.runId === 'string' ? { runId: tf.runId } : {}),
      };
    }

    prompts.push({
      id: id.trim(),
      name: name.trim(),
      source: {
        kind: 'needle',
        file: source.file.trim(),
        // needle verbatim: é substring literal de código-fonte, só se trimma na
        // comparação (validateRegistry) para não perder indentação significativa.
        needle: source.needle,
      },
      trainedAt: trainedAt.trim(),
      ...(trainedFrom ? { trainedFrom } : {}),
    });
  }

  return { ok: true, registry: { format: REGISTRY_FORMAT, prompts } };
}

function curta(texto: string, max = 60): string {
  return texto.length > max ? `${texto.slice(0, max)}…` : texto;
}

/**
 * Varre o registro procurando drift: para cada prompt, `source.needle` precisa
 * ainda aparecer no conteúdo do arquivo (comparação literal, trimmed). Função
 * PURA — o reader é injetado, então os testes não precisam de disco.
 *
 * Arquivo ilegível (reader devolve `undefined` ou lança) também vira drift:
 * sem o fonte não há como garantir que o prompt de produção ainda é o treinado.
 */
export function validateRegistry(
  registry: PromptRegistry,
  readFile: (path: string) => string | undefined,
): DriftReport {
  const report: DriftReport = { total: registry.prompts.length, ok: [], drifted: [] };

  for (const prompt of registry.prompts) {
    const needle = prompt.source.needle.trim();
    if (!needle) {
      report.drifted.push({
        id: prompt.id,
        reason: 'campo "source.needle" vazio — nada para procurar no fonte.',
      });
      continue;
    }

    let content: string | undefined;
    try {
      content = readFile(prompt.source.file);
    } catch {
      content = undefined;
    }
    if (content === undefined) {
      report.drifted.push({
        id: prompt.id,
        reason: `arquivo "${prompt.source.file}" ilegível (não existe ou não pôde ser lido) — impossível verificar o drift.`,
      });
      continue;
    }

    if (content.includes(needle)) {
      report.ok.push(prompt.id);
    } else {
      report.drifted.push({
        id: prompt.id,
        reason: `needle "${curta(needle)}" não encontrada em "${prompt.source.file}" — o fonte mudou desde o treino.`,
      });
    }
  }

  return report;
}

/**
 * Registro-exemplo do `registry init`: JSON VÁLIDO com 1 entrada de demonstração
 * e chaves `"//"` de comentário (JSON não tem comentário nativo; chaves
 * desconhecidas são ignoradas pelo parseRegistry, então o arquivo segue
 * parseável de ponta a ponta).
 */
export function exampleRegistryJson(): string {
  return `${JSON.stringify(
    {
      '//':
        'Registro de prompts de produção (guarda de drift). Versione este arquivo junto com o ' +
        'código: cada entrada aponta o símbolo que materializa o prompt treinado no fonte.',
      format: REGISTRY_FORMAT,
      prompts: [
        {
          '//':
            'Exemplo — troque id/name/source pela realidade do projeto. `source.needle` é um ' +
            'trecho LITERAL do arquivo que precisa continuar existindo enquanto o prompt treinado ' +
            'estiver em produção.',
          id: 'exemplo',
          name: 'Prompt de exemplo',
          source: {
            kind: 'needle',
            file: 'src/prompts.ts',
            needle: 'export const EXAMPLE_PROMPT',
          },
          trainedAt: '2026-09-25T00:00:00Z',
          trainedFrom: { sessionId: 'sessao-exemplo', runId: 'run-exemplo' },
        },
      ],
    },
    null,
    2,
  )}\n`;
}
