// Linha de base de segurança para tudo que abre ARQUIVO a partir de um valor
// que veio de fora — rota HTTP, tool MCP ou argumento de CLI (IMPL-024,
// R-09:REC-10 / DEC-8).
//
// Por que em camadas, e não "só uma regex":
//   1. O Express 4 (e o 5) DECODIFICA `req.params`: `..%2Fpackage` chega como
//      `../package`, `%2e%2e` como `..`, `..%5C` como `..\`. A única correção é
//      validar o id — normalizar a URL não resolve.
//   2. Id válido ainda passa por CONTENÇÃO (path.resolve + prefixo) e, na
//      leitura, por realpath: um symlink plantado no diretório não pode levar a
//      leitura para fora da raiz.
//   3. Mensagem de erro que sai do processo (HTTP/MCP) não carrega caminho
//      absoluto — ela vai parar no contexto de um agente ou na tela de um
//      navegador que não é, necessariamente, o dono da máquina.
//
// Node-only (fs/path): NÃO importe do web (a guarda engine-sync barra).

import { chmodSync, mkdirSync, promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Ids de registro (runs, sessões, e o que mais for gravado como <id>.json)
// ---------------------------------------------------------------------------

/**
 * Id de registro: começa por alfanumérico e só tem `[A-Za-z0-9_-]` (até 128).
 * Cobre o UUID que o motor gera (`randomUUID`) e fecha, por construção, `.`,
 * `/`, `\`, `%`, `:` (drive/ADS do Windows), NUL e espaço. Não é "só UUID" de
 * propósito: ids de teste curtos (`x`) e ids futuros prefixados (`job-<uuid>`)
 * continuam válidos sem abrir nenhum separador.
 */
export const RECORD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Nomes de dispositivo do Windows: `NUL.json` abre o dispositivo, não um arquivo. */
const WINDOWS_DEVICE_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

export function isValidRecordId(id: unknown): id is string {
  return typeof id === 'string' && RECORD_ID_RE.test(id) && !WINDOWS_DEVICE_RE.test(id);
}

/**
 * Segmento de caminho TOLERANTE, para ids escolhidos por pessoas (perfis e
 * itens da biblioteca): aceita acento, espaço e ponto no meio, mas nunca
 * separador, NUL, `:` nem `.`/`..`. A contenção por `resolveInside` continua
 * valendo depois — isto só dá uma mensagem melhor antes.
 */
export function isSafePathSegment(seg: unknown): seg is string {
  if (typeof seg !== 'string') return false;
  if (seg.length === 0 || seg.length > 128) return false;
  if (seg === '.' || seg === '..') return false;
  if (/[/\\:\0]/u.test(seg)) return false;
  if (seg.trim() !== seg) return false; // espaço nas pontas some no Windows
  return !WINDOWS_DEVICE_RE.test(seg.split('.')[0] ?? '');
}

const UNSAFE_PATH = 'UNSAFE_PATH';

/**
 * Pedido que tentaria sair da raiz (ou id fora do formato). Identificado por
 * `code`, nunca por `instanceof` (mesma razão de `isControlSignal`: instância
 * dupla do módulo em ESM daria `false` em silêncio).
 */
export class UnsafePathError extends Error {
  readonly code = UNSAFE_PATH;
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePathError';
  }
}

export function isUnsafePathError(err: unknown): err is UnsafePathError {
  return (err as { code?: unknown } | null)?.code === UNSAFE_PATH;
}

/**
 * Lança `UnsafePathError` para id fora do formato. A mensagem NÃO ecoa o valor
 * recebido: ecoar `../../etc/passwd` devolveria um caminho na resposta.
 */
export function assertValidRecordId(id: unknown, what = 'id'): asserts id is string {
  if (!isValidRecordId(id)) {
    throw new UnsafePathError(
      `${what} inválido: use o id devolvido pelo prompt-builder (UUID; só letras, números, "-" e "_").`,
    );
  }
}

// ---------------------------------------------------------------------------
// Contenção de caminho
// ---------------------------------------------------------------------------

/** `child` está ESTRITAMENTE dentro de `root` (ambos absolutos e resolvidos)? */
function isStrictlyInside(root: string, child: string): boolean {
  const rel = path.relative(root, child);
  // `rel === ''` é a própria raiz; `..` ou `../x` escapou; absoluto = outro drive.
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * `path.resolve(root, ...segments)` com verificação de prefixo: devolve o
 * caminho absoluto SÓ se ele cai estritamente dentro de `root`.
 */
export function resolveInside(root: string, ...segments: string[]): string {
  const base = path.resolve(root);
  const abs = path.resolve(base, ...segments);
  if (!isStrictlyInside(base, abs)) {
    throw new UnsafePathError('Caminho fora do diretório permitido.');
  }
  return abs;
}

/**
 * Lê `root/<segments>` com contenção LÉXICA e REAL: o realpath do arquivo tem
 * de continuar sob o realpath da raiz (um symlink plantado não escapa). Erros
 * de E/S (ENOENT, EISDIR…) propagam como vieram — quem chama decide.
 */
export async function readFileInside(root: string, ...segments: string[]): Promise<string> {
  const abs = resolveInside(root, ...segments);
  const [realRoot, realFile] = await Promise.all([fs.realpath(path.resolve(root)), fs.realpath(abs)]);
  if (!isStrictlyInside(realRoot, realFile)) {
    throw new UnsafePathError('Caminho fora do diretório permitido.');
  }
  return fs.readFile(realFile, 'utf-8');
}

// ---------------------------------------------------------------------------
// Permissões: diretórios 0700, arquivos 0600
// ---------------------------------------------------------------------------

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

let chmodWarned = false;

function warnChmod(err: unknown): void {
  if (chmodWarned) return;
  chmodWarned = true;
  console.warn(
    `[prompt-builder] aviso: não consegui restringir permissões (${(err as NodeJS.ErrnoException).code ?? 'erro'}).`,
  );
}

/**
 * chmod explícito e tolerante: `mkdir({mode})`/`writeFile({mode})` só valem na
 * CRIAÇÃO — um diretório de uma versão antiga (0755) continuaria aberto. Falha
 * de chmod (dono diferente, FS sem permissões POSIX) vira um aviso único no
 * stderr, nunca derruba a run.
 */
export async function chmodPrivate(target: string, mode: number): Promise<void> {
  try {
    await fs.chmod(target, mode);
  } catch (err) {
    warnChmod(err);
  }
}

/** mkdir -p com 0700 + chmod explícito (corrige diretório antigo 0755). */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  await chmodPrivate(dir, PRIVATE_DIR_MODE);
}

/** `ensurePrivateDir` síncrono, para os poucos pontos que gravam com `*Sync`. */
export function ensurePrivateDirSync(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    chmodSync(dir, PRIVATE_DIR_MODE);
  } catch (err) {
    warnChmod(err);
  }
}

/**
 * mkdir -p de `dir` com 0700 e chmod EXPLÍCITO em CADA nível entre `base`
 * (exclusive — a raiz não é tocada aqui) e `dir` (inclusive). Uma árvore de
 * versão antiga (`library/`, `agent-runs/<id>/…` em 0755) fica fechada no
 * primeiro nível — o que basta para ninguém mais atravessá-la —, e não só na
 * folha. `dir` tem de estar estritamente dentro de `base`.
 */
export async function ensurePrivateSubtree(base: string, dir: string): Promise<void> {
  const root = path.resolve(base);
  const abs = path.resolve(dir);
  if (!isStrictlyInside(root, abs)) throw new UnsafePathError('Caminho fora do diretório permitido.');
  await fs.mkdir(abs, { recursive: true, mode: PRIVATE_DIR_MODE });
  let atual = root;
  for (const seg of path.relative(root, abs).split(path.sep)) {
    atual = path.join(atual, seg);
    await chmodPrivate(atual, PRIVATE_DIR_MODE);
  }
}

/**
 * Grava `data` em `target` via tmp ÚNICO (0600 desde a criação) + rename. O
 * conteúdo novo nunca passa por um inode com permissão antiga: `writeFile` por
 * cima de um arquivo 0644 seguido de chmod deixaria a janela em que o conteúdo
 * NOVO (uma key, por exemplo) é legível por outros usuários. O rename leva o
 * 0600 para o alvo e corrige, de quebra, um arquivo antigo 0644. O diretório
 * pai já tem de existir (quem chama decide o mode dele).
 */
export async function writePrivateFileAtomic(target: string, data: string | Buffer): Promise<void> {
  // tmp ÚNICO por escrita: duas escritas concorrentes no mesmo alvo não brigam
  // pelo mesmo `.tmp` (era a causa de ENOENT no rename que derrubava a run).
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, data, typeof data === 'string' ? { encoding: 'utf-8', mode: PRIVATE_FILE_MODE } : { mode: PRIVATE_FILE_MODE });
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Mensagens de erro sem caminho absoluto
// ---------------------------------------------------------------------------

// UMA regex com alternância, aplicada numa passada só: com `replace`s em
// sequência, o `/x.json` que a troca do Windows acabou de produzir
// (`<caminho>/x.json`) era casado de novo como caminho POSIX. Na mesma posição
// vale a PRIMEIRA alternativa, e a varredura é da esquerda para a direita:
//   0. caminho ENTRE ASPAS (`open '/home/John Doe/x.json'` — o formato dos
//      erros do Node): redigido até a aspa de fecho, com espaço e tudo;
//   1. raiz CONHECIDA (a home do usuário, que pode ter espaço — `C:\Users\John
//      Doe` — e por isso não pode depender do corte no primeiro espaço);
//   2. `file://...`;
//   3. UNC `\\host\share`;
//   4. Windows `C:\...`/`C:/...` (sem letra/dígito antes);
//   5. POSIX que não seja parte de URL (`https://x/y`) nem de relativo (`a/b`,
//      `./x`, `../x`): a barra inicial não pode vir depois de palavra, `:`,
//      `/`, `.`, `~` ou `-`.
const PATH_END = String.raw`[^\s'"\x60<>|]*`;
const QUOTED_ABS = String.raw`(['"\x60])((?:file:\/\/|\\\\|[A-Za-z]:[\\/]|\/)[^'"\x60\r\n]*)\1`;
const GENERIC_ABS = [
  String.raw`file:\/\/[^\s'"\x60<>]*`,
  String.raw`\\\\[^\s'"\x60<>|]+`,
  String.raw`(?<![\w])[A-Za-z]:[\\/]${PATH_END}`,
  String.raw`(?<![\w:/.~-])\/(?:[^\s'"\x60<>|/]+\/)*[^\s'"\x60<>|/]*`,
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Raízes redigidas por prefixo: a home (se não for `/` nem vazia). */
function defaultKnownRoots(): string[] {
  try {
    const home = os.homedir();
    return home && home.length > 1 ? [home] : [];
  } catch {
    return [];
  }
}

const regexCache = new Map<string, RegExp>();

function absPathRegex(knownRoots: readonly string[]): RegExp {
  const roots = [...new Set(knownRoots.filter((r) => r.length > 1).map((r) => r.replace(/[\\/]+$/u, '')))]
    // a mais longa primeiro: `/home/a b/proj` antes de `/home/a b`
    .sort((a, b) => b.length - a.length);
  const chave = roots.join('\0');
  let re = regexCache.get(chave);
  if (!re) {
    // raiz inteira, sem continuar numa palavra (`/home/ana` não casa `/home/anab`)
    const raizes = roots.map((r) => String.raw`(?<![\w:/.~-])${escapeRegExp(r)}(?![\w-])${PATH_END}`);
    re = new RegExp([QUOTED_ABS, ...raizes, ...GENERIC_ABS].join('|'), 'giu');
    regexCache.set(chave, re);
  }
  re.lastIndex = 0;
  return re;
}

function keepBasename(p: string): string {
  const base = p.split(/[\\/]/u).filter(Boolean).at(-1);
  return base ? `<caminho>/${base}` : '<caminho>';
}

function redactOne(p: string): string {
  if (p === '/') return p; // barra solta (ex.: `"/"` numa mensagem de regra)
  if (/^file:/iu.test(p)) return '<caminho>';
  return keepBasename(p);
}

/**
 * Troca todo caminho absoluto de uma mensagem por `<caminho>/<basename>`. O
 * basename fica (é o id/arquivo — útil para diagnosticar e não revela a
 * estrutura da máquina); o resto some. `file://` some inteiro. Caminho entre
 * aspas é redigido até a aspa (espaço no meio não vaza metade do caminho), e as
 * `knownRoots` (default: a home) são reconhecidas mesmo sem aspas.
 */
export function redactPaths(message: string, knownRoots: readonly string[] = defaultKnownRoots()): string {
  return message.replace(absPathRegex(knownRoots), (m: string, aspa?: string, entreAspas?: string) =>
    aspa !== undefined && entreAspas !== undefined ? `${aspa}${redactOne(entreAspas)}${aspa}` : redactOne(m),
  );
}

/** Mensagem pública de um erro qualquer (sem caminho absoluto). */
export function publicErrorMessage(err: unknown, fallback = 'Erro interno.'): string {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return msg ? redactPaths(msg) : fallback;
}
