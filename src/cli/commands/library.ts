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
  mergeSeedItems,
  normalizeLibraryItem,
  stableItemId,
  type CoverageTargets,
  type LibraryItem,
  type ScenarioRules,
} from '../../engine/libraryCore.js';
import { coverageInstruction, renderScenarioRules } from '../../engine/scenarioRules.js';
import {
  deleteItem,
  deleteProfile,
  exportProfilePack,
  getItem,
  getProfile,
  importItems,
  listItems,
  listProfiles,
  saveItems,
  saveProfile,
  seedItems,
} from '../../library.js';
import { generateStages } from '../../datagen.js';
import { generateReferences } from '../../gabarito.js';
import { BudgetLedger, isControlSignal } from '../../budget.js';
import { buildContext, buildNetworkContext, isAgentContext, parse, readJsonFile } from '../context.js';
import { CliError, EXIT } from '../output.js';

const HELP = `prompt-builder library — banco persistente de cenários+gabaritos.

USO
  library list [--profile <id>]          perfis (ou itens de um perfil)
  library init --profile <id> [--name <n>] [--description <d>]
                                         cria/atualiza o perfil
  library show <itemId> --profile <id>   item completo (JSON)
  library add --profile <id> --file <arq> [--origin official|ai|manual|import]
                                         importa itens (lista, {items:[…]} ou pacote)
  library seed --profile <id> --file <arq>
                                         seed IDEMPOTENTE por id (o que existe, não sobrescreve)
  library seed --profile <id> --generate <N> --theme <t> --model <id> [--budget <usd>]
                                         gera N itens via datagen + gabarito por item
  library verify --profile <id>          itens SEM gabarito (recusados no evolve; exit 3)
  library coverage --profile <id>        cobertura tier × dimensão + lacunas
  library export --profile <id> -o <arq> exporta como prompt-builder-pack@1
  library rm --profile <id> <itemId>     remove um item
  library drop --profile <id>            remove o perfil inteiro

A biblioteca mora em <data-dir>/library/<profileId>/ (um JSON por item).
Item da biblioteca aceita os campos enriquecidos do prompt-arena:
  title, tier (mft|invariance|adversarial|edge), persona, context,
  successCriteria[], rationale, dimensionTags[], question, productContext,
  maxTokens, rubric, reference | expected, origin.
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
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'list';
  const parsed = parse(argv[0] === sub ? argv.slice(1) : argv, {
    profile: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    file: { type: 'string' },
    origin: { type: 'string' },
    theme: { type: 'string' },
    model: { type: 'string' },
    generate: { type: 'string' },
    budget: { type: 'string' },
    out: { type: 'string', short: 'o' },
    rules: { type: 'string' },
    targets: { type: 'string' },
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
      if (!profileId) {
        const perfis = await listProfiles();
        const contagens = await Promise.all(perfis.map((p) => listItems(p.id)));
        if (out.isText) {
          if (!perfis.length) out.line('(biblioteca vazia — crie um perfil com `library init`)');
          perfis.forEach((p, i) =>
            out.line(
              `${p.id.padEnd(24)} ${String(contagens[i].length).padStart(4)} itens  ${p.name}`,
            ),
          );
        }
        out.result(true, 'library.list', {
          profiles: perfis.map((p, i) => ({ ...p, itemCount: contagens[i].length })),
        });
        return EXIT.OK;
      }
      const itens = await listItems(profileId);
      if (out.isText) {
        if (!itens.length) out.line(`(perfil "${profileId}" sem itens)`);
        for (const it of itens) {
          const gab = hasGabarito(it) ? (it.expected !== undefined ? 'expected' : 'reference') : 'SEM GABARITO';
          out.line(
            `${it.id.padEnd(16)} ${it.tier.padEnd(12)} ${gab.padEnd(13)} ${it.title}`,
          );
        }
      }
      out.result(true, 'library.items', { profile: profileId, items: itens });
      return EXIT.OK;
    }

    case 'init': {
      const profileId = exigirProfile(parsed.values);
      // Regras de geração (F1.3) e matriz de cobertura (F1.5) vêm de arquivos
      // JSON versionados junto do prompt — validação mínima, erro em PT-BR.
      let rules: ScenarioRules | undefined;
      if (typeof parsed.values.rules === 'string') {
        const cru = await lerArquivoJson(parsed.values.rules) as { templates?: unknown };
        if (!cru || typeof cru !== 'object' || !cru.templates || typeof cru.templates !== 'object') {
          throw new CliError('Arquivo de regras precisa ter { templates: { system } }.', EXIT.CONFIG);
        }
        rules = cru as ScenarioRules;
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
      out.result(true, 'library.init', { profile: perfil });
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
      const res = await importItems(profileId, cru, { origin });
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
        const lista: unknown[] = Array.isArray(cru)
          ? cru
          : (cru as { items?: unknown[] })?.items ?? (cru as { scenarios?: unknown[] })?.scenarios ?? [];
        const now = new Date().toISOString();
        const errors: string[] = [];
        const itens: LibraryItem[] = [];
        lista.forEach((raw, i) => {
          const r = normalizeLibraryItem({
            origin: 'import',
            createdAt: now,
            ...((raw ?? {}) as Record<string, unknown>),
          });
          if (r.ok) itens.push({ ...r.item, seed: r.item.seed ?? 'prompt-builder:seed@1' });
          else errors.push(`item ${i + 1}: ${r.error}`);
        });
        for (const e of errors) out.warn(e);
        const res = await seedItems(profileId, itens);
        out.info(`seed: +${res.added} novos · ${res.skipped} já existentes (pulados) · ${errors.length} recusados`);
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
      const net = await buildNetworkContext(parsed);
      const perfil = await getProfile(profileId);
      const budgetUsd = parsed.values.budget === 'none' ? undefined : Number(parsed.values.budget ?? NaN);
      const ledger = new BudgetLedger({
        budgetUsd: Number.isFinite(budgetUsd) ? budgetUsd : undefined,
      });
      try {
        // Regras do perfil (grounding) quando existirem — F1.3.
        const existentes = await listItems(profileId);
        const exclude = existentes.map((i) => i.question);
        const rules = perfil?.scenarioRules;
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
          `seed: +${res.added} novos · ${res.skipped} já existentes (pulados) · custo $${snap.spentUsd.toFixed(4)}`,
        );
        out.result(true, 'library.seed', {
          added: res.added,
          skipped: res.skipped,
          totalCostUsd: snap.spentUsd,
          byRole: snap.byRole,
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
      if (out.isText) {
        if (!itens.length) out.line('(perfil vazio)');
        if (semGabarito.length) {
          out.line(`${semGabarito.length} item(ns) SEM gabarito (recusados no evolve):`);
          for (const it of semGabarito) out.line(`  ${it.id.padEnd(16)} ${it.title}`);
          out.info('Adicione `reference` (texto) ou `expected` (rótulo) a cada um.');
        } else if (itens.length) {
          out.line(`ok: ${itens.length} itens, todos com gabarito (reference ou expected)`);
        }
      }
      if (semGabarito.length) {
        throw new CliError(
          `${semGabarito.length} de ${itens.length} item(ns) sem gabarito (recusados no evolve).`,
          EXIT.CONFIG,
          { total: itens.length, withoutGabarito: semGabarito.map((i) => i.id) },
          {
            code: 'library.missing_gabarito',
            hint: 'Adicione `reference` (texto) ou `expected` (rótulo) a cada item de details.withoutGabarito e rode `library verify` de novo.',
          },
        );
      }
      out.result(true, 'library.verify', { total: itens.length, withoutGabarito: [] });
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
