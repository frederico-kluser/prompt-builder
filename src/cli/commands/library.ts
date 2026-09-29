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
  coverageReport,
  hasGabarito,
  labelIssue,
  libraryItemFromStage,
  mergeSeedItems,
  normalizeLibraryItem,
  type CoverageTargets,
  type LibraryItem,
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
} from '../../datagen.js';
import { generateReferences } from '../../gabarito.js';
import { BudgetLedger, isControlSignal } from '../../budget.js';
import { SCENARIO_PACK_FORMAT } from '../../scenarioPack.js';
import { pkgVersion } from '../../paths.js';
import type { StageSpec } from '../../types.js';
import { buildContext, buildNetworkContext, isAgentContext, limitList, parse, parseListLimit, readJsonFile } from '../context.js';
import { CliError, EXIT } from '../output.js';
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
          out.line(
            `${it.id.padEnd(16)} ${it.tier.padEnd(12)} ${gab.padEnd(13)} ${it.title}`,
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
            // O aviso sai UMA vez, sobre os itens gravados (logo abaixo).
            onLanguageWarnings: () => undefined,
            ctx: { sink: ledger },
          });
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
