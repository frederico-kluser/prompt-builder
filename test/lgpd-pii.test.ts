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
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pii from '../src/engine/pii.js';
import * as nodeLgpd from '../src/lgpd.js';
import * as webLgpd from '../web/src/lgpd.js';
import { createGateway, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { runToCompletion as runNode } from '../src/orchestrator.js';
import { trainToCompletion as trainNode } from '../src/trainer.js';
import { runToCompletion as runWeb } from '../web/src/engine/orchestrator.js';
import { startTraining as startWebTraining } from '../web/src/engine/trainer.js';
import { subscribeSession } from '../web/src/engine/events.js';
import { parseScenarioPack } from '../src/scenarioPack.js';
import { parseArenaConfig } from '../src/configFile.js';
import { parseArenaConfig as parseArenaConfigWeb } from '../web/src/engine/configFile.js';
import { arenaConfigToRunConfig } from '../src/arenaConfig.js';
import { importItems, listItems } from '../src/library.js';
import { parseRunConfig } from '../src/runConfigSchema.js';
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
    const ok = parseArenaConfig(CONFIG_ARQ, { allowPii: true });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    const conv = arenaConfigToRunConfig(ok.config);
    expect(conv.ok).toBe(true);
    if (conv.ok) expect(conv.config.piiMode).toBe('synthetic');
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
    const guard = pii.createPiiGuard({ salt: 's' });
    const [m] = guard.protect([{ role: 'user', content: 'Paciente Maria Souza, sem documento.' }]);
    expect(m.content).toBe('Paciente Maria Souza, sem documento.');
    expect(guard.stats().contextualSeen).toBe(1);
    expect(guard.stats().redactedCalls).toBe(0);
  });
});

describe('IMPL-042 — pseudonimização (token estável por instância, com sal)', () => {
  it('mesmo documento em formatos diferentes ⇒ mesmo token; sal diferente ⇒ token diferente', () => {
    const v = new pii.PiiVault({ salt: 'run-1' });
    const a = v.redact('CPF 529.982.247-25').text;
    const b = v.redact('cpf: 52998224725').text;
    const tokA = /\[CPF_[0-9a-f]{8}\]/.exec(a)?.[0];
    expect(tokA).toBeDefined();
    expect(b).toContain(tokA!);
    expect(new pii.PiiVault({ salt: 'run-2' }).redact('CPF 529.982.247-25').text).not.toContain(tokA!);
    // O token não é re-detectado quando a resposta volta ao juiz.
    expect(pii.scanPii(`O ${tokA} foi localizado`).findings).toEqual([]);
    // Telefone com e sem +55 é a mesma pessoa.
    expect(v.redact('+55 (11) 97351-2846').text).toBe(v.redact('(11) 97351-2846').text);
  });

  it('placeholder, exemplo notório e número de serviço seguem intactos (não são pessoa)', () => {
    const v = new pii.PiiVault({ salt: 'x' });
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
    expect(buildBody).toContain('messages: this.protectMessages(messages)');
    // A ÚNICA chave `messages` do corpo é a protegida, e ninguém a reescreve depois.
    expect(buildBody.match(/\bmessages\s*:/g)).toEqual(['messages:']);
    expect(fonte).not.toMatch(/\.messages\s*=|\[['"]messages['"]\]\s*=/);
    expect(fonte).toMatch(/private protectMessages\([^)]*\)[^{]*\{\s*return this\.piiGuard\.protect\(messages\);/);
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
    const tok = /\[CPF_[0-9a-f]{8}\]/.exec(r1.user)?.[0];
    expect(tok).toBeDefined();
    expect(r2.user).toContain(tok!);
    expect(r2.system).toMatch(/\[EMAIL_[0-9a-f]{8}\]/);
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
      chats.some((r) => papelDe(r) === p && /\[(CPF|TELEFONE|EMAIL)_[0-9a-f]{8}\]/.test(JSON.stringify(r.body))),
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

  it('Node (trainer + orchestrator): modo redigir roda inteiro e nenhum corpo leva o dado cru', async () => {
    const { fake, gw } = comFake();
    const rec = await trainNode(treino() as unknown as TrainingConfig, KEY);
    expect(rec.status, rec.error).toBe('finished');
    conferirSemPii(fake, gw);
  });

  it('SPA (trainer + orchestrator client-side): mesma garantia pelo mesmo gateway', async () => {
    const { fake, gw } = comFake();
    const { sessionId, record } = await startWebTraining(treino() as never, KEY);
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
      await expect(enforce(cfg, Date.now(), { nested: true })).resolves.toBeDefined();
      await expect(enforce({ ...cfg, piiMode: 'redact' })).resolves.toBeDefined();
    }
    expect(webLgpd.scanPii).toBe(pii.scanPii); // shim: fonte única
  });
});
