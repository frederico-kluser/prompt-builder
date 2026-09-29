// `prompt-builder library` — banco persistente de cenários+gabaritos (F1 do
// PLANO-PARIDADE). Dataset estável entre sessões: sem isso o `minGain` compara
// contra o controle enquanto o PRÓPRIO dataset muda de run para run.
//
// stdout é payload, stderr é narração (contrato do CLI). `--json` devolve um
// objeto por comando. `seed` com `--generate` gasta LLM e segue a regra de
// `--budget` obrigatório fora de TTY (igual aos comandos de run).
//
// cli#16: o texto de ajuda mora SÓ em `../help.ts` (`renderCommandHelp`) — o
// `main` intercepta `--help` antes do dispatch, então uma cópia local aqui
// nunca era mostrada (e o help central apontava para ela mesma).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  REJECT_KINDS,
  coverageReport,
  curatedKofN,
  curationIssue,
  curationStatus,
  hasGabarito,
  labelIssue,
  libraryItemFromStage,
  mergeSeedItems,
  normalizeLibraryItem,
  planItemReviews,
  type CoverageTargets,
  type ItemReviewRequest,
  type LibraryItem,
  type RejectKind,
  type ScenarioRules,
} from '../../engine/libraryCore.js';
import { coverageInstruction, parseScenarioRules } from '../../engine/scenarioRules.js';
import {
  EXCHANGE_FORMAT,
  isExchangeManifestOnly,
  toSingleFileBundle,
} from '../../engine/exchange.js';
import {
  deleteItem,
  deleteProfile,
  saveItems,
  exportProfileExchange,
  exportProfilePackDeclared,
  getItem,
  getProfile,
  importItems,
  isExchangeReadError,
  listItems,
  listProfiles,
  prepareImportItems,
  readExchangeDir,
  saveProfile,
  seedItems,
  writeExchangeDir,
} from '../../library.js';
import {
  ADVERSARIAL_MAX_COST_PER_SCENARIO_USD,
  adversarialCoverageReport,
  generateAdversarialStages,
  generateStages,
  languageWarnings,
  type DatagenReport,
} from '../../datagen.js';
import { generateReferences } from '../../gabarito.js';
import { BudgetLedger, isControlSignal } from '../../budget.js';
import { SCENARIO_PACK_FORMAT } from '../../scenarioPack.js';
import { pkgVersion } from '../../paths.js';
import type { StageSpec } from '../../types.js';
import { buildContext, buildNetworkContext, isAgentContext, limitList, parse, parseListLimit, readJsonFile } from '../context.js';
import { resolveApprover } from '../approval.js';
import { CliError, EXIT, type Output } from '../output.js';
import { renderCommandHelp } from '../help.js';
import { isUnsafePathError } from '../../pathSafety.js';

function exigirProfile(values: Record<string, unknown>): string {
  const p = values.profile;
  if (typeof p !== 'string' || !p.trim()) {
    throw new CliError('Informe --profile <id> (qual banco de cenários).', EXIT.USAGE);
  }
  return p.trim();
}

/** Mesmo leitor do resto do CLI: `usage.file_unreadable` (2) × `config.invalid_json` (3). */
async function lerArquivoJson(file: string): Promise<unknown> {
  return readJsonFile(file);
}

/**
 * Fonte de itens do `add`/`seed --file` (IMPL-089): arquivo JSON (lista,
 * `{items}`, pacote `pack@1` ou `exchange@1` em arquivo único) OU o DIRETÓRIO
 * de um pacote `prompt-builder-exchange@1` (manifest.json + library.jsonl) —
 * apontar o próprio `manifest.json` também serve.
 */
async function lerFonteDeItens(file: string): Promise<unknown> {
  const eDiretorio = await fs
    .stat(file)
    .then((st) => st.isDirectory())
    .catch(() => false);
  try {
    if (eDiretorio) return await readExchangeDir(file);
    const cru = await lerArquivoJson(file);
    return isExchangeManifestOnly(cru) ? await readExchangeDir(path.dirname(file)) : cru;
  } catch (err) {
    if (isExchangeReadError(err)) {
      throw new CliError(err.message, EXIT.CONFIG, { path: file }, {
        code: 'library.exchange_invalid',
        hint: `Aponte o diretório gerado por \`library export -o <dir>\` (ou o arquivo .json único).`,
      });
    }
    throw err;
  }
}

/** Texto de UM pacote de troca em arquivo único (stdout / `-o <arq>.json`). */
function textoPacoteUnico(bundle: Parameters<typeof toSingleFileBundle>[0]): string {
  return `${JSON.stringify(toSingleFileBundle(bundle), null, 2)}\n`;
}

export async function cmdLibrary(argv: string[]): Promise<number> {
  try {
    return await cmdLibraryInner(argv);
  } catch (err) {
    // IMPL-024: perfil/item fora do formato (`--profile ..`) é USO inválido —
    // exit 2, não a falha genérica 1. Por `code`, nunca `instanceof`.
    if (isUnsafePathError(err)) throw new CliError(err.message, EXIT.USAGE);
    throw err;
  }
}

async function cmdLibraryInner(argv: string[]): Promise<number> {
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'list';
  const parsed = parse(argv[0] === sub ? argv.slice(1) : argv, {
    profile: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    file: { type: 'string' },
    origin: { type: 'string' },
    // LGPD (IMPL-042): revisei o dado pessoal apontado — o item entra (e segue
    // pseudonimizado em toda chamada de LLM; nomes não cobertos).
    'allow-pii': { type: 'boolean' },
    theme: { type: 'string' },
    model: { type: 'string' },
    generate: { type: 'string' },
    budget: { type: 'string' },
    out: { type: 'string', short: 'o' },
    rules: { type: 'string' },
    targets: { type: 'string' },
    // IMPL-068: `seed --generate N --tier adversarial --base-prompt-file <arq>`.
    tier: { type: 'string' },
    'base-prompt-file': { type: 'string' },
    // IMPL-056: idiomas do datagen (opt-in; sem a flag, 100% pt-BR).
    languages: { type: 'string' },
    // IMPL-089: `export --format exchange|pack` (default exchange).
    format: { type: 'string' },
    // IMPL-092: teto default de 50 em `library list` (--limit N / --all).
    limit: { type: 'string' },
    all: { type: 'boolean' },
    // IMPL-063 (left#4): dedup SEMÂNTICO do `seed --generate` (embeddings; custo no papel datagen).
    'semantic-dedup': { type: 'boolean' },
    // IMPL-090/087 (left#7): `library review` — ids separados por vírgula.
    approve: { type: 'string' },
    reject: { type: 'string' },
    adjust: { type: 'string' },
    reopen: { type: 'string' },
    reviewer: { type: 'string' },
    reason: { type: 'string' },
    note: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (parsed.values.help) {
    // Só alcançável por chamada direta (o `main` já responde ao --help): a
    // MESMA fonte do help central, nunca uma cópia que diverge.
    process.stdout.write(renderCommandHelp('library'));
    return EXIT.OK;
  }
  const ctx = buildContext(parsed);
  const { out } = ctx;

  switch (sub) {
    case 'list': {
      const profileId = typeof parsed.values.profile === 'string' ? parsed.values.profile : undefined;
      // IMPL-092: teto default de 50 (--limit N / --all; truncar avisa no stderr).
      const cap = parseListLimit(parsed.values);
      if (!profileId) {
        const perfis = await listProfiles();
        const contagens = await Promise.all(perfis.map((p) => listItems(p.id)));
        const visiveis = limitList(perfis, cap, out, 'perfis');
        if (out.isText) {
          if (!perfis.length) out.line('(biblioteca vazia — crie um perfil com `library init`)');
          visiveis.forEach((p) =>
            out.line(
              `${p.id.padEnd(24)} ${String(contagens[perfis.indexOf(p)].length).padStart(4)} itens  ${p.name}`,
            ),
          );
        }
        out.result(true, 'library.list', {
          profiles: visiveis.map((p) => ({ ...p, itemCount: contagens[perfis.indexOf(p)].length })),
          total: perfis.length,
        });
        return EXIT.OK;
      }
      const todos = await listItems(profileId);
      const itens = limitList(todos, cap, out, 'itens');
      if (out.isText) {
        if (!itens.length) out.line(`(perfil "${profileId}" sem itens)`);
        for (const it of itens) {
          const gab = hasGabarito(it) ? (it.expected !== undefined ? 'expected' : 'reference') : 'SEM GABARITO';
          // left#7: o estado de curadoria na listagem (aprovado velho = hash não bate).
          const estado = it.state === 'aprovado' && curationIssue(it) ? 'aprov.velho' : (it.state ?? '-');
          out.line(
            `${it.id.padEnd(16)} ${it.tier.padEnd(12)} ${gab.padEnd(13)} ${estado.padEnd(11)} ${it.title}`,
          );
        }
      }
      out.result(true, 'library.items', { profile: profileId, items: itens, total: todos.length });
      return EXIT.OK;
    }

    case 'init': {
      const profileId = exigirProfile(parsed.values);
      // Regras de geração (F1.3) e matriz de cobertura (F1.5) vêm de arquivos
      // JSON versionados junto do prompt — validação mínima, erro em PT-BR.
      let rules: ScenarioRules | undefined;
      let warnings: string[] = [];
      if (typeof parsed.values.rules === 'string') {
        const r = parseScenarioRules(await lerArquivoJson(parsed.values.rules));
        if (!r.ok) throw new CliError(`Arquivo de regras inválido: ${r.error}`, EXIT.CONFIG);
        rules = r.rules;
        // Grounding que não chegaria ao gerador (IMPL-008): avisa, não recusa.
        warnings = r.warnings;
        for (const w of warnings) out.warn(`regras: ${w}`);
      }
      let targets: CoverageTargets | undefined;
      if (typeof parsed.values.targets === 'string') {
        targets = (await lerArquivoJson(parsed.values.targets)) as CoverageTargets;
      }
      const perfil = await saveProfile({
        id: profileId,
        name: typeof parsed.values.name === 'string' ? parsed.values.name : profileId,
        description: typeof parsed.values.description === 'string' ? parsed.values.description : undefined,
        scenarioRules: rules,
        coverageTargets: targets,
      });
      out.info(`perfil "${perfil.id}" pronto em ${ctx.dataDir}/library/${perfil.id}/`);
      out.result(true, 'library.init', { profile: perfil, warnings });
      return EXIT.OK;
    }

    case 'show': {
      const itemId = ctx.positionals[0];
      if (!itemId) throw new CliError('Informe o id do item: `library show <itemId> --profile <id>`.', EXIT.USAGE);
      const item = await getItem(exigirProfile(parsed.values), itemId);
      if (!item) throw new CliError(`Item "${itemId}" não encontrado.`, EXIT.USAGE);
      if (out.isText) out.raw(`${JSON.stringify(item, null, 2)}\n`);
      out.result(true, 'library.show', { item });
      return EXIT.OK;
    }

    case 'add': {
      const profileId = exigirProfile(parsed.values);
      const file = typeof parsed.values.file === 'string' ? parsed.values.file : undefined;
      if (!file) throw new CliError('Informe --file <arquivo.json>.', EXIT.USAGE);
      const cru = await lerFonteDeItens(file);
      const origin =
        parsed.values.origin === 'official' || parsed.values.origin === 'ai' || parsed.values.origin === 'manual'
          ? parsed.values.origin
          : 'import';
      const res = await importItems(profileId, cru, { origin, allowPii: parsed.values['allow-pii'] === true });
      out.info(`+${res.added} itens · ${res.updated} atualizados · ${res.errors.length} recusados (${res.format})`);
      // IMPL-089: perda nunca é calada — o que o pacote declarou perdido (ou a
      // normalização não representou) sai no stderr E no resultado.
      if (res.lostFields.length) out.warn(`campos declarados perdidos: ${res.lostFields.join(', ')}`);
      for (const e of res.errors) out.warn(e);
      if (res.errors.length) {
        throw new CliError(`${res.errors.length} item(ns) recusado(s); os válidos já foram gravados.`, EXIT.CONFIG, res, {
          code: 'library.items_rejected',
          hint: 'Corrija os itens de details.errors e rode `library add` de novo (o que passou não duplica).',
        });
      }
      out.result(true, 'library.add', res);
      return EXIT.OK;
    }

    case 'seed': {
      const profileId = exigirProfile(parsed.values);
      // Caminho 1: seed IDEMPOTENTE de arquivo — o que já existe (mesmo id) é
      // pulado, nunca sobrescreve curadoria. Rodar 2× não muda nada.
      if (typeof parsed.values.file === 'string') {
        const cru = await lerFonteDeItens(parsed.values.file);
        // MESMO funil do `add` (formato + LGPD): item com dado pessoal de
        // aparência real é recusado nomeando o campo, salvo `--allow-pii`.
        const { items: validos, errors, lostFields } = prepareImportItems(cru, {
          origin: 'import',
          allowPii: parsed.values['allow-pii'] === true,
        });
        const itens: LibraryItem[] = validos.map((it) => ({ ...it, seed: it.seed ?? 'prompt-builder:seed@1' }));
        if (lostFields.length) out.warn(`campos declarados perdidos: ${lostFields.join(', ')}`);
        for (const e of errors) out.warn(e);
        const res = await seedItems(profileId, itens);
        out.info(`seed: +${res.added.length} novos · ${res.skipped.length} já existentes (pulados) · ${errors.length} recusados`);
        if (errors.length) {
          throw new CliError(
            `${errors.length} item(ns) recusado(s); os válidos já foram gravados.`,
            EXIT.CONFIG,
            { added: res.added, skipped: res.skipped, errors },
            {
              code: 'library.items_rejected',
              hint: 'Corrija os itens de details.errors e rode `library seed` de novo (seed é idempotente).',
            },
          );
        }
        out.result(true, 'library.seed', { added: res.added, skipped: res.skipped, errors, lostFields });
        return EXIT.OK;
      }
      // Caminho 2: geração IA (datagen com regras do perfil + gabarito por item).
      const count = Number(parsed.values.generate ?? 0);
      const theme = typeof parsed.values.theme === 'string' ? parsed.values.theme : '';
      const model = typeof parsed.values.model === 'string' ? parsed.values.model : '';
      const tier = typeof parsed.values.tier === 'string' ? parsed.values.tier.trim() : undefined;
      // IMPL-068: o único tier com gerador PRÓPRIO é o adversarial (6 categorias,
      // condicionado ao prompt-base). Os demais saem do datagen normal, na
      // proporção da matriz-alvo — pedir outro aqui seria prometer o que não há.
      if (tier !== undefined && tier !== 'adversarial') {
        throw new CliError(
          `--tier só aceita "adversarial" (recebi "${tier}"). Os demais tiers saem do datagen normal, pela matriz-alvo.`,
          EXIT.USAGE,
          { flag: '--tier', value: tier },
          { code: 'usage.invalid_flag_value', hint: 'Use `--tier adversarial --base-prompt-file <arq>` ou omita --tier.' },
        );
      }
      const adversarial = tier === 'adversarial';
      if (!Number.isInteger(count) || count <= 0 || !model || (!adversarial && !theme)) {
        throw new CliError(
          adversarial
            ? 'Seed adversarial exige --generate <N> --tier adversarial --base-prompt-file <arq> --model <id>.'
            : 'Seed por geração exige --generate <N> --theme <tema> --model <id> (ou --file <arq>).',
          EXIT.USAGE,
        );
      }
      let basePrompt = '';
      if (adversarial) {
        const arq = parsed.values['base-prompt-file'];
        if (typeof arq !== 'string' || !arq.trim()) {
          throw new CliError(
            'Seed adversarial exige --base-prompt-file <arq>: o system prompt-base cuja política os ataques testam.',
            EXIT.USAGE,
            { flag: '--base-prompt-file' },
            { code: 'usage.missing_flag', hint: 'Ex.: `--base-prompt-file prompts/atendimento.md`.' },
          );
        }
        try {
          basePrompt = await fs.readFile(arq, 'utf-8');
        } catch {
          throw new CliError(`Não consegui ler o arquivo "${arq}".`, EXIT.USAGE, { path: arq }, {
            code: 'usage.file_unreadable',
            hint: 'Confira o caminho (relativo ao diretório atual) e as permissões do arquivo.',
          });
        }
        if (!basePrompt.trim()) {
          throw new CliError(`"${arq}" está vazio: não há política para testar.`, EXIT.USAGE, { path: arq });
        }
      }
      const languages =
        typeof parsed.values.languages === 'string'
          ? parsed.values.languages.split(',').map((l) => l.trim()).filter(Boolean)
          : undefined;
      if (adversarial && parsed.values['semantic-dedup'] === true) {
        out.warn('--semantic-dedup não se aplica a --tier adversarial: cada categoria é gerada à parte (flag ignorada).');
      }
      if (adversarial && languages?.length) {
        out.warn('--languages não se aplica a --tier adversarial: o gerador adversarial é pt-BR (flag ignorada).');
      }
      if (isAgentContext() && parsed.values.budget === undefined) {
        throw new CliError(
          'Fora de um terminal, --budget <usd|none> é obrigatório para geração (nada é gasto sem ele).',
          EXIT.USAGE,
        );
      }
      const perfil = await getProfile(profileId);
      // Regras do perfil (grounding) quando existirem — F1.3. Validadas ANTES
      // de gastar: regra quebrada (salva por versão antiga, editada à mão)
      // derrubaria cada lote por dentro e o seed sairia com zero cenários.
      let rules: ScenarioRules | undefined;
      let warnings: string[] = [];
      if (!adversarial && perfil?.scenarioRules !== undefined) {
        const r = parseScenarioRules(perfil.scenarioRules);
        if (!r.ok) {
          throw new CliError(
            `Regras de geração do perfil "${profileId}" inválidas: ${r.error} Corrija com \`library init --rules <arq>\`.`,
            EXIT.CONFIG,
          );
        }
        rules = r.rules;
        warnings = r.warnings;
        for (const w of warnings) out.warn(`regras: ${w}`);
      }
      const net = await buildNetworkContext(parsed);
      const budgetUsd = parsed.values.budget === 'none' ? undefined : Number(parsed.values.budget ?? NaN);
      const ledger = new BudgetLedger({
        budgetUsd: Number.isFinite(budgetUsd) ? budgetUsd : undefined,
      });
      try {
        const existentes = await listItems(profileId);
        const exclude = existentes.map((i) => i.question);
        let stages: StageSpec[];
        let relatorioDatagen: DatagenReport | undefined;
        if (adversarial) {
          // IMPL-068: um lote por categoria (6), ≥ 4 cenários em cada; tier,
          // rótulo single-turn e hash do prompt-base CARIMBADOS em código.
          stages = await generateAdversarialStages({
            apiKey: net.apiKey,
            modelId: model,
            baseSystemPrompt: basePrompt,
            count,
            excludePrompts: exclude.slice(0, 30),
            ctx: { sink: ledger },
          });
        } else {
          const gaps = coverageReport(existentes, perfil?.coverageTargets);
          stages = await generateStages({
            apiKey: net.apiKey,
            theme,
            count,
            modelId: model,
            excludePrompts: exclude,
            rules,
            coverageInstructionText: coverageInstruction(gaps),
            ...(languages?.length ? { languages } : {}),
            // IMPL-063 (left#4): o banco JÁ curado é âncora do dedup — gerado
            // que repita um item existente sai ANTES da reposição (e é contado
            // em `droppedVsSeed`), em vez de só ser pulado pelo id no merge.
            // `--semantic-dedup` liga os embeddings (mesmo gateway/ledger).
            seed: existentes.map((i) => ({ question: i.question, productContext: i.productContext })),
            ...(parsed.values['semantic-dedup'] === true ? { scenarioDedup: { semantic: true } } : {}),
            onReport: (r) => {
              relatorioDatagen = r;
            },
            // O aviso sai UMA vez, sobre os itens gravados (logo abaixo).
            onLanguageWarnings: () => undefined,
            ctx: { sink: ledger },
          });
          const r = relatorioDatagen as DatagenReport | undefined;
          if (r && r.shortfall > 0) {
            // A mensagem do datagen fala de RUN; aqui é o banco (idempotente).
            out.warn(
              `seed: ${r.final} de ${r.requested} gerados sobreviveram (${r.dedupedExact + r.dedupedSemantic} quase-duplicata(s), ` +
                `${r.droppedVsSeed} repetindo o banco; ${r.failedCalls} chamada(s) falharam) — rode de novo com outro tema/briefing.`,
            );
          } else if (r?.alert) {
            out.warn(`seed: dedup removeu ${(r.rate * 100).toFixed(0)}% dos gerados — o gerador está repetindo o molde.`);
          }
        }
        // Custo de GERAÇÃO medido (usage.cost, papel datagen) ANTES dos gabaritos.
        const custoDatagen = ledger.snapshot().byRole.datagen?.usd ?? 0;
        // 1 gabarito POR ITEM (regra P0.2): modelo de referência temp-0.
        const comGabarito = await generateReferences({
          stages,
          apiKey: net.apiKey,
          modelId: model,
          ctx: { sink: ledger },
          onProgress: (done, total) => out.info(`gabaritos: ${done}/${total}`),
        });
        const now = new Date().toISOString();
        // IMPL-064: TODO metadado do datagen v2 chega ao item (tier,
        // dimensionTags, persona, difficultyEstimate, invarianceGroup, idioma
        // e os carimbos adversariais) — antes o tier era fixo 'mft' e o resto
        // se perdia. Item que o schema recusa vira AVISO, nunca some calado.
        const itens: LibraryItem[] = [];
        const recusados: string[] = [];
        comGabarito.forEach((st, i) => {
          const r = normalizeLibraryItem(libraryItemFromStage(st, { now, seed: 'prompt-builder:seed@1' }));
          if (r.ok) itens.push(r.item);
          else recusados.push(`item gerado ${i + 1}: ${r.error}`);
        });
        for (const e of recusados) out.warn(e);
        // Idioma fora da política (IMPL-056): o gerador desobedeceu.
        const avisosIdioma = languageWarnings(itens, { languages: adversarial ? undefined : languages });
        for (const a of avisosIdioma) out.warn(a);
        const res = mergeSeedItems(existentes, itens);
        await seedItems(profileId, itens);
        const snap = ledger.snapshot();
        out.info(
          `seed: +${res.added.length} novos · ${res.skipped.length} já existentes (pulados) · custo $${snap.spentUsd.toFixed(4)}`,
        );
        // IMPL-068: cobertura por categoria do PERFIL depois do seed (é o banco
        // que a run vai usar; rodar de novo acumula) + custo de geração POR
        // CENÁRIO (medido; `unknown` no ledger não vira "custou zero").
        const cobertura = adversarial ? adversarialCoverageReport([...existentes, ...res.added]) : null;
        const porCenario = stages.length > 0 ? custoDatagen / stages.length : 0;
        if (adversarial) {
          const linha = cobertura
            ? Object.entries(cobertura.byCategory)
                .map(([k, v]) => `${k}=${v}`)
                .join('  ')
            : '(nenhum item adversarial gerado)';
          out.info(`cobertura adversarial (single-turn, ASR@1 = limite inferior): ${linha}`);
          if (!cobertura || cobertura.gaps.length) {
            out.warn(
              `categorias abaixo de ${cobertura?.minPerCategory ?? 4} cenários: ${(cobertura?.gaps ?? []).join(', ') || 'todas'} — rode o seed de novo (é idempotente).`,
            );
          }
          if (porCenario > ADVERSARIAL_MAX_COST_PER_SCENARIO_USD) {
            out.warn(
              `custo de geração $${porCenario.toFixed(4)}/cenário acima do teto de $${ADVERSARIAL_MAX_COST_PER_SCENARIO_USD} — use um gerador mais barato.`,
            );
          }
          if (snap.accuracy.unknown > 0) {
            out.warn(`${snap.accuracy.unknown} chamada(s) sem custo conhecido — o custo por cenário é um PISO, não o total.`);
          }
        }
        out.result(true, 'library.seed', {
          added: res.added,
          skipped: res.skipped,
          rejected: recusados,
          totalCostUsd: snap.spentUsd,
          byRole: snap.byRole,
          costAccuracy: snap.accuracy,
          datagenCostPerScenarioUsd: porCenario,
          warnings,
          languageWarnings: avisosIdioma,
          // IMPL-063 (left#4): o relatório da geração (dedup exato/semântico,
          // reposição, falta) — o MESMO formato do `datagenReport` da run.
          ...(relatorioDatagen ? { datagenReport: relatorioDatagen } : {}),
          ...(adversarial
            ? {
                tier: 'adversarial',
                adversarialCoverage: cobertura,
                // Só deste lote (o perfil pode já ter itens adversariais).
                generatedCoverage: adversarialCoverageReport(itens),
                maxCostPerScenarioUsd: ADVERSARIAL_MAX_COST_PER_SCENARIO_USD,
              }
            : {}),
        });
        return EXIT.OK;
      } catch (err) {
        // Sinal de controle sobe CRU: o envelope (toCliError) o mapeia para
        // kind 'control' com exit 7 (orçamento) ou 130 (cancelado).
        if (isControlSignal(err)) {
          // A gravação acontece só no FIM do lote (seed idempotente): parar no
          // meio não deixa item pela metade — e também não grava nada.
          out.warn('interrompido por orçamento/cancelamento — nada deste lote foi gravado');
        }
        throw err;
      }
    }

    case 'verify': {
      const profileId = exigirProfile(parsed.values);
      const itens = await listItems(profileId);
      const semGabarito = itens.filter((i) => !hasGabarito(i));
      // IMPL-003: rótulo curto sem labelSet (itens gravados antes da regra).
      const rotuloInvalido = itens
        .map((i) => ({ item: i, erro: labelIssue(i) }))
        .filter((x): x is { item: LibraryItem; erro: string } => x.erro !== null);
      const ok = semGabarito.length === 0 && rotuloInvalido.length === 0;
      if (out.isText) {
        if (!itens.length) out.line('(perfil vazio)');
        if (semGabarito.length) {
          out.line(`${semGabarito.length} item(ns) SEM gabarito (recusados no evolve):`);
          for (const it of semGabarito) out.line(`  ${it.id.padEnd(16)} ${it.title}`);
          out.info('Adicione `reference` (texto) ou `expected` (rótulo) a cada um.');
        }
        if (rotuloInvalido.length) {
          out.line(`${rotuloInvalido.length} item(ns) com rótulo sem labelSet válido (recusados no evolve):`);
          for (const { item, erro } of rotuloInvalido) out.line(`  ${item.id.padEnd(16)} ${erro}`);
          out.info('Adicione `labelSet` com TODOS os rótulos válidos da etapa a cada um.');
        }
        if (ok && itens.length) {
          out.line(`ok: ${itens.length} itens, todos com gabarito (reference ou expected)`);
        }
      }
      if (!ok) {
        const partes = [
          ...(semGabarito.length ? [`${semGabarito.length} sem gabarito`] : []),
          ...(rotuloInvalido.length ? [`${rotuloInvalido.length} com rótulo sem labelSet válido`] : []),
        ];
        throw new CliError(
          `${partes.join(' e ')} de ${itens.length} item(ns) (recusados no evolve).`,
          EXIT.CONFIG,
          {
            total: itens.length,
            withoutGabarito: semGabarito.map((i) => i.id),
            withoutLabelSet: rotuloInvalido.map((x) => x.item.id),
          },
          {
            code: semGabarito.length ? 'library.missing_gabarito' : 'library.missing_label_set',
            hint:
              'Adicione `reference` (texto) ou `expected` (rótulo) a cada item de details.withoutGabarito e ' +
              '`labelSet` (todos os rótulos válidos) a cada item de details.withoutLabelSet; rode `library verify` de novo.',
          },
        );
      }
      out.result(true, 'library.verify', { total: itens.length, withoutGabarito: [], withoutLabelSet: [] });
      return EXIT.OK;
    }

    case 'coverage': {
      const profileId = exigirProfile(parsed.values);
      const perfil = await getProfile(profileId);
      const itens = await listItems(profileId);
      const rel = coverageReport(itens, perfil?.coverageTargets);
      if (out.isText) {
        out.line(`total: ${rel.total} itens`);
        out.line(
          `por tier: ${Object.entries(rel.byTier)
            .map(([k, v]) => `${k}=${v}`)
            .join('  ')}`,
        );
        const dims = Object.entries(rel.byDimension).sort((a, b) => b[1] - a[1]);
        if (dims.length) {
          out.line('por dimensão:');
          for (const [k, v] of dims.slice(0, 20)) out.line(`  ${k.padEnd(28)} ${v}`);
        }
        if (rel.gaps.length) {
          out.line('lacunas vs matriz alvo:');
          for (const g of rel.gaps) out.line(`  ${g.kind} ${g.key}: ${g.have}/${g.target}`);
        } else if (perfil?.coverageTargets) {
          out.line('cobertura completa (sem lacunas vs a matriz alvo)');
        } else {
          out.line('(sem matriz alvo declarada — use `init --targets <arq.json>` para cobertura dirigida)');
        }
        if (rel.withoutGabarito.length) {
          out.line(`${rel.withoutGabarito.length} item(ns) sem gabarito: ${rel.withoutGabarito.join(', ')}`);
        }
      }
      out.result(true, 'library.coverage', { coverage: rel });
      return EXIT.OK;
    }

    case 'export': {
      const profileId = exigirProfile(parsed.values);
      const formato = parsed.values.format ?? 'exchange';
      if (formato !== 'exchange' && formato !== 'pack') {
        throw new CliError(`--format deve ser "exchange" ou "pack" (recebi "${String(formato)}").`, EXIT.USAGE, {
          flag: '--format',
          value: formato,
        }, { code: 'usage.invalid_flag_value', hint: 'exchange (default) é reimportável sem perda; pack é o pacote de seed lossy.' });
      }
      const destino = typeof parsed.values.out === 'string' ? parsed.values.out : undefined;

      if (formato === 'pack') {
        // Formato LOSSY de seed de run: o que ele descarta/reescreve é DECLARADO
        // (IMPL-089) — antes o export perdia 8 campos em silêncio.
        const { pack, lostFields } = await exportProfilePackDeclared(profileId);
        if (lostFields.length) {
          out.warn(`${SCENARIO_PACK_FORMAT} descarta/reescreve: ${lostFields.join(', ')} — para ida e volta sem perda use o default (--format exchange).`);
        }
        const texto = `${JSON.stringify(pack, null, 2)}\n`;
        if (destino) {
          await fs.writeFile(destino, texto, 'utf-8');
          out.info(`pacote gravado em ${destino} (${pack.scenarios.length} cenários)`);
        } else if (out.isText) {
          out.raw(texto);
        }
        out.result(true, 'library.export', {
          format: SCENARIO_PACK_FORMAT,
          scenarios: pack.scenarios.length,
          file: destino,
          lostFields,
          // Sem -o, o payload vai NO resultado (um único JSON no stdout).
          ...(destino ? {} : { pack }),
        });
        return EXIT.OK;
      }

      // IMPL-089: prompt-builder-exchange@1 — itens VERBATIM (campo desconhecido
      // incluso); `library add` do mesmo pacote num diretório novo é identidade.
      const { bundle, count } = await exportProfileExchange(profileId, `prompt-builder-cli@${pkgVersion()}`);
      if (destino && destino.toLowerCase().endsWith('.json')) {
        await fs.writeFile(destino, textoPacoteUnico(bundle), 'utf-8');
        out.info(`pacote ${EXCHANGE_FORMAT} gravado em ${destino} (${count} itens, arquivo único)`);
      } else if (destino) {
        await writeExchangeDir(destino, bundle);
        out.info(`pacote ${EXCHANGE_FORMAT} gravado em ${destino}/ (${count} itens: ${Object.keys(bundle.files).join(', ')})`);
      } else if (out.isText) {
        out.raw(textoPacoteUnico(bundle));
      }
      out.result(true, 'library.export', {
        format: EXCHANGE_FORMAT,
        items: count,
        ...(destino ? { [destino.toLowerCase().endsWith('.json') ? 'file' : 'dir']: destino } : {}),
        lostFields: [],
        ...(destino ? {} : { bundle: toSingleFileBundle(bundle) }),
      });
      return EXIT.OK;
    }

    case 'review':
      return libraryReview(exigirProfile(parsed.values), parsed.values, out, ctx.positionals);

    case 'rm': {
      const profileId = exigirProfile(parsed.values);
      const itemId = ctx.positionals[0];
      if (!itemId) throw new CliError('Informe o id do item: `library rm --profile <id> <itemId>`.', EXIT.USAGE);
      const ok = await deleteItem(profileId, itemId);
      if (!ok) throw new CliError(`Item "${itemId}" não encontrado.`, EXIT.USAGE);
      out.info(`item "${itemId}" removido`);
      out.result(true, 'library.rm', { profile: profileId, itemId });
      return EXIT.OK;
    }

    case 'drop': {
      const profileId = exigirProfile(parsed.values);
      await deleteProfile(profileId);
      out.info(`perfil "${profileId}" removido`);
      out.result(true, 'library.drop', { profile: profileId });
      return EXIT.OK;
    }

    default:
      throw new CliError(`Subcomando desconhecido: "library ${sub}". Veja \`prompt-builder library --help\`.`, EXIT.USAGE);
  }
}

// ----------------------------------------------------------------------------
// `library review` (IMPL-090 / IMPL-087, left#7) — o fluxo de APROVAÇÃO
// ----------------------------------------------------------------------------
// Antes um item só virava `aprovado` importando-o já com estado + contentHash:
// não havia comando de revisão, então o `--require-approved`, a exigência de
// holdout 100% aprovado e a âncora humana do treino (IMPL-065) dependiam de
// editar JSON à mão. Agora: sem ação, a FILA (o que não conta como curado e
// por quê); com `--approve/--reject/--adjust/--reopen`, a revisão amarrada ao
// `contentHash` do conteúdo atual (editou depois, caduca). Tudo ou nada: um id
// ruim recusa o lote inteiro ANTES de gravar.

/** Caractere de controle (inclui `\n`/`\r`/`\t`, NUL e DEL). */
const CONTROLE = /[\u0000-\u001f\u007f]/u;

const ACOES_DE_REVISAO = ['approve', 'reject', 'adjust', 'reopen'] as const;

function idsDaFlag(v: unknown): string[] {
  if (typeof v !== 'string') return [];
  return v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * Quem revisa: `--reviewer` explícito, senão a identidade que o git usaria
 * AQUI (`Nome <email>`, como o `sessions winner --approver`). Fora de um
 * terminal (agente/CI) o `--reviewer` é OBRIGATÓRIO: aprovar é uma afirmação
 * humana ("gente conferiu pergunta + gabarito") — nunca implícita.
 */
function revisorDe(values: Record<string, unknown>): string {
  const bruto = typeof values.reviewer === 'string' ? values.reviewer : undefined;
  if (bruto !== undefined && CONTROLE.test(bruto)) {
    throw new CliError(
      '--reviewer não pode conter quebra de linha nem outro caractere de controle.',
      EXIT.USAGE,
      { flag: '--reviewer' },
      { code: 'usage.invalid_flag_value', hint: 'Use uma linha só, no formato `--reviewer "Nome <email>"`.' },
    );
  }
  const explicito = bruto?.trim() || undefined;
  if (!explicito && isAgentContext()) {
    throw new CliError(
      'Fora de um terminal, `library review` exige --reviewer "Nome <email>": aprovar afirma que uma PESSOA conferiu o item.',
      EXIT.USAGE,
      { flag: '--reviewer' },
      {
        code: 'usage.reviewer_required',
        hint: 'Passe `--reviewer "Nome <email>"` de quem revisou (fica gravado no item).',
      },
    );
  }
  const revisor = resolveApprover(explicito, process.cwd());
  if (!revisor) {
    throw new CliError(
      'Revisão sem revisor: não há --reviewer nem identidade git (user.name/user.email) aqui.',
      EXIT.USAGE,
      { flag: '--reviewer' },
      { code: 'usage.reviewer_required', hint: 'Passe `--reviewer "Nome <email>"` (ou configure user.name/user.email).' },
    );
  }
  return revisor;
}

async function libraryReview(
  profileId: string,
  values: Record<string, unknown>,
  out: Output,
  positionals: readonly string[] = [],
): Promise<number> {
  // Os ids vão SEMPRE pelas flags (--approve/--reject/--adjust/--reopen): um id
  // solto (`library review --profile X item-01`) era ignorado em silêncio e o
  // comando listava a fila como se nada tivesse sido pedido (left#7).
  if (positionals.length) {
    throw new CliError(
      `Argumento inesperado para "library review": "${positionals[0]}" — os ids dos itens vão pelas flags.`,
      EXIT.USAGE,
      { command: 'library review', positionals: [...positionals] },
      {
        code: 'usage.unexpected_argument',
        hint: `Use \`library review --profile ${profileId} --approve ${positionals[0]}\` (ou --reject/--adjust/--reopen); sem ação, o comando lista a fila.`,
      },
    );
  }
  for (const acao of ACOES_DE_REVISAO) {
    if (values[acao] !== undefined && idsDaFlag(values[acao]).length === 0) {
      throw new CliError(`--${acao} exige ids de item separados por vírgula.`, EXIT.USAGE, { flag: `--${acao}` }, {
        code: 'usage.missing_flag_value',
        hint: `Ex.: \`library review --profile ${profileId} --${acao} item-01,item-02\` (sem ação, o comando lista a fila).`,
      });
    }
  }
  const aprovar = idsDaFlag(values.approve);
  const rejeitar = idsDaFlag(values.reject);
  const ajustar = idsDaFlag(values.adjust);
  const reabrir = idsDaFlag(values.reopen);
  const temAcao = aprovar.length + rejeitar.length + ajustar.length + reabrir.length > 0;
  if (!temAcao && (values.reason !== undefined || values.note !== undefined || values.reviewer !== undefined)) {
    throw new CliError(
      '--reviewer/--reason/--note só fazem sentido com --approve, --reject, --adjust ou --reopen.',
      EXIT.USAGE,
      undefined,
      {
        code: 'usage.review_without_action',
        hint: `Sem ação, \`library review --profile ${profileId}\` só lista a fila de revisão.`,
      },
    );
  }

  const itens = await listItems(profileId);

  // Sem ação: a FILA — o que não conta como curado e por quê.
  if (!temAcao) {
    const fila = itens
      .map((i) => ({ id: i.id, state: i.state ?? 'sem_estado', issue: curationIssue(i), title: i.title }))
      .filter((x): x is { id: string; state: string; issue: string; title: string } => x.issue !== null);
    const status = curationStatus(itens);
    if (out.isText) {
      out.line(`curadoria: ${curatedKofN(itens)}`);
      if (!itens.length) out.line(`(perfil "${profileId}" sem itens)`);
      for (const f of fila) out.line(`  ${f.id.padEnd(16)} ${f.issue.padEnd(36)} ${f.title}`);
    }
    if (fila.length) {
      out.info(
        `revise com \`library show <id> --profile ${profileId}\` (pergunta E gabarito) e aprove com ` +
          `\`library review --profile ${profileId} --approve <ids> --reviewer "Nome <email>"\`.`,
      );
    }
    out.result(true, 'library.review', {
      profile: profileId,
      mode: 'queue',
      curatedKofN: curatedKofN(itens),
      curated: status.curated,
      total: status.total,
      queue: fila,
    });
    return EXIT.OK;
  }

  let rejectReason: { kind: RejectKind; note?: string } | undefined;
  if (rejeitar.length) {
    const kind = typeof values.reason === 'string' ? values.reason.trim() : '';
    if (!(REJECT_KINDS as readonly string[]).includes(kind)) {
      throw new CliError(
        `--reject exige --reason ${REJECT_KINDS.join('|')}${kind ? ` (recebi "${kind}")` : ''}.`,
        EXIT.USAGE,
        { flag: '--reason', value: kind || null, accepted: [...REJECT_KINDS] },
        {
          code: 'usage.invalid_flag_value',
          hint: 'A recusa tem de ser legível: `--reason gabarito_errado --note "o prazo certo é 30 dias"`.',
        },
      );
    }
    const note = typeof values.note === 'string' && values.note.trim() ? values.note.trim() : undefined;
    rejectReason = { kind: kind as RejectKind, ...(note ? { note } : {}) };
  } else if (values.reason !== undefined || values.note !== undefined) {
    throw new CliError('--reason/--note só valem com --reject.', EXIT.USAGE, { flag: values.reason !== undefined ? '--reason' : '--note' }, {
      code: 'usage.invalid_flag_value',
      hint: 'Use `--reject <ids> --reason <tipo> [--note <texto>]`.',
    });
  }
  const revisor = revisorDe(values);
  const pedidos: ItemReviewRequest[] = [];
  if (aprovar.length) pedidos.push({ ids: aprovar, state: 'aprovado' });
  if (rejeitar.length) pedidos.push({ ids: rejeitar, state: 'rejeitado', rejectReason });
  if (ajustar.length) pedidos.push({ ids: ajustar, state: 'ajustar' });
  if (reabrir.length) pedidos.push({ ids: reabrir, state: 'em_revisao' });

  const plano = planItemReviews(itens, pedidos, { reviewer: revisor });
  if (plano.issues.length) {
    // Tudo ou nada: NADA foi gravado. Conteúdo (sem gabarito/labelSet) = 3,
    // como o `library verify`; id/transição = uso (2).
    const conteudo = plano.issues.every((i) => i.kind === 'no_gabarito' || i.kind === 'label_set');
    for (const i of plano.issues) out.warn(`${i.id}: ${i.error}`);
    throw new CliError(
      `Revisão recusada (nada gravado): ${plano.issues.map((i) => `${i.id} (${i.error})`).join('; ')}.`,
      conteudo ? EXIT.CONFIG : EXIT.USAGE,
      { profile: profileId, issues: plano.issues },
      {
        code: conteudo ? 'library.review_invalid_item' : 'library.review_invalid',
        hint: conteudo
          ? `Corrija o gabarito dos itens de details.issues (\`library verify --profile ${profileId}\`) antes de aprovar.`
          : `Confira os ids com \`library review --profile ${profileId}\`; item rejeitado volta à revisão com --reopen antes de ser aprovado.`,
      },
    );
  }
  await saveItems(profileId, plano.items);
  const depois = await listItems(profileId);
  const status = curationStatus(depois);
  if (out.isText) {
    for (const c of plano.changes) out.line(`${c.id.padEnd(16)} ${c.from} → ${c.to}`);
    out.line(`curadoria: ${curatedKofN(depois)} (revisor: ${revisor})`);
  }
  out.result(true, 'library.review', {
    profile: profileId,
    mode: 'review',
    reviewer: revisor,
    reviewed: plano.changes,
    curatedKofN: curatedKofN(depois),
    curated: status.curated,
    total: status.total,
    unapproved: status.unapproved.slice(0, 50),
    ...(status.unapproved.length > 50 ? { unapprovedTruncated: status.unapproved.length - 50 } : {}),
  });
  return EXIT.OK;
}
