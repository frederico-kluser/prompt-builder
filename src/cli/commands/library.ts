// `prompt-builder library` — banco persistente de cenários+gabaritos (F1 do
// PLANO-PARIDADE). Dataset estável entre sessões: sem isso o `minGain` compara
// contra o controle enquanto o PRÓPRIO dataset muda de run para run.
//
// stdout é payload, stderr é narração (contrato do CLI). `--json` devolve um
// objeto por comando. `seed` com `--generate` gasta LLM e segue a regra de
// `--budget` obrigatório fora de TTY (igual aos comandos de run).

import { promises as fs } from 'node:fs';
import {
  coverageReport,
  hasGabarito,
  labelIssue,
  mergeSeedItems,
  normalizeLibraryItem,
  stableItemId,
  type CoverageTargets,
  type LibraryItem,
  type ScenarioRules,
} from '../../engine/libraryCore.js';
import { coverageInstruction, parseScenarioRules } from '../../engine/scenarioRules.js';
import {
  deleteItem,
  deleteProfile,
  exportProfilePack,
  getItem,
  getProfile,
  importItems,
  listItems,
  listProfiles,
  prepareImportItems,
  saveItems,
  saveProfile,
  seedItems,
} from '../../library.js';
import { generateStages } from '../../datagen.js';
import { generateReferences } from '../../gabarito.js';
import { BudgetLedger, isControlSignal } from '../../budget.js';
import { buildContext, buildNetworkContext, isAgentContext, limitList, parse, parseListLimit, readJsonFile } from '../context.js';
import { CliError, EXIT } from '../output.js';
import { isUnsafePathError } from '../../pathSafety.js';

const HELP = `prompt-builder library — banco persistente de cenários+gabaritos.

USO
  library list [--profile <id>]          perfis (ou itens de um perfil)
  library init --profile <id> [--name <n>] [--description <d>]
               [--rules <arq.json>] [--targets <arq.json>]
                                         cria/atualiza o perfil (regras de geração
                                         com grounding e matriz de cobertura)
  library show <itemId> --profile <id>   item completo (JSON)
  library add --profile <id> --file <arq> [--origin official|ai|manual|import] [--allow-pii]
                                         importa itens (lista, {items:[…]} ou pacote)
  library seed --profile <id> --file <arq> [--allow-pii]
                                         seed IDEMPOTENTE por id (o que existe, não sobrescreve)
  library seed --profile <id> --generate <N> --theme <t> --model <id> [--budget <usd>]
                                         gera N itens via datagen + gabarito por item
  library verify --profile <id>          itens SEM gabarito ou rótulo curto sem labelSet
                                         (recusados no evolve; exit 3)
  library coverage --profile <id>        cobertura tier × dimensão + lacunas
  library export --profile <id> -o <arq> exporta como prompt-builder-pack@1
  library rm --profile <id> <itemId>     remove um item
  library drop --profile <id>            remove o perfil inteiro

A biblioteca mora em <data-dir>/library/<profileId>/ (um JSON por item).
Regras de geração (--rules): { templates: { system, user? }, grounding?: { context?,
  fewShot?, setupKeys?[] } } — placeholders {{context}}, {{fewShot}}, {{setupKeys}},
  {{theme}}, {{count}}. O system renderizado abre o prompt do gerador; grounding que
  nenhum template usa NÃO chega ao gerador (o init e o seed avisam).
Item da biblioteca aceita os campos enriquecidos do prompt-arena:
  title, tier (mft|invariance|adversarial|edge), persona, context,
  successCriteria[], rationale, dimensionTags[], question, productContext,
  maxTokens, rubric, reference | expected (+ labelSet), origin.
Rótulo curto em expected (≤5 palavras) exige labelSet = todos os rótulos
válidos da etapa (ex.: "labelSet": ["positivo","negativo","neutro"]).
`;

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
    // IMPL-092: teto default de 50 em `library list` (--limit N / --all).
    limit: { type: 'string' },
    all: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  });
  if (parsed.values.help) {
    process.stdout.write(HELP);
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
      const cru = await lerArquivoJson(file);
      const origin =
        parsed.values.origin === 'official' || parsed.values.origin === 'ai' || parsed.values.origin === 'manual'
          ? parsed.values.origin
          : 'import';
      const res = await importItems(profileId, cru, { origin, allowPii: parsed.values['allow-pii'] === true });
      out.info(`+${res.added} itens · ${res.updated} atualizados · ${res.errors.length} recusados`);
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
        const cru = await lerArquivoJson(parsed.values.file);
        // MESMO funil do `add` (formato + LGPD): item com dado pessoal de
        // aparência real é recusado nomeando o campo, salvo `--allow-pii`.
        const { items: validos, errors } = prepareImportItems(cru, {
          origin: 'import',
          allowPii: parsed.values['allow-pii'] === true,
        });
        const itens: LibraryItem[] = validos.map((it) => ({ ...it, seed: it.seed ?? 'prompt-builder:seed@1' }));
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
        out.result(true, 'library.seed', { added: res.added, skipped: res.skipped, errors });
        return EXIT.OK;
      }
      // Caminho 2: geração IA (datagen com regras do perfil + gabarito por item).
      const count = Number(parsed.values.generate ?? 0);
      const theme = typeof parsed.values.theme === 'string' ? parsed.values.theme : '';
      const model = typeof parsed.values.model === 'string' ? parsed.values.model : '';
      if (!Number.isInteger(count) || count <= 0 || !theme || !model) {
        throw new CliError(
          'Seed por geração exige --generate <N> --theme <tema> --model <id> (ou --file <arq>).',
          EXIT.USAGE,
        );
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
      if (perfil?.scenarioRules !== undefined) {
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
        const gaps = coverageReport(existentes, perfil?.coverageTargets);
        const stages = await generateStages({
          apiKey: net.apiKey,
          theme,
          count,
          modelId: model,
          excludePrompts: exclude,
          rules,
          coverageInstructionText: coverageInstruction(gaps),
          ctx: { sink: ledger },
        });
        // 1 gabarito POR ITEM (regra P0.2): modelo de referência temp-0.
        const comGabarito = await generateReferences({
          stages,
          apiKey: net.apiKey,
          modelId: model,
          ctx: { sink: ledger },
          onProgress: (done, total) => out.info(`gabaritos: ${done}/${total}`),
        });
        const now = new Date().toISOString();
        const itens: LibraryItem[] = comGabarito.map((st) => {
          const id = stableItemId(st.question);
          return normalizeLibraryItem({
            id,
            title: st.question.slice(0, 80),
            tier: 'mft',
            question: st.question,
            productContext: st.productContext,
            maxTokens: st.maxTokens,
            rubric: st.rubric,
            reference: st.reference,
            origin: 'ai',
            createdAt: now,
            seed: 'prompt-builder:seed@1',
          }) as { ok: true; item: LibraryItem };
        }).filter((r) => r.ok).map((r) => r.item);
        const res = mergeSeedItems(existentes, itens);
        await seedItems(profileId, itens);
        const snap = ledger.snapshot();
        out.info(
          `seed: +${res.added.length} novos · ${res.skipped.length} já existentes (pulados) · custo $${snap.spentUsd.toFixed(4)}`,
        );
        out.result(true, 'library.seed', {
          added: res.added,
          skipped: res.skipped,
          totalCostUsd: snap.spentUsd,
          byRole: snap.byRole,
          warnings,
        });
        return EXIT.OK;
      } catch (err) {
        // Sinal de controle sobe CRU: o envelope (toCliError) o mapeia para
        // kind 'control' com exit 7 (orçamento) ou 130 (cancelado).
        if (isControlSignal(err)) {
          out.warn('interrompido por orçamento/cancelamento — o que foi gerado já está salvo');
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
      const pack = await exportProfilePack(profileId);
      const texto = `${JSON.stringify(pack, null, 2)}\n`;
      const destino = typeof parsed.values.out === 'string' ? parsed.values.out : undefined;
      if (destino) {
        await fs.writeFile(destino, texto, 'utf-8');
        out.info(`pacote gravado em ${destino} (${pack.scenarios.length} cenários)`);
      } else {
        out.raw(texto);
      }
      out.result(true, 'library.export', { scenarios: pack.scenarios.length, file: destino });
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
