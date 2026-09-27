// Testes de CONTRATO da linha de base de segurança (IMPL-024, R-09:REC-10).
//
// Tudo que abre arquivo por um valor vindo de fora — rota HTTP, tool MCP,
// argumento de CLI — valida o id, contém o caminho e responde sem caminho
// absoluto; o servidor ouve em 127.0.0.1 e só atende Host/Origin locais; o data
// dir privado fica 0700/0600. Os pedidos HTTP vão por `http.request` CRU (o
// `fetch` normalizaria `%2e%2e` antes de sair e o teste não provaria nada).

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLocalhostHost, parseAllowedHosts, resolveBindHost, startServer } from '../src/server.js';
import { getDataDir, loadRun, loadSession, saveRun, saveSession, setDataDir } from '../src/storage.js';
import {
  isSafePathSegment,
  isValidRecordId,
  readFileInside,
  redactPaths,
  resolveInside,
} from '../src/pathSafety.js';
import { callTool } from '../src/cli/commands/mcp.js';
import { readDocTopic } from '../src/cli/commands/knowledge.js';
import { deleteItem, deleteProfile, importItems, saveProfile } from '../src/library.js';
import type { RunRecord, SessionRecord } from '../src/types.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');
const CLI = path.join(ROOT, 'src', 'cli', 'index.ts');

/** Caminho absoluto POSIX/Windows numa mensagem (o que NÃO pode vazar). */
const ABS_PATH_RE = /(^|[\s'"(=])(\/[\w.-]+\/|[A-Za-z]:\\)/u;

function runFixture(id: string): RunRecord {
  return {
    id,
    status: 'finished',
    mode: 'compare',
    config: {
      mode: 'compare',
      theme: 'segurança',
      stages: 1,
      datagenModelId: 'a/b',
      judgeModelIds: ['a/b'],
      competitorModelIds: ['a/b', 'c/d'],
    },
    contestants: [],
    stages: [],
    scoreboard: {},
    totalCostUsd: 0,
    startedAt: new Date().toISOString(),
  } as unknown as RunRecord;
}

function sessionFixture(id: string): SessionRecord {
  return {
    id,
    status: 'finished',
    config: { mode: 'training', theme: 'segurança', iterations: 1 },
    runIds: [],
    bestPromptByIteration: [],
    totalCostUsd: 0,
    startedAt: new Date().toISOString(),
  } as unknown as SessionRecord;
}

interface RawResponse {
  status: number;
  body: string;
}

/** Pedido HTTP CRU: o path vai exatamente como escrito (sem normalização). */
function rawRequest(
  port: number,
  rawPath: string,
  opts: { headers?: Record<string, string>; method?: string; noHost?: boolean } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: rawPath,
        method: opts.method ?? 'GET',
        setHost: !opts.noHost,
        headers: opts.noHost ? opts.headers : { host: `localhost:${port}`, ...opts.headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf-8');
        res.on('data', (c: string) => {
          body += c;
          // SSE aberta: não precisa esperar o fim para os testes
          if (res.headers['content-type']?.startsWith('text/event-stream')) res.destroy();
        });
        res.on('close', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function runCli(args: string[], env: Record<string, string> = {}, stdin?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, NO_COLOR: '1', CLAUDECODE: '', CI: '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

// ---------------------------------------------------------------------------

describe('IMPL-024 — superfície HTTP (rotas + Host/Origin + bind)', () => {
  let tmp: string;
  let dirAnterior: string;
  let server: Server;
  let port: number;
  let runId: string;
  let silencio: Array<{ mockRestore(): void }> = [];

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pb-impl024-http-'));
    dirAnterior = getDataDir();
    setDataDir(tmp);
    silencio = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    runId = randomUUID();
    await saveRun(runFixture(runId));
    // armadilha EISDIR: runs/x.json é um DIRETÓRIO
    mkdirSync(path.join(tmp, 'runs', 'x.json'));
    // alvo que um traversal bem-sucedido leria (fora de runs/)
    writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(runFixture('vazou')));
    server = await startServer({
      port: 0,
      webDist: null,
      agentsEnabled: true,
      extraAllowedHosts: ['bench.interno'],
    });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    silencio.forEach((s) => s.mockRestore());
    setDataDir(dirAnterior);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('bind default em 127.0.0.1 (nunca todas as interfaces)', () => {
    expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
    expect(resolveBindHost([], {})).toBe('127.0.0.1');
    expect(resolveBindHost(['node', 'server.js', '--host', '0.0.0.0'], {})).toBe('0.0.0.0');
    expect(resolveBindHost([], { HOST: '::1' })).toBe('::1');
    expect(isLocalhostHost('127.0.0.1')).toBe(true);
    expect(isLocalhostHost('[::1]')).toBe(true);
    expect(isLocalhostHost('0.0.0.0')).toBe(false);
    expect(isLocalhostHost('')).toBe(false);
    expect(parseAllowedHosts('Bench.Interno:8080, ,x.dev')).toEqual(['bench.interno', 'x.dev']);
  });

  it('caminho feliz: run salva com id UUID volta 200', async () => {
    const r = await rawRequest(port, `/v1/benchmark/runs/${runId}`);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).id).toBe(runId);
  });

  it.each([
    ['..%2Fpackage', '/v1/benchmark/runs/..%2Fpackage'],
    ['..%5Cpackage', '/v1/benchmark/runs/..%5Cpackage'],
    ['%2e%2e', '/v1/benchmark/runs/%2e%2e'],
    ['%2e%2e%2fpackage', '/v1/benchmark/runs/%2e%2e%2fpackage'],
    ['..%2F..%2Fetc%2Fpasswd (sessão)', '/v1/benchmark/sessions/..%2F..%2Fetc%2Fpasswd'],
    ['..%2Fpackage (SSE)', '/v1/benchmark/runs/..%2Fpackage/events'],
    ['..%2Fpackage (csv)', '/v1/benchmark/runs/..%2Fpackage/export.csv'],
    ['NUL byte %00', '/v1/benchmark/runs/abc%00'],
  ])('traversal %s → 400 (nunca 200) e sem ecoar caminho', async (_nome, p) => {
    const r = await rawRequest(port, p);
    expect(r.status).toBe(400);
    expect(r.body).not.toContain('vazou');
    expect(r.body).not.toContain(tmp);
    expect(r.body).not.toMatch(/passwd|package/u);
  });

  it('traversal com ".." CRU no path não casa rota nenhuma (404, nunca 200)', async () => {
    const r = await rawRequest(port, '/v1/benchmark/runs/../../package');
    expect([400, 404]).toContain(r.status);
    expect(r.body).not.toContain('vazou');
  });

  it('EISDIR: runs/x/events com diretório x.json → 500 tratado e o processo segue vivo', async () => {
    const ev = await rawRequest(port, '/v1/benchmark/runs/x/events');
    expect(ev.status).toBe(500);
    expect(JSON.parse(ev.body).error).toMatch(/EISDIR/u);
    expect(ev.body).not.toContain(tmp);
    const direto = await rawRequest(port, '/v1/benchmark/runs/x');
    expect(direto.status).toBe(500);
    expect(direto.body).not.toContain(tmp);
    const csv = await rawRequest(port, '/v1/benchmark/runs/x/export.csv');
    expect(csv.status).toBe(500);
    // processo vivo: o servidor continua respondendo
    const saude = await rawRequest(port, '/health');
    expect(saude.status).toBe(200);
  });

  it('JSON malformado no corpo → 400 sem stack trace/caminho', async () => {
    const r = await new Promise<RawResponse>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/v1/benchmark/runs',
          method: 'POST',
          headers: { host: `localhost:${port}`, 'content-type': 'application/json', 'x-openrouter-key': 'k' },
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.end('{ruim');
    });
    expect(r.status).toBe(400);
    expect(r.body).not.toMatch(ABS_PATH_RE);
    expect(r.body).not.toMatch(/node_modules|at\s/u);
  });

  it.each([
    ['evil.com', 'evil.com'],
    ['evil.com com porta', `evil.com:${3001}`],
    ['127.0.0.1.nip.io (rebinding)', '127.0.0.1.nip.io'],
    ['localhost@evil.com', 'localhost@evil.com'],
    ['localhost.evil.com', 'localhost.evil.com'],
  ])('Host spoofado (%s) → 400', async (_nome, host) => {
    const r = await rawRequest(port, '/health', { headers: { host } });
    expect(r.status).toBe(400);
    const api = await rawRequest(port, `/v1/benchmark/runs/${runId}`, { headers: { host } });
    expect(api.status).toBe(400);
    expect(api.body).not.toContain(runId);
  });

  it('Host ausente → 400; localhost/127.0.0.1/[::1] e allowlist extra → 200', async () => {
    expect((await rawRequest(port, '/health', { noHost: true })).status).toBe(400);
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, 'LOCALHOST', 'bench.interno:9']) {
      expect((await rawRequest(port, '/health', { headers: { host } })).status, host).toBe(200);
    }
  });

  it('Origin de outra origem (ou "null") → 403; Origin local (Vite :5173) → 200', async () => {
    expect((await rawRequest(port, '/health', { headers: { origin: 'http://evil.com' } })).status).toBe(403);
    expect((await rawRequest(port, '/health', { headers: { origin: 'null' } })).status).toBe(403);
    expect(
      (await rawRequest(port, `/v1/benchmark/runs/${runId}`, { headers: { origin: 'https://localhost.evil.com' } })).status,
    ).toBe(403);
    expect((await rawRequest(port, '/health', { headers: { origin: 'http://localhost:5173' } })).status).toBe(200);
  });

  it('token de /v1/agents: ausente/errado → 401, certo → 200; arquivo do token 0600', async () => {
    expect((await rawRequest(port, '/v1/agents/runs')).status).toBe(401);
    expect((await rawRequest(port, '/v1/agents/runs', { headers: { 'x-agents-token': 'errado' } })).status).toBe(401);
    const arquivo = path.join(tmp, 'agents-token');
    const token = readFileSync(arquivo, 'utf-8').trim();
    // mesmo tamanho, conteúdo diferente (a comparação é em tempo constante)
    const quase = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;
    expect((await rawRequest(port, '/v1/agents/runs', { headers: { 'x-agents-token': quase } })).status).toBe(401);
    expect((await rawRequest(port, '/v1/agents/runs', { headers: { 'x-agents-token': token } })).status).toBe(200);
    if (process.platform !== 'win32') expect(statSync(arquivo).mode & 0o777).toBe(0o600);
    // e a guarda de id também vale em /v1/agents (token certo, id malicioso)
    const t = await rawRequest(port, '/v1/agents/runs/..%2Fpackage', { headers: { 'x-agents-token': token } });
    expect(t.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------

describe('IMPL-024 — entrypoint real do servidor (processo tsx)', () => {
  const SERVER = path.join(ROOT, 'src', 'server.ts');

  it('sem HOST: sobe em 127.0.0.1 (não em todas as interfaces) e aplica a guarda de Host', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'pb-impl024-srv-'));
    const child = spawn(TSX, [SERVER], {
      cwd: home, // sem .env aqui: só o ambiente abaixo vale
      env: {
        ...process.env,
        BENCHMARK_PORT: '0',
        PROMPT_BUILDER_HOME: home,
        HOST: '',
        PB_HOST: '',
        PROMPT_BUILDER_AGENTS: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const linha = await new Promise<string>((resolve, reject) => {
        let buf = '';
        const t = setTimeout(() => reject(new Error(`servidor não subiu: ${buf}`)), 15_000);
        const onData = (c: Buffer) => {
          buf += c.toString();
          const m = /listening on .*$/mu.exec(buf);
          if (m) {
            clearTimeout(t);
            resolve(m[0]);
          }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', (c: Buffer) => (buf += c.toString()));
        child.on('exit', (code) => reject(new Error(`servidor saiu (${code}): ${buf}`)));
      });
      expect(linha).toMatch(/\(bind 127\.0\.0\.1\)/u);
      const porta = Number(/:(\d+) \(bind/u.exec(linha)?.[1]);
      expect(porta).toBeGreaterThan(0);
      expect((await rawRequest(porta, '/health')).status).toBe(200);
      expect((await rawRequest(porta, '/health', { headers: { host: 'evil.com' } })).status).toBe(400);
    } finally {
      child.kill('SIGTERM');
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it('PROMPT_BUILDER_AGENTS=1 + HOST=0.0.0.0 → recusa subir (exit 1), sem ouvir porta', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'pb-impl024-srv-'));
    try {
      const r = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
        const child = spawn(TSX, [SERVER], {
          cwd: home,
          env: { ...process.env, BENCHMARK_PORT: '0', PROMPT_BUILDER_HOME: home, PROMPT_BUILDER_AGENTS: '1', HOST: '0.0.0.0' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stderr }));
      });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/REFUSING TO START/u);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------

describe('IMPL-024 — ids, contenção e mensagens (núcleo)', () => {
  it('isValidRecordId aceita UUID/slug e recusa separador, ponto, %, NUL e device do Windows', () => {
    expect(isValidRecordId(randomUUID())).toBe(true);
    expect(isValidRecordId('x')).toBe(true);
    expect(isValidRecordId('job-123_abc')).toBe(true);
    for (const ruim of ['', '..', '.', '../x', '..\\x', 'a/b', '%2e%2e', 'a.json', 'a\0b', 'C:x', ' x', 'NUL', 'com1', '-x', 'a'.repeat(129), 7, null]) {
      expect(isValidRecordId(ruim), String(ruim)).toBe(false);
    }
  });

  it('isSafePathSegment (biblioteca) aceita nome humano e recusa traversal', () => {
    expect(isSafePathSegment('Suporte SaaS v2')).toBe(true);
    expect(isSafePathSegment('reembolso.7-dias')).toBe(true);
    for (const ruim of ['..', '.', '../x', 'a/b', 'a\\b', 'C:', 'a\0', ' x', 'nul.txt', '']) {
      expect(isSafePathSegment(ruim), ruim).toBe(false);
    }
  });

  it('resolveInside contém (prefixo) e readFileInside barra symlink que escapa (realpath)', async () => {
    const raiz = mkdtempSync(path.join(tmpdir(), 'pb-impl024-cont-'));
    try {
      mkdirSync(path.join(raiz, 'runs'));
      writeFileSync(path.join(raiz, 'segredo.txt'), 'SEGREDO');
      expect(() => resolveInside(path.join(raiz, 'runs'), '../segredo.txt')).toThrow(/fora do diretório/u);
      expect(() => resolveInside(path.join(raiz, 'runs'), '/etc/passwd')).toThrow(/fora do diretório/u);
      expect(() => resolveInside(path.join(raiz, 'runs'), '.')).toThrow();
      expect(resolveInside(path.join(raiz, 'runs'), '..ok.json')).toBe(path.join(raiz, 'runs', '..ok.json'));
      if (process.platform !== 'win32') {
        symlinkSync(path.join(raiz, 'segredo.txt'), path.join(raiz, 'runs', 'link.json'));
        await expect(readFileInside(path.join(raiz, 'runs'), 'link.json')).rejects.toThrow(/fora do diretório/u);
      }
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });

  it('loadRun/loadSession com id malicioso → null sem tocar o disco; saveRun recusa gravar fora', async () => {
    const raiz = mkdtempSync(path.join(tmpdir(), 'pb-impl024-st-'));
    const anterior = getDataDir();
    setDataDir(path.join(raiz, 'data'));
    try {
      writeFileSync(path.join(raiz, 'alvo.json'), JSON.stringify(runFixture('vazou')));
      expect(await loadRun('../../alvo')).toBeNull();
      expect(await loadRun('..%2F..%2Falvo')).toBeNull();
      expect(await loadSession('../../alvo')).toBeNull();
      await expect(saveRun(runFixture('../../fora'))).rejects.toThrow(/inválido/u);
      await expect(saveSession(sessionFixture('../fora'))).rejects.toThrow(/inválido/u);
      expect(existsSync(path.join(raiz, 'fora.json'))).toBe(false);
      expect(existsSync(path.join(raiz, 'data', 'fora.json'))).toBe(false);
    } finally {
      setDataDir(anterior);
      rmSync(raiz, { recursive: true, force: true });
    }
  });

  it('redactPaths troca caminho absoluto por <caminho>/<basename> e preserva URL/relativo', () => {
    const msg = "ENOENT: no such file or directory, open '/home/fulano/.prompt-builder/runs/abc.json'";
    expect(redactPaths(msg)).toBe("ENOENT: no such file or directory, open '<caminho>/abc.json'");
    expect(redactPaths('falhou em C:\\Users\\fulano\\x.json')).toBe('falhou em <caminho>/x.json');
    expect(redactPaths('veja file:///home/fulano/a.md')).toBe('veja <caminho>');
    expect(redactPaths('GET https://openrouter.ai/api/v1/models falhou')).toBe(
      'GET https://openrouter.ai/api/v1/models falhou',
    );
    expect(redactPaths('use ./data/runs e ../x (1/2)')).toBe('use ./data/runs e ../x (1/2)');
    expect(redactPaths(msg)).not.toMatch(ABS_PATH_RE);
  });
});

// ---------------------------------------------------------------------------

describe('IMPL-024 — MCP (get_result/read_docs/get_agent_dossier) e CLI docs', () => {
  let tmp: string;
  let dirAnterior: string;

  beforeAll(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pb-impl024-mcp-'));
    dirAnterior = getDataDir();
    setDataDir(tmp);
  });
  afterAll(() => {
    setDataDir(dirAnterior);
    rmSync(tmp, { recursive: true, force: true });
  });

  it.each(['../../x', '..%2Fx', '/etc/passwd', '..\\x', ''])(
    'get_result com id %j é rejeitado (isError) sem caminho absoluto',
    async (id) => {
      const r = await callTool('get_result', { id });
      expect(r?.isError).toBe(true);
      const texto = r?.content[0]?.text ?? '';
      expect(texto).toMatch(/inválido/u);
      expect(texto).not.toMatch(ABS_PATH_RE);
      expect(texto).not.toContain(tmp);
      expect(texto).not.toContain('passwd');
    },
  );

  it('get_result com id válido inexistente continua "não encontrado" (não é erro)', async () => {
    const r = await callTool('get_result', { id: randomUUID() });
    expect(r?.isError).toBeUndefined();
    expect(JSON.parse(r!.content[0].text)).toEqual({ error: 'não encontrado' });
  });

  it('get_agent_dossier com runId malicioso é rejeitado', async () => {
    const r = await callTool('get_agent_dossier', { runId: '../../x', stageIndex: 0, contestantId: 'a' });
    expect(r?.isError).toBe(true);
    expect(r?.content[0]?.text).not.toMatch(ABS_PATH_RE);
  });

  it.each(['../README', '../../package', '/etc/passwd', 'quickstart/../../README', 'QUICKSTART', 'index'])(
    'read_docs {topic:%j} é rejeitado sem caminho absoluto',
    async (topic) => {
      const r = await callTool('read_docs', { topic });
      expect(r?.isError).toBe(true);
      const texto = r?.content[0]?.text ?? '';
      expect(texto).not.toMatch(ABS_PATH_RE);
      expect(texto).not.toContain('passwd');
      expect(texto).not.toContain('# prompt-builder'); // conteúdo do README não vazou
    },
  );

  it('read_docs de tópico da allowlist funciona (e sem tópico devolve o índice)', async () => {
    const ok = await callTool('read_docs', { topic: 'quickstart' });
    expect(ok?.isError).toBeUndefined();
    expect(JSON.parse(ok!.content[0].text).topic).toBe('quickstart');
    const indice = await callTool('read_docs', {});
    expect(Array.isArray(JSON.parse(indice!.content[0].text))).toBe(true);
    const lido = await readDocTopic('../../etc/passwd');
    expect(lido.ok).toBe(false);
    if (!lido.ok) expect(lido.reason).toBe('invalid');
  });

  it('CLI `docs ../../etc/passwd` → exit 2 (uso) e sem caminho absoluto no stderr', async () => {
    const r = await runCli(['docs', '../../etc/passwd']);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/Tópico inválido/u);
    expect(r.stderr).not.toMatch(ABS_PATH_RE);
    expect(r.stderr).not.toContain('root:');
  }, 20_000);

  it('MCP por stdio (processo real): get_result traversal e read_docs ../README rejeitados', async () => {
    const linhas = [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_result', arguments: { id: '../../x' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_docs', arguments: { topic: '../README' } } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n');
    const r = await runCli(['mcp', '--data-dir', tmp], {}, `${linhas}\n`);
    const respostas = r.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { id: number; result: { isError?: boolean; content: { text: string }[] } });
    expect(respostas.map((x) => x.id)).toEqual([1, 2]);
    for (const x of respostas) {
      expect(x.result.isError).toBe(true);
      expect(x.result.content[0].text).not.toMatch(ABS_PATH_RE);
    }
  }, 20_000);

  it('CLI `runs show ../x` → exit 2 sem ecoar o caminho', async () => {
    const r = await runCli(['runs', 'show', '../../etc/passwd', '--data-dir', tmp]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/inválido/u);
    expect(r.stderr).not.toContain('passwd');
  }, 20_000);
});

// ---------------------------------------------------------------------------

describe.skipIf(process.platform === 'win32')('IMPL-024 — permissões do data dir (0700/0600)', () => {
  let raiz: string;
  let anterior: string;
  let umaskAnterior: number;

  beforeAll(() => {
    // umask permissivo de propósito: prova que o 0700/0600 vem do código.
    umaskAnterior = process.umask(0o022);
  });
  afterAll(() => {
    process.umask(umaskAnterior);
  });
  afterEach(() => {
    setDataDir(anterior);
    rmSync(raiz, { recursive: true, force: true });
  });

  const modo = (p: string): number => statSync(p).mode & 0o777;

  it('~/.prompt-builder novo: raiz, runs e sessions 0700; records 0600', async () => {
    raiz = mkdtempSync(path.join(tmpdir(), 'pb-impl024-perm-'));
    anterior = getDataDir();
    const home = path.join(raiz, '.prompt-builder');
    setDataDir(home);
    const id = randomUUID();
    await saveRun(runFixture(id));
    await saveSession(sessionFixture(id));
    expect(modo(home)).toBe(0o700);
    expect(modo(path.join(home, 'runs'))).toBe(0o700);
    expect(modo(path.join(home, 'sessions'))).toBe(0o700);
    expect(modo(path.join(home, 'runs', `${id}.json`))).toBe(0o600);
    expect(modo(path.join(home, 'sessions', `${id}.json`))).toBe(0o600);
  });

  it('instalação ANTIGA (0755/0644) é corrigida por chmod explícito na próxima gravação', async () => {
    raiz = mkdtempSync(path.join(tmpdir(), 'pb-impl024-perm-'));
    anterior = getDataDir();
    const home = path.join(raiz, '.prompt-builder');
    const id = randomUUID();
    mkdirSync(path.join(home, 'runs'), { recursive: true });
    mkdirSync(path.join(home, 'sessions'), { recursive: true });
    chmodSync(home, 0o755);
    chmodSync(path.join(home, 'runs'), 0o755);
    chmodSync(path.join(home, 'sessions'), 0o755);
    writeFileSync(path.join(home, 'runs', `${id}.json`), JSON.stringify(runFixture(id)), { mode: 0o644 });
    setDataDir(home);
    await saveRun(runFixture(id));
    await saveSession(sessionFixture(id));
    expect(modo(home)).toBe(0o700);
    expect(modo(path.join(home, 'runs'))).toBe(0o700);
    expect(modo(path.join(home, 'sessions'))).toBe(0o700);
    expect(modo(path.join(home, 'runs', `${id}.json`))).toBe(0o600);
  });

  it('--data-dir arbitrário já existente: a raiz NÃO tem a permissão trocada (só runs/sessions)', async () => {
    raiz = mkdtempSync(path.join(tmpdir(), 'pb-impl024-perm-'));
    anterior = getDataDir();
    const projeto = path.join(raiz, 'meu-projeto');
    mkdirSync(projeto);
    chmodSync(projeto, 0o755);
    setDataDir(projeto);
    await saveRun(runFixture(randomUUID()));
    expect(modo(projeto)).toBe(0o755);
    expect(modo(path.join(projeto, 'runs'))).toBe(0o700);
  });

  it('CLI real com HOME isolado: `runs list`/`sessions list` criam ~/.prompt-builder{,/runs,/sessions} 0700', async () => {
    raiz = mkdtempSync(path.join(tmpdir(), 'pb-impl024-perm-'));
    anterior = getDataDir();
    // default de verdade do CLI (sem --data-dir/PROMPT_BUILDER_HOME/XDG_STATE_HOME)
    const env = { HOME: raiz, USERPROFILE: raiz, PROMPT_BUILDER_HOME: '', XDG_STATE_HOME: '' };
    for (const args of [['runs', 'list', '--json'], ['sessions', 'list', '--json']]) {
      const r = await runCli(args, env);
      expect(r.code, `${args.join(' ')}: ${r.stderr}`).toBe(0);
    }
    const home = path.join(raiz, '.prompt-builder');
    expect(modo(home)).toBe(0o700);
    expect(modo(path.join(home, 'runs'))).toBe(0o700);
    expect(modo(path.join(home, 'sessions'))).toBe(0o700);
  }, 30_000);

  it('key set --stdin por cima de key antiga 0644 deixa o arquivo 0600', async () => {
    raiz = mkdtempSync(path.join(tmpdir(), 'pb-impl024-perm-'));
    anterior = getDataDir();
    const home = path.join(raiz, '.prompt-builder');
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, 'key'), 'sk-antiga\n', { mode: 0o644 });
    chmodSync(path.join(home, 'key'), 0o644);
    const { writeStoredKey } = await import('../src/cli/context.js');
    setDataDir(home);
    await writeStoredKey('sk-nova');
    expect(modo(path.join(home, 'key'))).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------

describe('IMPL-024 — biblioteca: perfil/item viram segmento contido', () => {
  it('`library drop --profile ..` NÃO apaga o data dir; item importado com id ../ não é gravado fora', async () => {
    const raiz = mkdtempSync(path.join(tmpdir(), 'pb-impl024-lib-'));
    const anterior = getDataDir();
    const data = path.join(raiz, 'data');
    setDataDir(data);
    try {
      mkdirSync(data, { recursive: true });
      writeFileSync(path.join(data, 'key'), 'sk-x\n');
      writeFileSync(path.join(raiz, 'vizinho.txt'), 'não apague');
      await expect(deleteProfile('..')).rejects.toThrow(/inválido/u);
      await expect(deleteProfile('../..')).rejects.toThrow(/inválido/u);
      expect(existsSync(path.join(data, 'key'))).toBe(true);
      expect(existsSync(path.join(raiz, 'vizinho.txt'))).toBe(true);

      await saveProfile({ id: 'perfil-ok', name: 'ok' });
      const base = {
        title: 't',
        tier: 'mft',
        question: 'q?',
        productContext: 'ctx',
        maxTokens: 256,
        expected: 'algo',
      };
      const res = await importItems('perfil-ok', [
        { ...base, id: '../../../fora' },
        { ...base, id: 'dentro' },
      ]);
      expect(res.errors).toHaveLength(1);
      expect(res.errors[0]).toMatch(/^item 1: id inválido/u);
      expect(res.errors[0]).not.toContain('fora'); // não ecoa o id recebido
      expect(res.added).toBe(1); // o item válido do mesmo lote entra normalmente
      expect(existsSync(path.join(raiz, 'fora.json'))).toBe(false);
      expect(existsSync(path.join(data, 'fora.json'))).toBe(false);
      expect(existsSync(path.join(data, 'library', 'fora.json'))).toBe(false);
      // `deleteItem` com id de item malicioso lança antes do `rm` (a key segue lá)
      await expect(deleteItem('perfil-ok', '../../../key')).rejects.toThrow(/inválido/u);
      await expect(deleteProfile('perfil-ok/../..')).rejects.toThrow(/inválido/u);
      expect(existsSync(path.join(data, 'key'))).toBe(true);
    } finally {
      setDataDir(anterior);
      rmSync(raiz, { recursive: true, force: true });
    }
  });
});
