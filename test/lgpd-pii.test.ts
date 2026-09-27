// IMPL-042 (R-16:REC-5) — cascata de dado pessoal PT-BR: regex + dígito
// verificador → camada contextual (nomes/endereços, `nao-coberto`) →
// "aparência de dado real" ⇒ bloqueio nomeando o campo. Critérios de aceite:
//   (1) fixture PRÓPRIA ≥200 casos: recall ≥0,95 e precisão ≥0,90 em
//       identificadores estruturados;
//   (2) importação com dado de aparência real bloqueada com aviso nomeando o
//       campo — falso positivo ≤5% na fixture;
//   (3) nenhuma chamada de LLM sai sem passar pela cascata (prova estática do
//       ponto único + prova dinâmica nos 6 papéis, Node e SPA);
//   (4) nomes em texto livre marcados `nao-coberto` (sem promessa de recall).
// Zero rede, zero gasto: todo LLM é o transporte falso de test/fakeOpenRouter.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pii from '../src/engine/pii.js';
import * as nodeLgpd from '../src/lgpd.js';
import * as webLgpd from '../web/src/lgpd.js';
import { chatCompletion, createGateway, pseudonymize, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import { generateContestants } from '../src/variator.js';
import { cmdLibrary } from '../src/cli/commands/library.js';
import { BudgetLedger } from '../src/budget.js';
import { judgeStageReference } from '../src/refJudge.js';
import { runConfigToArenaConfig } from '../src/runArtifact.js';
import { cmdConfig } from '../src/cli/commands/misc.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { runToCompletion as runNode } from '../src/orchestrator.js';
import { trainToCompletion as trainNode } from '../src/trainer.js';
import { runToCompletion as runWeb } from '../web/src/engine/orchestrator.js';
import { startTraining as startWebTraining } from '../web/src/engine/trainer.js';
import { subscribeSession } from '../web/src/engine/events.js';
import { parseScenarioPack } from '../src/scenarioPack.js';
import { parseArenaAgentConfig, parseArenaConfig } from '../src/configFile.js';
import { parseArenaConfig as parseArenaConfigWeb } from '../web/src/engine/configFile.js';
import { arenaAgentConfigToRunConfig, arenaConfigToRunConfig } from '../src/arenaConfig.js';
import { importItems, listItems } from '../src/library.js';
import { parseRunConfig, runConfigSchema } from '../src/runConfigSchema.js';
import type { RunConfig, TrainingConfig } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeOpenRouter, type FakeRequest } from './fakeOpenRouter.js';

vi.mock('../web/src/engine/storage', () => ({
  saveRun: async () => undefined,
  saveSession: async () => undefined,
  loadRun: async () => null,
  loadSession: async () => null,
  listRuns: async () => [],
  listSessions: async () => [],
}));

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';

// ---------------------------------------------------------------------------
// ORÁCULO INDEPENDENTE dos dígitos verificadores — escrito de outro jeito
// (gera o DV em vez de validar) para que os rótulos da fixture não dependam
// do código sob teste.
// ---------------------------------------------------------------------------

function oraculoCpfDv(base9: string): string {
  const dv = (s: string): number => {
    let soma = 0;
    for (let i = 0; i < s.length; i++) soma += Number(s[i]) * (s.length + 1 - i);
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = dv(base9);
  return `${d1}${dv(base9 + d1)}`;
}
function oraculoCpf(v: string): boolean {
  const d = v.replace(/\D/g, '');
  return d.length === 11 && !/^(\d)\1+$/.test(d) && oraculoCpfDv(d.slice(0, 9)) === d.slice(9);
}
function oraculoCnpjDv(base12: string): string {
  const val = (c: string): number => c.charCodeAt(0) - 48;
  const dv = (s: string): number => {
    let peso = s.length - 7; // 12 → 5, 13 → 6
    let soma = 0;
    for (const c of s) {
      soma += val(c) * peso;
      peso = peso === 2 ? 9 : peso - 1;
    }
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = dv(base12);
  return `${d1}${dv(base12 + d1)}`;
}
function oraculoCnpj(v: string): boolean {
  const s = v.toUpperCase().replace(/[^0-9A-Z]/g, '');
  return /^[0-9A-Z]{12}\d{2}$/.test(s) && oraculoCnpjDv(s.slice(0, 12)) === s.slice(12);
}
function oraculoCns(v: string): boolean {
  const d = v.replace(/\D/g, '');
  if (d.length !== 15 || !'12789'.includes(d[0])) return false;
  let soma = 0;
  for (let i = 0; i < 15; i++) soma += Number(d[i]) * (15 - i);
  return soma % 11 === 0;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface CasoFixture {
  id: string;
  grupo: string;
  text: string;
  pii: { kind: pii.PiiKind; value: string }[];
  realPii: boolean;
  nota?: string;
}
const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'pii-ptbr.json'), 'utf8')) as {
  format: string;
  cases: CasoFixture[];
};
const ESTRUTURADOS = new Set<pii.PiiKind>(pii.STRUCTURED_PII_KINDS);
const normVal = (kind: pii.PiiKind, v: string): string =>
  kind === 'email' ? v.toLowerCase() : v.toUpperCase().replace(/[^0-9A-Z]/g, '');

interface Placar {
  tp: number;
  fp: number;
  fn: number;
  porTipo: Record<string, { tp: number; fp: number; fn: number }>;
  erros: string[];
}

function medirEstruturados(): Placar {
  const p: Placar = { tp: 0, fp: 0, fn: 0, porTipo: {}, erros: [] };
  const tipo = (k: string) => (p.porTipo[k] ??= { tp: 0, fp: 0, fn: 0 });
  for (const c of FIXTURE.cases) {
    const achados = pii
      .scanPii(c.text)
      .findings.filter((f) => ESTRUTURADOS.has(f.kind))
      .map((f) => ({ kind: f.kind, key: `${f.kind}:${normVal(f.kind, f.text)}` }));
    const esperados = c.pii
      .filter((e) => ESTRUTURADOS.has(e.kind))
      .map((e) => ({ kind: e.kind, key: `${e.kind}:${normVal(e.kind, e.value)}` }));
    for (const e of esperados) {
      if (achados.some((a) => a.key === e.key)) {
        p.tp += 1;
        tipo(e.kind).tp += 1;
      } else {
        p.fn += 1;
        tipo(e.kind).fn += 1;
        p.erros.push(`FN ${c.id} ${e.key}`);
      }
    }
    for (const a of achados) {
      if (!esperados.some((e) => e.key === a.key)) {
        p.fp += 1;
        tipo(a.kind).fp += 1;
        p.erros.push(`FP ${c.id} ${a.key}`);
      }
    }
  }
  return p;
}

describe('IMPL-042 (1) — fixture PT-BR própria: recall ≥0,95 e precisão ≥0,90 (estruturados)', () => {
  it('a fixture tem ≥200 casos com válidos, inválidos, distratores, nomes e endereços', () => {
    expect(FIXTURE.format).toBe('pii-fixture-ptbr@1');
    expect(FIXTURE.cases.length).toBeGreaterThanOrEqual(200);
    const grupos = new Set(FIXTURE.cases.map((c) => c.grupo));
    for (const g of ['cpf-valido', 'cpf-invalido', 'cnpj-valido', 'cnpj-alfa', 'cnpj-invalido', 'cns-valido',
      'cns-invalido', 'rg-valido', 'cep-valido', 'tel-celular', 'tel-fixo', 'tel-distrator', 'email-pessoal',
      'distrator', 'nome-contexto', 'nome-livre', 'endereco', 'ficha', 'dificil', 'limitacao']) {
      expect(grupos.has(g), `grupo ${g} na fixture`).toBe(true);
    }
    const ids = FIXTURE.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const negativos = FIXTURE.cases.filter((c) => c.pii.every((e) => !ESTRUTURADOS.has(e.kind))).length;
    expect(negativos, 'distratores suficientes para medir precisão').toBeGreaterThanOrEqual(60);
  });

  it('os rótulos batem com um ORÁCULO independente de dígito verificador (não com o detector)', () => {
    let conferidos = 0;
    let invalidos = 0;
    for (const c of FIXTURE.cases) {
      for (const e of c.pii) {
        if (e.kind === 'cpf') expect(oraculoCpf(e.value), `${c.id} ${e.value}`).toBe(true);
        if (e.kind === 'cnpj') expect(oraculoCnpj(e.value), `${c.id} ${e.value}`).toBe(true);
        if (e.kind === 'cns') expect(oraculoCns(e.value), `${c.id} ${e.value}`).toBe(true);
        if (['cpf', 'cnpj', 'cns'].includes(e.kind)) conferidos += 1;
      }
      // Grupos "inválido": toda sequência do tamanho do documento FALHA no oráculo.
      if (c.nota === 'DV inválido') {
        const [re, alvo] = c.grupo.startsWith('cpf')
          ? [/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/g, oraculoCpf]
          : c.grupo.startsWith('cnpj')
            ? [/\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/g, oraculoCnpj]
            : [/\d{3} ?\d{4} ?\d{4} ?\d{4}/g, oraculoCns];
        const seqs = c.text.match(re) ?? [];
        expect(seqs.length, `${c.id}: documento no texto`).toBeGreaterThan(0);
        for (const s of seqs) expect(alvo(s), `${c.id}: "${s}" deveria ser inválido`).toBe(false);
        invalidos += seqs.length;
      }
    }
    expect(conferidos).toBeGreaterThanOrEqual(80);
    expect(invalidos).toBeGreaterThanOrEqual(15);
  });

  it('recall ≥ 0,95 e precisão ≥ 0,90 nos identificadores estruturados (limitações conhecidas contam)', () => {
    const p = medirEstruturados();
    const recall = p.tp / (p.tp + p.fn);
    const precisao = p.tp / (p.tp + p.fp);
    const detalhe = `${JSON.stringify(p.porTipo)}\n${p.erros.join('\n')}`;
    expect(recall, `recall ${recall.toFixed(3)}\n${detalhe}`).toBeGreaterThanOrEqual(0.95);
    expect(precisao, `precisão ${precisao.toFixed(3)}\n${detalhe}`).toBeGreaterThanOrEqual(0.9);
    // Honestidade da medida: a fixture traz casos FORA do alcance (número por
    // extenso, CPF quebrado em linhas) — um recall "perfeito" seria suspeito.
    expect(p.fn, 'os casos de limitação conhecida precisam aparecer como FN').toBeGreaterThan(0);
    // Todo tipo estruturado da lista do item aparece e tem recall próprio decente.
    for (const k of ['cpf', 'cnpj', 'cns', 'rg', 'cep', 'telefone']) {
      const t = p.porTipo[k];
      expect(t, `tipo ${k} medido`).toBeDefined();
      expect(t.tp / (t.tp + t.fn), `recall de ${k}`).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('dígito verificador: exemplos públicos e o CNPJ ALFANUMÉRICO da Receita (jul/2026)', () => {
    expect(pii.isValidCpf('529.982.247-25')).toBe(true);
    expect(pii.isValidCpf('529.982.247-26')).toBe(false);
    expect(pii.isValidCpf('111.111.111-11')).toBe(false);
    expect(pii.isValidCnpj('11.222.333/0001-81')).toBe(true);
    expect(pii.isValidCnpj('11.222.333/0001-82')).toBe(false);
    // Exemplo oficial do CNPJ alfanumérico — e o oráculo independente concorda.
    expect(pii.isValidCnpj('12.ABC.345/01DE-35')).toBe(true);
    expect(oraculoCnpj('12.ABC.345/01DE-35')).toBe(true);
    expect(pii.isValidCnpj('12.ABC.345/01DE-36')).toBe(false);
    for (let i = 0; i < 200; i++) {
      const base = String(100000000 + i * 4999919).slice(0, 9);
      const cpf = base + oraculoCpfDv(base);
      expect(pii.isValidCpf(cpf), cpf).toBe(oraculoCpf(cpf));
    }
  });
});

describe('IMPL-042 (2) — importação: aparência de dado real bloqueia nomeando o campo (FP ≤5%)', () => {
  it('na fixture: falso positivo do bloqueio ≤ 5% e o bloqueio pega as fichas/identificadores reais', () => {
    const negativos = FIXTURE.cases.filter((c) => !c.realPii);
    const positivos = FIXTURE.cases.filter((c) => c.realPii);
    const bloqueia = (c: CasoFixture) => pii.assessPii(pii.scanPii(c.text).findings).verdict === 'bloqueio';
    const fp = negativos.filter(bloqueia);
    const taxaFp = fp.length / negativos.length;
    expect(taxaFp, `FP: ${fp.map((c) => c.id).join(', ')}`).toBeLessThanOrEqual(0.05);
    const pegos = positivos.filter(bloqueia).length / positivos.length;
    expect(pegos, 'bloqueio que nunca bloqueia também teria FP 0%').toBeGreaterThanOrEqual(0.9);
    // Negativos incluem o que MAIS confunde: CNPJ/telefone/endereço de empresa,
    // exemplos notórios, placeholders e personas.
    expect(negativos.some((c) => c.grupo === 'negocio')).toBe(true);
    expect(negativos.some((c) => c.grupo === 'persona')).toBe(true);
  });

  const PACOTE = {
    format: 'prompt-builder-pack@1',
    theme: 'suporte',
    exportedAt: '2026-09-27T10:00:00.000Z',
    prompt: { text: 'Você é um atendente.', source: 'base' },
    scenarios: [
      { id: 'sc-1', question: 'Qual o prazo de entrega?', productContext: 'Entrega em 5 dias.', maxTokens: 200, rubric: '' },
      {
        id: 'sc-2',
        question: 'Meu CPF é 529.982.247-25, cadê meu pedido?',
        productContext: 'Pedidos consultados por CPF.',
        maxTokens: 200,
        rubric: '',
      },
    ],
  };

  it('pacote de cenários: bloqueado com o campo nomeado; nada corrigido; `allowPii` libera', () => {
    const r = parseScenarioPack(PACOTE);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('scenarios[1].question');
    expect(r.error).toContain('CPF');
    expect(r.error).toMatch(/Nada foi corrigido/);
    expect(r.pii?.blocked.map((b) => b.path)).toEqual(['scenarios[1].question']);
    const liberado = parseScenarioPack(PACOTE, { allowPii: true });
    expect(liberado.ok).toBe(true);
    // Sem correção silenciosa: o texto importado segue idêntico.
    if (liberado.ok) expect(liberado.pack.scenarios[1].question).toBe(PACOTE.scenarios[1].question);
  });

  const CONFIG_ARQ = {
    format: 'arena-config@1',
    mode: 'variation',
    theme: 'suporte',
    prompt: { text: 'Você atende a titular Fernanda Costa, celular (11) 97351-2846.' },
    models: { datagen: 'x/gen', judges: ['x/judge'], contestant: 'x/a' },
    variation: { optimize: true, techniques: ['persona', 'constraints'] },
    piiMode: 'synthetic',
  };

  it('arena-config (Node e SPA): mesmo bloqueio, campo nomeado, e `piiMode` chega ao RunConfig', () => {
    for (const parse of [parseArenaConfig, parseArenaConfigWeb]) {
      const r = parse(CONFIG_ARQ);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error).toContain('prompt.text');
      expect(r.error).toMatch(/nome \+ telefone|telefone/);
      expect(r.error).toContain('nomes: não coberto');
    }
    // "Revisei" na importação: o arquivo passa e a revisão é GRAVADA no config…
    const ok = parseArenaConfig(CONFIG_ARQ, { allowPii: true });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.config.allowPii).toBe(true);
    // …mas "só sintético" não tem exceção: a conversão p/ RunConfig recusa,
    // nomeando o campo (o prompt vira basePrompt).
    const sintetico = arenaConfigToRunConfig(ok.config);
    expect(sintetico.ok).toBe(false);
    if (!sintetico.ok) {
      expect(sintetico.error).toMatch(/só sintético/);
      expect(sintetico.error).toContain('basePrompt');
    }
    // No "redigir", a revisão segue até o RunConfig (e o pré-voo a respeita).
    const { piiMode: _modo, ...redigir } = CONFIG_ARQ;
    const okRedigir = parseArenaConfig(redigir, { allowPii: true });
    expect(okRedigir.ok).toBe(true);
    if (!okRedigir.ok) return;
    const conv = arenaConfigToRunConfig(okRedigir.config);
    expect(conv.ok, conv.ok ? '' : conv.error).toBe(true);
    if (conv.ok) expect(conv.config.allowPii).toBe(true);
    // `piiMode` chega ao RunConfig num arquivo limpo.
    const limpo = parseArenaConfig({ ...CONFIG_ARQ, prompt: { text: 'Você é um atendente cordial.' } });
    expect(limpo.ok).toBe(true);
    if (limpo.ok) {
      const c = arenaConfigToRunConfig(limpo.config);
      expect(c.ok && c.config.piiMode).toBe('synthetic');
    }
    // O schema do servidor (routes/MCP) também aceita o campo (não o descarta).
    const cfg = parseRunConfig({
      mode: 'compare',
      theme: 't',
      stages: 1,
      datagenModelId: 'x/g',
      judgeModelIds: ['x/j'],
      competitorModelIds: ['x/a', 'x/b'],
      piiMode: 'synthetic',
    });
    expect(cfg.ok && cfg.config.piiMode).toBe('synthetic');
  });

  it('SPA: import unificado (array cru de cenários) bloqueia e aponta o campo', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
    try {
      const { readImportFile } = await import('../web/src/api.js');
      const arquivo = new File(
        [JSON.stringify([
          { question: 'Oi', productContext: 'Loja.' },
          { question: 'Me liga no (21) 98822-4471', productContext: 'Loja.' },
        ])],
        'cenarios.json',
      );
      const r = await readImportFile(arquivo);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain('cenarios[1].question');
        expect(r.pii?.ok).toBe(false);
      }
      const ok = await readImportFile(arquivo, { allowPii: true });
      expect(ok.ok).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('biblioteca: item com dado real é recusado (aviso com o campo); os demais entram', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pb-impl042-lib-'));
    const antes = getDataDir();
    setDataDir(tmp);
    try {
      const itens = [
        { id: 'ok-1', title: 'ok', tier: 'mft', question: 'Qual o horário?', productContext: 'Das 8h às 18h.', maxTokens: 200, reference: 'Das 8h às 18h.' },
        { id: 'pii-1', title: 'pii', tier: 'mft', question: 'Meu CPF é 529.982.247-25, cadê o laudo?', productContext: 'x', maxTokens: 200, reference: 'y' },
      ];
      const r = await importItems('perfil', itens);
      expect(r.added).toBe(1);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toMatch(/^item 2: Importação bloqueada \(LGPD\).*question \(CPF\)/);
      expect((await listItems('perfil')).map((i) => i.id)).toEqual(['ok-1']);
      const r2 = await importItems('perfil', itens, { allowPii: true });
      expect(r2.errors).toEqual([]);
    } finally {
      setDataDir(antes);
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('IMPL-042 (4) — nomes em texto livre: `nao-coberto`, sem promessa de recall', () => {
  it('a cobertura declara nomes/endereços como não cobertos e os achados carregam a marca', () => {
    expect(pii.PII_COVERAGE.nome).toBe('nao-coberto');
    expect(pii.PII_COVERAGE.endereco).toBe('nao-coberto');
    for (const k of pii.STRUCTURED_PII_KINDS) expect(pii.PII_COVERAGE[k]).toBe('coberto');
    expect(pii.STRUCTURED_PII_KINDS).not.toContain('nome');
    const f = pii.scanPii('Paciente Maria Souza chegou.').findings;
    expect(f).toEqual([expect.objectContaining({ kind: 'nome', layer: 'contextual', coverage: 'nao-coberto' })]);
  });

  it('o recall de nomes é RELATADO, não prometido: nomes fora do dicionário escapam', () => {
    const casos = FIXTURE.cases.flatMap((c) => c.pii.filter((e) => e.kind === 'nome').map((e) => ({ c, e })));
    const achados = casos.filter(({ c, e }) =>
      pii.scanPii(c.text).findings.some((f) => f.kind === 'nome' && f.text === e.value),
    ).length;
    const recallNomes = achados / casos.length;
    // Sem piso: só a prova de que a camada funciona E de que ela falha (a
    // fixture tem nomes indígenas/raros e apelidos, como na vida real).
    expect(recallNomes).toBeGreaterThan(0);
    expect(recallNomes).toBeLessThan(1);
  });

  it('o gateway NÃO reescreve nome (heurística mudaria o benchmark em silêncio): só conta', () => {
    const guard = pii.createPiiGuard({ key: 's' });
    const [m] = guard.protect([{ role: 'user', content: 'Paciente Maria Souza, sem documento.' }]);
    expect(m.content).toBe('Paciente Maria Souza, sem documento.');
    expect(guard.stats().contextualSeen).toBe(1);
    expect(guard.stats().redactedCalls).toBe(0);
  });
});

describe('IMPL-042 — pseudonimização (token estável por escopo, HMAC com chave secreta)', () => {
  it('mesmo documento em formatos diferentes ⇒ mesmo token; chave diferente ⇒ token diferente', () => {
    const v = new pii.PiiVault({ key: 'run-1' });
    const a = v.redact('CPF 529.982.247-25').text;
    const b = v.redact('cpf: 52998224725').text;
    const tokA = /\[CPF_[0-9a-f]{12}\]/.exec(a)?.[0];
    expect(tokA).toBeDefined();
    expect(b).toContain(tokA!);
    expect(new pii.PiiVault({ key: 'run-2' }).redact('CPF 529.982.247-25').text).not.toContain(tokA!);
    // O token não é re-detectado quando a resposta volta ao juiz.
    expect(pii.scanPii(`O ${tokA} foi localizado`).findings).toEqual([]);
    // Telefone com e sem +55 é a mesma pessoa.
    expect(v.redact('+55 (11) 97351-2846').text).toBe(v.redact('(11) 97351-2846').text);
  });

  it('placeholder, exemplo notório e número de serviço seguem intactos (não são pessoa)', () => {
    const v = new pii.PiiVault({ key: 'x' });
    const texto = 'Formato (11) 99999-9999, exemplo 123.456.789-09, usuario@example.com, 0800 123 4567, 4004-0001.';
    expect(v.redact(texto).text).toBe(texto);
  });
});

// ---------------------------------------------------------------------------
// (3) Nenhuma chamada de LLM sem a cascata
// ---------------------------------------------------------------------------

function arquivosTs(dir: string): string[] {
  const out: string[] = [];
  for (const nome of readdirSync(dir)) {
    const p = join(dir, nome);
    if (statSync(p).isDirectory()) {
      if (nome === 'node_modules' || nome === 'data' || nome === 'dist') continue;
      out.push(...arquivosTs(p));
    } else if (/\.(ts|tsx)$/.test(nome)) out.push(p);
  }
  return out;
}

describe('IMPL-042 (3) — prova ESTÁTICA: o ponto único é o único caminho até /chat/completions', () => {
  it('só src/openrouter.ts fala com /chat/completions (Node e SPA)', () => {
    const quem = [...arquivosTs(join(ROOT, 'src')), ...arquivosTs(join(ROOT, 'web', 'src'))]
      .filter((f) => readFileSync(f, 'utf8').includes('/chat/completions'))
      .map((f) => f.slice(ROOT.length));
    expect(quem).toEqual(['src/openrouter.ts']);
  });

  it('em src/openrouter.ts todo POST de chat usa o corpo de buildBody, e buildBody passa pela cascata', () => {
    const fonte = readFileSync(join(ROOT, 'src', 'openrouter.ts'), 'utf8');
    const posts = fonte.match(/\/chat\/completions`,\s*\{[^}]*\}/g) ?? [];
    expect(posts.length).toBe(2); // chatCompletion + chatCompletionStream
    for (const p of posts) expect(p).toContain('body: JSON.stringify(body)');
    expect(fonte.match(/const body = this\.buildBody\(/g)?.length).toBe(2);
    const buildBody = /private buildBody\([\s\S]*?\n {2}\}\n/.exec(fonte)?.[0] ?? '';
    expect(buildBody).toContain('messages: this.protectMessages(messages, params.sink)');
    // A ÚNICA chave `messages` do corpo é a protegida, e ninguém a reescreve depois.
    expect(buildBody.match(/\bmessages\s*:/g)).toEqual(['messages:']);
    expect(fonte).not.toMatch(/\.messages\s*=|\[['"]messages['"]\]\s*=/);
    expect(fonte).toMatch(
      /private protectMessages\([^)]*\)[^{]*\{\s*return this\.piiGuard\.protect\(messages, piiScopeOf\(sink\)\);/,
    );
  });

  it('o shim do web é o MESMO gateway (a SPA não tem caminho próprio)', async () => {
    const web = await import('../web/src/engine/openrouter.js');
    const node = await import('../src/openrouter.js');
    expect(web.chatCompletion).toBe(node.chatCompletion);
    expect(web.chatCompletionStream).toBe(node.chatCompletionStream);
  });
});

describe('IMPL-042 (3) — prova DINÂMICA no gateway (chat e stream)', () => {
  it('as duas portas redigem antes do fetch e contam 1 varredura por requisição', async () => {
    const fake = fakeOpenRouter({ chat: () => ({ text: 'ok' }) });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    await gw.chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: [{ role: 'user', content: 'CPF 529.982.247-25' }] });
    await gw.chatCompletionStream({
      apiKey: KEY,
      modelId: 'x/y',
      messages: [
        { role: 'system', content: 'Titular: joana.prado@gmail.com' },
        { role: 'user', content: 'meu cpf: 52998224725' },
      ],
    });
    const [r1, r2] = fake.chatRequests();
    const tok = /\[CPF_[0-9a-f]{12}\]/.exec(r1.user)?.[0];
    expect(tok).toBeDefined();
    expect(r2.user).toContain(tok!);
    expect(r2.system).toMatch(/\[EMAIL_[0-9a-f]{12}\]/);
    const corpo = JSON.stringify(fake.chatRequests().map((r) => r.body));
    for (const cru of ['529.982.247-25', '52998224725', 'joana.prado@gmail.com']) expect(corpo).not.toContain(cru);
    expect(gw.piiStats()).toMatchObject({ scannedCalls: 2, scannedMessages: 3, redactedCalls: 2 });
  });
});

// Valores sintéticos com DV válido, gerados pelo ORÁCULO (não pelo detector).
const CPF_1 = (() => {
  const b = '318276450';
  const c = b + oraculoCpfDv(b);
  return `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}`;
})();
const CPF_2 = (() => {
  const b = '604913827';
  return b + oraculoCpfDv(b);
})();
const CPF_3 = (() => {
  const b = '247105963';
  return b + oraculoCpfDv(b);
})();
const CEL_1 = '(11) 97351-2846';
const CEL_2 = '(31) 98822-4471';
const EMAIL_1 = 'joana.prado@gmail.com';

/** Toda forma crua que NÃO pode aparecer em nenhum corpo de requisição. */
const CRUS = [CPF_1, CPF_1.replace(/\D/g, ''), CPF_2, CPF_3, CEL_1, '97351-2846', CEL_2, '98822-4471', EMAIL_1];

const M = { gen: 'fake/gen', ref: 'fake/ref', judge: 'fake/judge', a: 'fake/a', opt: 'fake/opt' };

type Papel = 'datagen' | 'gabarito' | 'competitor' | 'judge' | 'duel' | 'rewriter';
function papelDe(req: FakeRequest): Papel {
  if (req.model === M.gen) return 'datagen';
  if (req.model === M.ref) return 'gabarito';
  if (req.model === M.opt) return 'rewriter';
  if (req.stream) return 'competitor';
  return req.system.includes('DUELO') ? 'duel' : 'judge';
}

/**
 * O fake DEVOLVE dado pessoal em todo papel que gera texto (cenário do datagen,
 * gabarito, resposta do competidor, prompt reescrito): assim a prova cobre o
 * dado que NASCE no meio do pipeline, não só o que o usuário digitou.
 */
function fakeComPii(): FakeOpenRouter {
  return fakeOpenRouter({
    catalog: Object.values(M).map((id) => catalogItem(id, 1e-6, 1e-6)),
    chat: (req, n) => {
      const usage = { prompt_tokens: 50, completion_tokens: 10, cost: 0.0001 * (n + 1) };
      if (req.model === M.gen) {
        return {
          text: JSON.stringify({
            stages: [
              { question: `Sou o paciente de CPF ${CPF_3}, preciso da 2a via.`, productContext: 'Segunda via em 24h.', maxTokens: 300, rubric: 'Prazo.' },
              { question: 'Posso levar acompanhante?', productContext: 'Um acompanhante.', maxTokens: 300, rubric: 'Um.' },
            ],
          }),
          usage,
        };
      }
      if (req.model === M.opt) {
        const tecnica = /tecnica id="([^"]+)"/.exec(req.user)?.[1] ?? 'x';
        return {
          text: `Voce e um atendente cordial e preciso (${tecnica}). Responda com base no contexto do produto e, em caso de duvida, oriente a ligar para ${CEL_2}; recuse o que estiver fora do escopo.`,
          usage,
        };
      }
      if (req.model === M.ref) return { text: `Gabarito: confirme o CPF ${CPF_2} e o prazo.`, usage };
      if (req.stream) return { text: `Localizei o cadastro do CPF ${CPF_2}; prazo confirmado.`, usage };
      if (req.system.includes('DUELO')) return { text: '{"winner":"A","explanation":"A melhor"}', usage };
      return { text: '{"verdict":"resolve","explanation":"confere"}', usage };
    },
  });
}

function treino(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'training',
    theme: `suporte de clinica — titular de contato ${EMAIL_1}`,
    stages: 2,
    datagenModelId: M.gen,
    judgeModelIds: [M.judge],
    referenceModelId: M.ref,
    referenceJudging: true,
    contestantModelId: M.a,
    basePrompt: `Voce e um atendente. Cliente de teste: CPF ${CPF_1}, celular ${CEL_1}. Responda com base no contexto do produto.`,
    scenarioSeed: [
      { question: `Meu CPF e ${CPF_2}, qual o status do exame?`, productContext: `Central do paciente: ${CEL_1}.`, maxTokens: 300, rubric: 'Status.' },
    ],
    techniqueIds: ['persona', 'constraints'],
    promptOptimization: true,
    optimizerModelId: M.opt,
    iterations: 1,
    holdoutRatio: 0,
    finalists: 2,
    timeoutMs: 5_000,
    ...extra,
  };
}

function conferirSemPii(fake: FakeOpenRouter, gw: OpenRouterGateway): void {
  const chats = fake.chatRequests();
  expect(chats.length).toBeGreaterThan(0);
  const papeis = new Set(chats.map(papelDe));
  expect([...papeis].sort()).toEqual(['competitor', 'datagen', 'duel', 'gabarito', 'judge', 'rewriter']);
  for (const req of chats) {
    const corpo = JSON.stringify(req.body);
    for (const cru of CRUS) expect(corpo, `${papelDe(req)} vazou "${cru}"`).not.toContain(cru);
  }
  // Pseudonimizado, não apagado: o token aparece no papel que recebeu o dado.
  for (const p of ['datagen', 'rewriter', 'competitor', 'gabarito', 'judge'] as Papel[]) {
    expect(
      chats.some((r) => papelDe(r) === p && /\[(CPF|TELEFONE|EMAIL)_[0-9a-f]{12}\]/.test(JSON.stringify(r.body))),
      `papel ${p} recebeu token`,
    ).toBe(true);
  }
  // 1 varredura por requisição: NENHUMA chamada escapou da cascata.
  expect(gw.piiStats().scannedCalls).toBe(chats.length);
}

describe('IMPL-042 (3) — prova DINÂMICA nos 6 papéis, Node e SPA (dado do usuário E dado gerado)', () => {
  let tmp: string;
  let dirAnterior: string;
  let silencio: Array<{ mockRestore(): void }> = [];
  const restaurar: Array<() => void> = [];

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pb-impl042-'));
    dirAnterior = getDataDir();
    setDataDir(tmp);
    silencio = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
  });
  afterEach(() => {
    while (restaurar.length) restaurar.pop()!();
  });
  afterAll(() => {
    silencio.forEach((s) => s.mockRestore());
    setDataDir(dirAnterior);
    rmSync(tmp, { recursive: true, force: true });
  });

  function comFake(): { fake: FakeOpenRouter; gw: OpenRouterGateway } {
    const fake = fakeComPii();
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    const anterior = setDefaultGateway(gw);
    restaurar.push(() => setDefaultGateway(anterior));
    return { fake, gw };
  }

  async function esperarSessao(sessionId: string, record: { status: string }): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('sessão não terminou')), 10_000);
      const fim = (): void => {
        clearTimeout(t);
        unsub();
        resolve();
      };
      const unsub = subscribeSession(sessionId, (e) => {
        if (e.type === 'session.finished' || e.type === 'session.error') fim();
      });
      if (record.status !== 'running') fim();
    });
  }

  it('"redigir" SEM revisão (Node e SPA): dado real no config recusa antes de qualquer LLM, nomeando o campo', async () => {
    const node = comFake();
    const rec = await trainNode(treino() as unknown as TrainingConfig, KEY);
    expect(rec.status).toBe('error');
    expect(rec.error).toContain('basePrompt (CPF + telefone)');
    expect(rec.error).toMatch(/allowPii: true/);
    expect(rec.error).toMatch(/nomes em texto livre NÃO são cobertos/);
    expect(node.fake.chatRequests()).toEqual([]);
    while (restaurar.length) restaurar.pop()!();

    const web = comFake();
    const { sessionId, record } = await startWebTraining(treino() as never, KEY);
    await esperarSessao(sessionId, record);
    expect(record.status).toBe('error');
    expect(record.error).toContain('scenarioSeed[0].question (CPF)');
    expect(web.fake.chatRequests()).toEqual([]);
  });

  it('Node (trainer + orchestrator): modo redigir REVISADO roda inteiro e nenhum corpo leva o dado cru', async () => {
    const { fake, gw } = comFake();
    const rec = await trainNode(treino({ allowPii: true }) as unknown as TrainingConfig, KEY);
    expect(rec.status, rec.error).toBe('finished');
    conferirSemPii(fake, gw);
  });

  it('SPA (trainer + orchestrator client-side): mesma garantia pelo mesmo gateway', async () => {
    const { fake, gw } = comFake();
    const { sessionId, record } = await startWebTraining(treino({ allowPii: true }) as never, KEY);
    await esperarSessao(sessionId, record);
    expect(record.status, record.error).toBe('finished');
    conferirSemPii(fake, gw);
  });

  it('"só sintético" (Node e SPA): dado real no config recusa ANTES de qualquer LLM, nomeando o campo', async () => {
    const node = comFake();
    const rec = await trainNode(treino({ piiMode: 'synthetic' }) as unknown as TrainingConfig, KEY);
    expect(rec.status).toBe('error');
    expect(rec.error).toMatch(/só sintético/);
    expect(rec.error).toContain('basePrompt (CPF + telefone)');
    expect(rec.error).toContain('scenarioSeed[0].question');
    expect(node.fake.chatRequests()).toEqual([]);
    while (restaurar.length) restaurar.pop()!();

    const web = comFake();
    const { sessionId, record } = await startWebTraining(treino({ piiMode: 'synthetic' }) as never, KEY);
    await esperarSessao(sessionId, record);
    expect(record.status).toBe('error');
    expect(record.error).toContain('basePrompt');
    expect(web.fake.chatRequests()).toEqual([]);
    while (restaurar.length) restaurar.pop()!();

    // run avulsa (compare) também: o pré-voo é o do orquestrador.
    const avulsa = comFake();
    const cfg = {
      mode: 'compare',
      theme: `atendimento — responsável ${EMAIL_1}`,
      stages: 1,
      datagenModelId: M.gen,
      judgeModelIds: [M.judge],
      competitorModelIds: [M.a, M.ref],
      piiMode: 'synthetic',
      timeoutMs: 5_000,
    };
    for (const run of [runNode, runWeb] as const) {
      const r = await run(cfg as never, KEY, {});
      expect(r.status).toBe('error');
      expect(r.error).toContain('theme (e-mail)');
    }
    expect(avulsa.fake.chatRequests()).toEqual([]);
  });

  it('"só sintético" com config limpo roda; o dado que o LLM gera no meio NÃO derruba as runs da sessão', async () => {
    const { fake, gw } = comFake();
    const limpo = treino({
      piiMode: 'synthetic',
      theme: 'suporte de clinica',
      basePrompt: 'Voce e um atendente. Responda com base no contexto do produto.',
      scenarioSeed: [{ question: 'Qual o status do exame?', productContext: 'Resultados em 3 dias.', maxTokens: 300, rubric: 'Status.' }],
    });
    const rec = await trainNode(limpo as unknown as TrainingConfig, KEY);
    expect(rec.status, rec.error).toBe('finished');
    // O CPF que o datagen/competidor inventou foi pseudonimizado no envio.
    for (const req of fake.chatRequests()) {
      expect(JSON.stringify(req.body)).not.toContain(CPF_2);
      expect(JSON.stringify(req.body)).not.toContain(CPF_3);
    }
    expect(gw.piiStats().scannedCalls).toBe(fake.chatRequests().length);
  });

  it('pré-voo exportado: Node e SPA recusam igual (PiiPolicyError reconhecido sem instanceof)', async () => {
    const cfg = { mode: 'compare', theme: 'x', basePrompt: `CPF ${CPF_1}`, piiMode: 'synthetic' } as const;
    for (const enforce of [nodeLgpd.enforceRunCompliance, webLgpd.enforceRunCompliance]) {
      const erro = await enforce(cfg).catch((e: unknown) => e);
      expect(pii.isPiiPolicyError(erro)).toBe(true);
      // "só sintético" ignora a revisão manual.
      expect(pii.isPiiPolicyError(await enforce({ ...cfg, allowPii: true }).catch((e: unknown) => e))).toBe(true);
      // Aninhada (iteração de sessão): só relata — o config da sessão já passou.
      const aninhada = await enforce(cfg, Date.now(), { nested: true });
      expect(aninhada.piiReport?.fields).toEqual([{ path: 'basePrompt', kinds: ['cpf'], verdict: 'bloqueio' }]);
      // "redigir": recusa sem revisão; com `allowPii`, segue e RELATA (campo + tipo, nunca o valor).
      const semRevisao = await enforce({ ...cfg, piiMode: 'redact' }).catch((e: unknown) => e);
      expect(pii.isPiiPolicyError(semRevisao)).toBe(true);
      const revisado = await enforce({ ...cfg, piiMode: 'redact', allowPii: true });
      expect(revisado.piiReport).toEqual({
        mode: 'redact',
        allowPii: true,
        fields: [{ path: 'basePrompt', kinds: ['cpf'], verdict: 'bloqueio' }],
      });
      expect(JSON.stringify(revisado.piiReport)).not.toContain(CPF_1);
    }
    expect(webLgpd.scanPii).toBe(pii.scanPii); // shim: fonte única
  });
});

// ===========================================================================
// Correções da revisão independente do IMPL-042
// ===========================================================================

describe('IMPL-042 (revisão) — token é PRF com chave: par conhecido não prevê outro token', () => {
  it('SHA-256 e HMAC-SHA-256 puros batem com node:crypto (vazio, multi-bloco, chave > 64 bytes, UTF-8)', () => {
    const enc = (t: string) => new TextEncoder().encode(t);
    const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
    const msgs = ['', 'abc', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'w'.repeat(200), 'cpf|52998224725', 'ação — São Paulo'];
    for (const m of msgs) {
      expect(hex(pii.sha256(enc(m))), `sha256(${m.slice(0, 12)})`).toBe(createHash('sha256').update(m).digest('hex'));
      for (const k of ['k', 'chave-secreta', 'K'.repeat(64), 'L'.repeat(130)]) {
        expect(hex(pii.hmacSha256(enc(k), enc(m)))).toBe(createHmac('sha256', k).update(m).digest('hex'));
      }
    }
    // O token É o HMAC truncado (nada de hash não-criptográfico no caminho).
    const v = new pii.PiiVault({ key: 'k' });
    const esperado = createHmac('sha256', 'k').update('cpf|52998224725').digest('hex').slice(0, pii.PII_TOKEN_HEX);
    expect(v.tokenFor({ kind: 'cpf', text: '529.982.247-25' })).toBe(`[CPF_${esperado}]`);
  });

  it('o ataque da revisão (inverter FNV-1a a partir de UM par conhecido) não prevê mais nada', () => {
    // Reprodução do teste de rascunho da revisão: com FNV-1a, o par (CPF que o
    // próprio provedor gerou → token) devolvia o estado pós-sal e dava o token
    // de QUALQUER outro CPF. Aqui o mesmo ataque tem de falhar.
    const P = 0x01000193n;
    const MOD = 1n << 32n;
    const inv = (a: bigint, m: bigint): bigint => {
      let [g, x, g2, x2] = [a, 1n, m, 0n];
      while (g2 !== 0n) {
        const q = g / g2;
        [g, g2] = [g2, g - q * g2];
        [x, x2] = [x2, x - q * x2];
      }
      return ((x % m) + m) % m;
    };
    const PINV = inv(P, MOD);
    const fnvFrom = (h: number, t: string): number => {
      for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193) >>> 0;
      return h >>> 0;
    };
    const unfnv = (h: number, t: string): number => {
      let x = BigInt(h);
      for (let i = t.length - 1; i >= 0; i--) x = ((x * PINV) % MOD) ^ BigInt(t.charCodeAt(i));
      return Number(x);
    };
    const vault = new pii.PiiVault(); // chave aleatória, como em produção
    const tok = (cpf: string) => /\[CPF_([0-9a-f]+)\]/.exec(vault.redact(`CPF ${cpf}`).text)![1];
    const conhecido = '52998224725';
    const segredo = CPF_1.replace(/\D/g, '');
    const alvo = tok(segredo);
    // Tentativas do atacante com o par conhecido: estado pós-"sal" (FNV) e
    // "hash sem chave" — nenhuma reproduz o token do segredo.
    for (const sufixo of [`|cpf|${conhecido}`, `cpf|${conhecido}`]) {
      const estado = unfnv(parseInt(tok(conhecido).slice(0, 8), 16), sufixo);
      const previsto = fnvFrom(estado, sufixo.replace(conhecido, segredo)).toString(16).padStart(8, '0');
      expect(alvo.startsWith(previsto)).toBe(false);
    }
    expect(alvo).not.toBe(createHash('sha256').update(`cpf|${segredo}`).digest('hex').slice(0, pii.PII_TOKEN_HEX));
    // Duas instâncias (chaves aleatórias) nunca concordam: não há dicionário
    // pré-computável do espaço de CPFs.
    expect(new pii.PiiVault().tokenFor({ kind: 'cpf', text: segredo })).not.toBe(
      new pii.PiiVault().tokenFor({ kind: 'cpf', text: segredo }),
    );
  });

  it('cofre por RUN/SESSÃO: mesmo escopo (e forks do ledger) = mesmo token; runs diferentes = sem ligação', async () => {
    const fake = fakeOpenRouter({ chat: () => ({ text: 'ok' }) });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    const sessao = new BudgetLedger();
    const iteracao1 = sessao.fork();
    const iteracao2 = sessao.fork();
    const outraRun = new BudgetLedger();
    const msg = [{ role: 'user' as const, content: `CPF ${CPF_1}` }];
    for (const sink of [iteracao1, iteracao2, outraRun]) {
      await gw.chatCompletion({ apiKey: KEY, modelId: 'x/y', messages: msg, sink });
    }
    const [a, b, c] = fake.chatRequests().map((r) => /\[CPF_[0-9a-f]+\]/.exec(r.user)?.[0]);
    expect(a).toBeDefined();
    expect(b).toBe(a); // gabarito da iteração 1 e competidor da 2 seguem comparáveis
    expect(c).not.toBe(a); // outra run (outro usuário no servidor) não liga ao mesmo titular
    // O que o ground truth compara localmente usa o MESMO token do envio.
    expect(gw.pseudonymize(CPF_1, iteracao2)).toBe(a);
  });
});

describe('IMPL-042 (revisão) — modo agente fora da cascata ⇒ fail-closed ("só sintético")', () => {
  const agente = {
    executor: 'pi',
    executorVersion: '1.0.0',
    limits: { maxCostUsd: 1 },
  } as const;
  const cfgAgente = {
    mode: 'variation',
    theme: 'correção de bug',
    stages: 1,
    datagenModelId: 'x/g',
    judgeModelIds: ['x/j'],
    contestantModelId: 'x/a',
    basePrompt: 'Você corrige bugs.',
    techniqueIds: ['persona', 'constraints'],
    agent: agente,
    customStages: [
      {
        question: `O cadastro do CPF ${CPF_1} quebra o formulário; corrija.`,
        productContext: 'Formulário de cadastro.',
        agentTask: { contextFiles: false, verify: [{ cmd: 'true' }] },
      },
    ],
  };

  it('pré-voo (Node e SPA) recusa mesmo com `allowPii` — nomeia o campo e diz por quê', async () => {
    for (const enforce of [nodeLgpd.enforceRunCompliance, webLgpd.enforceRunCompliance]) {
      const erro = await enforce({ ...cfgAgente, allowPii: true } as never).catch((e: unknown) => e);
      expect(pii.isPiiPolicyError(erro)).toBe(true);
      expect((erro as Error).message).toMatch(/Modo agente recusou a run/);
      expect((erro as Error).message).toContain('customStages[0].question (CPF)');
      expect((erro as Error).message).toMatch(/FORA da cascata/);
      // Config de agente limpo passa.
      const limpo = { ...cfgAgente, customStages: [{ ...cfgAgente.customStages[0], question: 'O formulário quebra; corrija.' }] };
      await expect(enforce(limpo as never)).resolves.toBeDefined();
    }
  });

  it('importação: RunConfig de agente e arena-agent-config@1 com dado real são recusados no parse', () => {
    const cru = parseRunConfig({ ...cfgAgente, allowPii: true });
    expect(cru.ok).toBe(false);
    if (!cru.ok) expect(cru.error).toMatch(/Modo agente recusou/);
    const arquivo = {
      format: 'arena-agent-config@1',
      mode: 'compare',
      theme: 'correção de bug',
      agent: agente,
      models: { datagen: 'x/g', judges: ['x/j'], competitors: ['x/a', 'x/b'] },
      scenarios: [{ question: `Paciente de celular ${CEL_1} não consegue logar.`, agentTask: { verify: [{ cmd: 'true' }] } }],
    };
    const lido = parseArenaAgentConfig(arquivo);
    expect(lido.ok, lido.ok ? '' : lido.error).toBe(true);
    if (!lido.ok) return;
    const conv = arenaAgentConfigToRunConfig(lido.config);
    expect(conv.ok).toBe(false);
    if (!conv.ok) {
      expect(conv.error).toMatch(/Modo agente recusou/);
      expect(conv.error).toMatch(/customStages\[0\]\.question|scenarioSeed\[0\]\.question/);
    }
  });
});

describe('IMPL-042 (revisão) — RunConfig CRU também é importação (CLI/MCP/HTTP)', () => {
  const FICHA = `Paciente João Silva, CPF ${CPF_1}, celular ${CEL_1}: cadê meu laudo?`;
  const cru = {
    mode: 'compare',
    theme: 'suporte',
    stages: 1,
    datagenModelId: 'x/g',
    judgeModelIds: ['x/j'],
    competitorModelIds: ['x/a', 'x/b'],
    customStages: [{ question: FICHA, productContext: 'Laudos em 3 dias.', maxTokens: 200 }],
  };

  it('parseRunConfig (CLI --config/flags, MCP, rotas de agente) bloqueia nomeando o campo; `allowPii` libera', () => {
    const r = parseRunConfig(cru);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('customStages[0].question (nome + CPF + telefone — nomes: não coberto)');
      expect(r.error).toMatch(/Nada foi enviado/);
    }
    const ok = parseRunConfig({ ...cru, allowPii: true });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.config.customStages?.[0].question).toBe(FICHA); // nada corrigido
    // "só sintético" não aceita a revisão manual.
    expect(parseRunConfig({ ...cru, allowPii: true, piiMode: 'synthetic' }).ok).toBe(false);
  });

  it('o schema das rotas HTTP (POST /runs e /sessions) recusa igual', () => {
    const r = runConfigSchema.safeParse(cru);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.flatten().formErrors.join(' ')).toContain('customStages[0].question');
    expect(runConfigSchema.safeParse({ ...cru, allowPii: true }).success).toBe(true);
  });

  it('`config validate raw.json`: exit 3 (config) com o campo; com `allowPii` no arquivo, válido', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pb-impl042-cli-'));
    const antes = getDataDir();
    const silencio = [
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
    ];
    try {
      const arq = join(tmp, 'raw.json');
      writeFileSync(arq, JSON.stringify(cru));
      const erro = await cmdConfig(['validate', arq, '--data-dir', tmp, '--json']).catch((e: unknown) => e);
      expect(erro).toMatchObject({ code: 3 });
      expect((erro as Error).message).toContain('customStages[0].question');
      writeFileSync(arq, JSON.stringify({ ...cru, allowPii: true }));
      await expect(cmdConfig(['validate', arq, '--data-dir', tmp, '--json'])).resolves.toBe(0);
    } finally {
      silencio.forEach((s) => s.mockRestore());
      setDataDir(antes);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('`runs reproduce` (vista arena-config) preserva `piiMode` e a revisão `allowPii`', () => {
    const cfg = { ...cru, customStages: undefined, piiMode: 'synthetic', allowPii: true } as unknown as RunConfig;
    const arena = runConfigToArenaConfig(cfg);
    expect(arena.piiMode).toBe('synthetic');
    expect(arena.allowPii).toBe(true);
    const volta = parseArenaConfig(arena);
    expect(volta.ok).toBe(true);
    if (volta.ok) {
      const conv = arenaConfigToRunConfig(volta.config);
      expect(conv.ok && conv.config.piiMode).toBe('synthetic');
    }
  });
});

describe('IMPL-042 (revisão) — "ficha" pede identificador FORTE ou ≥2 dados fracos de titular (persona não conta)', () => {
  const veredito = (t: string) => pii.assessPii(pii.scanPii(t).findings);

  it('personas de duas palavras e contatos comerciais viram só aviso (casos da revisão)', () => {
    for (const t of [
      'Você é a Ana Paula, atendente da Clínica Vida, na Rua Augusta, 1500',
      'Você é o Dr. Carlos Mendes, cardiologista. Agendamentos: (11) 3456-7890',
      'Você é a Maria Clara, da unidade Paulista (CEP 01310-100)',
      'Hospital Santa Maria Silva — Av. Brasil, 200',
    ]) {
      expect(veredito(t).verdict, t).toBe('aviso');
    }
  });

  it('titular com endereço + CEP/fixo, ou com qualquer identificador forte, segue bloqueado', () => {
    expect(veredito('Olá, sou Carlos Eduardo Lima, moro na Av. Brasil, 1500 (CEP 22148-611).')).toMatchObject({
      verdict: 'bloqueio',
      reason: 'ficha',
    });
    expect(veredito(`Você é a Ana Paula; o CPF da cliente é ${CPF_1}.`).verdict).toBe('bloqueio');
    expect(veredito('Paciente Maria Souza, Rua das Flores, 12.').verdict).toBe('aviso'); // 1 dado fraco só
  });
});

describe('IMPL-042 (revisão) — fronteira: separador colado na palavra-gatilho', () => {
  it('"CPF-…", "cpf/…", "CPF.…" e "CNS/…" são detectados e redigidos; gatilho colado em letra não', () => {
    const v = new pii.PiiVault({ key: 'f' });
    for (const t of ['CPF-529.982.247-25', 'cpf/52998224725', 'CPF.529.982.247-25', 'RG-12.345.678-9']) {
      const r = v.redact(`dado: ${t}.`);
      expect(r.redactions.length, t).toBe(1);
      expect(r.text).not.toMatch(/529\.?982|12\.345/);
    }
    expect(pii.scanPii('Lote XCPF-529.982.247-25').findings).toEqual([]);
    expect(pii.scanPii('versão 1-529.982.247-25').findings).toEqual([]);
  });
});

describe('IMPL-042 (revisão 2) — ground truth: a resposta volta REIDRATADA e casa com o rótulo cru', () => {
  const restaurar: Array<() => void> = [];
  afterEach(() => {
    while (restaurar.length) restaurar.pop()!();
  });

  it('o modelo viu e devolveu o token; o papel recebe o CPF original e o gabarito determinístico resolve', async () => {
    // O "modelo" ecoa o token que recebeu (é tudo o que ele viu do CPF).
    const fake = fakeOpenRouter({ chat: (req) => ({ text: /\[CPF_[0-9a-f]{12}\]/.exec(req.user)?.[0] ?? 'não sei' }) });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    restaurar.push(((prev) => () => setDefaultGateway(prev))(setDefaultGateway(gw)));
    const ledger = new BudgetLedger();
    const pergunta = `Extraia o CPF de "titular ${CPF_1}"`;
    const competidor = await chatCompletion({
      apiKey: KEY,
      modelId: 'x/a',
      messages: [{ role: 'user', content: pergunta }],
      sink: ledger,
    });
    const corpo = JSON.stringify(fake.chatRequests()[0].body);
    expect(corpo).not.toContain(CPF_1);
    expect(corpo).toMatch(/\[CPF_[0-9a-f]{12}\]/);
    expect(competidor.text).toBe(CPF_1); // reidratado: o token não chega ao papel
    expect(JSON.stringify(competidor.raw)).not.toContain(CPF_1); // o fio segue pseudonimizado
    expect(gw.piiStats().restoredTokens).toBe(1);

    const contestants = ['a', 'c'].map((id) => ({ id, label: id, modelId: `x/${id}` }));
    const resposta = (id: string, text: string) => ({
      contestantId: id,
      modelId: `x/${id}`,
      text,
      latencyMs: 1,
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      status: 'ok' as const,
    });
    const antes = fake.chatRequests().length;
    const r = await judgeStageReference({
      stage: { question: pergunta, productContext: 'x', maxTokens: 50, expected: CPF_1, reference: CPF_1 },
      responses: [resposta('a', competidor.text), resposta('c', 'não sei')],
      contestants,
      judgeModelIds: ['x/j'],
      apiKey: KEY,
      ctx: { sink: ledger },
    });
    expect(r.judgeModelId).toBe('ground-truth');
    expect(r.verdictByContestant).toEqual({ a: 'resolve', c: 'nao' });
    expect(fake.chatRequests().length).toBe(antes); // determinístico: nenhum LLM
  });
});

describe('IMPL-042 (revisão) — run avulsa "redigir" revisada grava o relatório no record (Node e SPA)', () => {
  let tmp: string;
  let dirAnterior: string;
  const restaurar: Array<() => void> = [];
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pb-impl042-rep-'));
    dirAnterior = getDataDir();
    setDataDir(tmp);
  });
  afterEach(() => {
    while (restaurar.length) restaurar.pop()!();
  });
  afterAll(() => {
    setDataDir(dirAnterior);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('sem revisão: recusa sem chamar LLM; revisada: termina, pseudonimiza e o record diz o que (sem o valor)', async () => {
    const silencio = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    try {
      for (const run of [runNode, runWeb] as const) {
        const fake = fakeComPii();
        const anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
        restaurar.push(() => setDefaultGateway(anterior));
        const cfg = {
          mode: 'compare',
          theme: 'atendimento de clínica',
          stages: 1,
          datagenModelId: M.gen,
          judgeModelIds: [M.judge],
          competitorModelIds: [M.a, M.opt],
          customStages: [
            { question: `Meu CPF é ${CPF_2}, cadê o laudo?`, productContext: `Central: ${CEL_1}.`, maxTokens: 200 },
          ],
          timeoutMs: 5_000,
        };
        const recusada = await run(cfg as never, KEY, {});
        expect(recusada.status).toBe('error');
        expect(recusada.error).toContain('customStages[0].question (CPF)');
        expect(fake.chatRequests()).toEqual([]);

        const rec = await run({ ...cfg, allowPii: true } as never, KEY, {});
        expect(rec.status, rec.error).toBe('finished');
        expect(fake.chatRequests().length).toBeGreaterThan(0);
        for (const req of fake.chatRequests()) {
          for (const cru of [CPF_2, CEL_1, '97351-2846']) expect(JSON.stringify(req.body)).not.toContain(cru);
        }
        expect(rec.piiReport).toEqual({
          mode: 'redact',
          allowPii: true,
          fields: [
            { path: 'customStages[0].question', kinds: ['cpf'], verdict: 'bloqueio' },
            { path: 'customStages[0].productContext', kinds: ['telefone'], verdict: 'bloqueio' },
          ],
        });
        expect(JSON.stringify(rec.piiReport)).not.toContain(CPF_2);
        while (restaurar.length) restaurar.pop()!();
      }
    } finally {
      silencio.forEach((s) => s.mockRestore());
    }
  });
});

// ---------------------------------------------------------------------------
// Revisão 2 — a VOLTA da pseudonimização (R-16 DEC-5) e os minors
// ---------------------------------------------------------------------------

describe('IMPL-042 (revisão 2) — reversão fora do caminho de envio: o token nunca chega ao usuário', () => {
  const restaurar: Array<() => void> = [];
  afterEach(() => {
    while (restaurar.length) restaurar.pop()!();
  });

  const TEL = '(11) 3071-4455';
  const MAIL = 'sac@lojaalfa.com.br';
  const CNPJ = '11.444.777/0001-61';
  const BASE =
    'Você é o atendente virtual da Loja Alfa. Resolva trocas e devoluções com cordialidade e objetividade. ' +
    `Para falar com um humano: SAC ${TEL} ou ${MAIL}. CNPJ ${CNPJ}.`;

  it('cofre: ida e volta estáveis; token de outro escopo/inventado fica visível; o mapa não serializa', () => {
    const v = new pii.PiiVault({ key: 'k' });
    const r = v.redact(BASE);
    expect(r.redactions.map((x) => x.kind).sort()).toEqual(['cnpj', 'email', 'telefone']);
    for (const cru of [TEL, '3071-4455', MAIL, CNPJ]) expect(r.text).not.toContain(cru);
    expect(v.rehydrate(r.text)).toEqual({ text: BASE, restored: 3 });
    // O que o modelo costuma fazer com o token: sem colchetes, caixa trocada.
    const tok = r.redactions.find((x) => x.kind === 'telefone')!.token;
    const nu = tok.slice(1, -1);
    expect(v.rehydrate(`ligue ${nu.toLowerCase()} ou ${nu}.`).text).toBe(`ligue ${TEL} ou ${TEL}.`);
    // Desconhecido (inventado ou de OUTRA run): fica como está, nunca vira outro valor.
    const outro = new pii.PiiVault({ key: 'k2' });
    expect(outro.rehydrate(r.text)).toEqual({ text: r.text, restored: 0 });
    expect(v.rehydrate('[CPF_000000000000]').restored).toBe(0);
    // Só memória: nem JSON nem spread alcançam o mapa.
    expect(JSON.stringify(v)).not.toMatch(/3071|lojaalfa|444\.777/);
    expect(JSON.stringify({ ...v })).not.toMatch(/3071|lojaalfa|444\.777/);
    expect(v.size).toBe(3);
  });

  it('reenvio re-tokeniza igual: o valor achado COM contexto volta ao token mesmo repetido SEM contexto', () => {
    const v = new pii.PiiVault({ key: 'k' });
    const ida = v.redact('telefone 3071-4455');
    expect(ida.redactions).toHaveLength(1);
    const tok = ida.redactions[0].token;
    const resposta = v.rehydrate(`anote: ${tok}.`).text;
    expect(resposta).toBe('anote: 3071-4455.');
    expect(pii.scanPii(resposta).findings).toEqual([]); // sem contexto, a varredura sozinha não pegaria
    expect(v.redact(resposta).text).toBe(`anote: ${tok}.`); // a volta não abre caminho cru
    expect(new pii.PiiVault({ key: 'k' }).redact(resposta).text).toBe(resposta); // é o cofre do escopo que lembra
  });

  it('variação no modo padrão com contato de EMPRESA: corpo com token, variante e neverBreak com o valor original', async () => {
    const check = pii.checkRunPii({ basePrompt: BASE });
    expect(pii.runPiiRefusal(check)).toBeNull(); // só "aviso": nem pede revisão
    expect(check.warnings.map((w) => w.path)).toEqual(['basePrompt']);

    // O reescritor devolve o prompt que RECEBEU (com os tokens) reescrito; o juiz
    // do diff do contrato (IMPL-011, camada 2 do neverBreak) diz "nada violado".
    const fake = fakeOpenRouter({
      chat: (req) => {
        if (req.system.includes('"violacoes"')) return { text: '{"violacoes":[]}' };
        const base = /<prompt_base>\n([\s\S]*?)\n<\/prompt_base>/.exec(req.user)?.[1] ?? '';
        return { text: `Seja sempre cordial e preciso. ${base} Nunca invente prazos.` };
      },
    });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    restaurar.push(((prev) => () => setDefaultGateway(prev))(setDefaultGateway(gw)));
    const silencio = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    restaurar.push(() => silencio.mockRestore());

    const contestants = await generateContestants({
      apiKey: KEY,
      modelId: 'x/a',
      theme: 'atendimento da Loja Alfa',
      basePrompt: BASE,
      includeOriginal: true,
      techniqueIds: ['persona', 'constraints'],
      promptOptimization: true,
      optimizerModelId: 'x/opt',
      contracts: { neverBreak: [TEL, MAIL] },
      ctx: { sink: new BudgetLedger() },
    });

    const reqs = fake.chatRequests();
    // Uma reescrita + um juiz do diff por técnica, sem retry: nenhum contrato quebrou.
    // O juiz também só vê token (reescrita e invariantes re-tokenizadas no mesmo cofre).
    expect(reqs.filter((r) => !r.system.includes('"violacoes"'))).toHaveLength(2);
    expect(reqs.filter((r) => r.system.includes('"violacoes"'))).toHaveLength(2);
    for (const req of reqs) {
      const corpo = JSON.stringify(req.body);
      for (const cru of [TEL, '3071-4455', MAIL, CNPJ]) expect(corpo).not.toContain(cru);
      expect(corpo).toMatch(/\[TELEFONE_[0-9a-f]{12}\]/);
    }
    const variantes = contestants.filter((c) => !c.isOriginal);
    expect(variantes.map((c) => c.techniqueId)).toEqual(['persona', 'constraints']); // nenhuma rejeitada
    for (const c of variantes) {
      expect(c.systemPrompt).toContain(`SAC ${TEL} ou ${MAIL}. CNPJ ${CNPJ}.`);
      expect(c.systemPrompt).not.toMatch(/(TELEFONE|EMAIL|CNPJ)_[0-9a-f]{12}/i);
    }
    expect(gw.piiStats().restoredTokens).toBe(6);
  });

  it('stream: o texto final e a prévia acumulada chegam reidratados; o fio segue com token', async () => {
    const fake = fakeOpenRouter({ chat: (req) => ({ text: `Confirmado: ${/\[EMAIL_[0-9a-f]{12}\]/.exec(req.user)?.[0]}` }) });
    const gw = createGateway({ fetch: fake.fetch, sleep: noSleep });
    const previas: string[] = [];
    const r = await gw.chatCompletionStream({
      apiKey: KEY,
      modelId: 'x/y',
      messages: [{ role: 'user', content: `Meu e-mail: ${EMAIL_1}` }],
      onDelta: (_d, acumulado) => previas.push(acumulado),
    });
    expect(JSON.stringify(fake.chatRequests()[0].body)).not.toContain(EMAIL_1);
    expect(r.text).toBe(`Confirmado: ${EMAIL_1}`);
    expect(previas.at(-1)).toBe(`Confirmado: ${EMAIL_1}`);
    expect(gw.piiStats().restoredTokens).toBe(1); // a prévia não conta de novo
  });
});

describe('IMPL-042 (revisão 2) — `library seed --file` passa pelo MESMO funil LGPD do `add`', () => {
  it('item com CPF/celular é recusado nomeando o campo (exit 3); `--allow-pii` libera', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pb-impl042-seed-'));
    const antes = getDataDir();
    const stderr: string[] = [];
    const silencio = [
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
      vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
        stderr.push(String(c));
        return true;
      }),
    ];
    try {
      const arq = join(tmp, 'seed.json');
      writeFileSync(
        arq,
        JSON.stringify([
          { id: 'ok-1', title: 'ok', tier: 'mft', question: 'Qual o horário?', productContext: 'Das 8h às 18h.', maxTokens: 200, reference: 'Das 8h às 18h.' },
          { id: 'pii-1', title: 'pii', tier: 'mft', question: `Meu CPF é 529.982.247-25 e o celular ${CEL_1}.`, productContext: 'x', maxTokens: 200, reference: 'y' },
        ]),
      );
      const base = ['seed', '--profile', 'perfil', '--file', arq, '--data-dir', tmp];
      // Recusa parcial sai pelo envelope único de erro (IMPL-028): CliError exit 3.
      await expect(cmdLibrary(base)).rejects.toMatchObject({ code: 3, errorCode: 'library.items_rejected' });
      expect(stderr.join('')).toMatch(/item 2: Importação bloqueada \(LGPD\).*question \(CPF \+ telefone\)/);
      expect((await listItems('perfil')).map((i) => i.id)).toEqual(['ok-1']);
      await expect(cmdLibrary([...base, '--allow-pii'])).resolves.toBe(0);
      expect((await listItems('perfil')).map((i) => i.id).sort()).toEqual(['ok-1', 'pii-1']);
    } finally {
      silencio.forEach((s) => s.mockRestore());
      setDataDir(antes);
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('IMPL-042 (revisão 2) — RG formatado sem rótulo não é identificador forte; chave PIX', () => {
  const veredito = (t: string) => pii.assessPii(pii.scanPii(t).findings).verdict;

  it('versão/lote/valor/pedido no formato de RG não bloqueiam (nem são achados)', () => {
    for (const t of ['Versão 1.234.567-8 do app.', 'Lote 12.345.678-9', 'R$ 1.234.567-8', 'Pedido nº 23.456.789-0']) {
      expect(pii.scanPii(t).findings, t).toEqual([]);
      expect(veredito(t), t).toBe('limpo');
    }
    // Sem rótulo nenhum: ambíguo ⇒ aviso (ainda pseudonimizado e reversível), nunca bloqueio.
    expect(veredito('Referência 12.345.678-9 do sistema.')).toBe('aviso');
  });

  it('com rótulo de identidade (antes ou órgão depois), o RG segue bloqueando', () => {
    for (const t of ['RG 12.345.678-9', 'identidade: 12.345.678-9', 'documento 1.234.567-X', 'portador do 12.345.678-9 SSP/SP']) {
      expect(veredito(t), t).toBe('bloqueio');
    }
  });

  it('celular/CPF corrido como chave PIX é detectado e bloqueia; chave aleatória (UUID) não', () => {
    expect(veredito('Chave pix: 21988473312')).toBe('bloqueio');
    expect(veredito('Minha chave é 48991267754, pode transferir.')).toBe('bloqueio');
    expect(veredito('Chave PIX (CPF): 47230591805')).toBe('bloqueio');
    expect(veredito('Chave pix aleatória: 7f3c9a2e-1b4d-4c8e-9a6f-2d1e3b4c5a6f')).toBe('limpo');
    // Sequência de placeholder (98765432…) é detectada, mas não é número de gente.
    const seq = pii.scanPii('Chave pix: 11987654321').findings;
    expect(seq.map((f) => [f.kind, f.realistic])).toEqual([['telefone', false]]);
  });
});

describe('IMPL-042 (revisão 2) — "Revisei" vale para o dado REVISADO, não para o que vier depois', () => {
  const cfg = (question: string, productContext = 'Das 8h às 18h.') => ({
    mode: 'compare',
    customStages: [{ question, productContext, maxTokens: 200 }],
  });

  it('trocar o CPF ou pôr um celular novo pede nova confirmação; o mesmo CPF em outra formatação não', () => {
    for (const lgpd of [webLgpd, nodeLgpd] as const) {
      const revisado = lgpd.checkRunPii(cfg(`Meu CPF é ${CPF_1}.`));
      expect(revisado.blocked).toHaveLength(1);
      const ack = new Set(lgpd.piiReviewKeys(revisado.blocked));
      expect([...ack].join()).not.toContain(CPF_1.replace(/\D/g, '')); // chave é hash, não o valor
      expect(lgpd.unreviewedPii(revisado.blocked, ack)).toEqual([]);

      const mesmo = lgpd.checkRunPii(cfg(`Meu CPF é ${CPF_1.replace(/\D/g, '')}.`));
      expect(lgpd.unreviewedPii(mesmo.blocked, ack)).toEqual([]);

      const trocado = lgpd.checkRunPii(cfg(`Meu CPF é ${CPF_2}.`));
      expect(lgpd.unreviewedPii(trocado.blocked, ack).map((r) => r.path)).toEqual(['customStages[0].question']);

      const acrescido = lgpd.checkRunPii(cfg(`Meu CPF é ${CPF_1}.`, `Central: ${CEL_1}.`));
      expect(lgpd.unreviewedPii(acrescido.blocked, ack).map((r) => r.path)).toEqual(['customStages[0].productContext']);
    }
  });
});

describe('IMPL-042 (revisão 2) — o que saiu pseudonimizado (ou cru, no agente) é dito, nunca silencioso', () => {
  it('describeRunPii/describePiiReport: modo agente diz que o "aviso" segue CRU no executor; nunca o valor', () => {
    const base = 'SAC (11) 3071-4455 ou sac@lojaalfa.com.br.';
    const chat = pii.checkRunPii({ basePrompt: base });
    const agente = pii.checkRunPii({ basePrompt: base, agent: { harness: 'pi' } });
    expect(pii.runPiiRefusal(agente)).toBeNull(); // só aviso: o pré-voo deixa passar…
    expect(pii.describeRunPii(agente)).toMatch(/Modo agente.*basePrompt.*CRUS/); // …e diz a verdade
    expect(pii.describeRunPii(chat)).toMatch(/pseudonimizados.*voltam ao valor original/);

    const rep = pii.summarizeRunPii(chat)!;
    expect(webLgpd.describePiiReport(rep)).toMatch(/basePrompt \(telefone \+ e-mail\).*pseudonimizados/);
    expect(webLgpd.describePiiReport(rep, { agent: true })).toMatch(/Modo agente.*CRUS/);
    expect(webLgpd.describePiiReport(undefined)).toBeNull();
    for (const s of [pii.describeRunPii(agente)!, webLgpd.describePiiReport(rep)!]) {
      expect(s).not.toMatch(/3071|lojaalfa/);
    }
  });
});
