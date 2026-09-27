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

import { promises as fs } from 'node:fs';
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
    if (!chmodWarned) {
      chmodWarned = true;
      console.warn(
        `[prompt-builder] aviso: não consegui restringir permissões (${(err as NodeJS.ErrnoException).code ?? 'erro'}).`,
      );
    }
  }
}

/** mkdir -p com 0700 + chmod explícito (corrige diretório antigo 0755). */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  await chmodPrivate(dir, PRIVATE_DIR_MODE);
}

// ---------------------------------------------------------------------------
// Mensagens de erro sem caminho absoluto
// ---------------------------------------------------------------------------

// UMA regex com alternância, aplicada numa passada só: com `replace`s em
// sequência, o `/x.json` que a troca do Windows acabou de produzir
// (`<caminho>/x.json`) era casado de novo como caminho POSIX.
//   1. `file://...`;
//   2. UNC `\\host\share`;
//   3. Windows `C:\...`/`C:/...` (sem letra/dígito antes);
//   4. POSIX que não seja parte de URL (`https://x/y`) nem de relativo (`a/b`,
//      `./x`, `../x`): a barra inicial não pode vir depois de palavra, `:`,
//      `/`, `.`, `~` ou `-`.
const ABS_PATH_RE = new RegExp(
  [
    String.raw`file:\/\/[^\s'"\x60<>]*`,
    String.raw`\\\\[^\s'"\x60<>|]+`,
    String.raw`(?<![\w])[A-Za-z]:[\\/][^\s'"\x60<>|]*`,
    String.raw`(?<![\w:/.~-])\/(?:[^\s'"\x60<>|/]+\/)*[^\s'"\x60<>|/]*`,
  ].join('|'),
  'giu',
);

function keepBasename(p: string): string {
  const base = p.split(/[\\/]/u).filter(Boolean).at(-1);
  return base ? `<caminho>/${base}` : '<caminho>';
}

/**
 * Troca todo caminho absoluto de uma mensagem por `<caminho>/<basename>`. O
 * basename fica (é o id/arquivo — útil para diagnosticar e não revela a
 * estrutura da máquina); o resto some. `file://` some inteiro.
 */
export function redactPaths(message: string): string {
  return message.replace(ABS_PATH_RE, (m) => {
    if (m === '/') return m; // barra solta (ex.: `"/"` numa mensagem de regra)
    if (/^file:/iu.test(m)) return '<caminho>';
    return keepBasename(m);
  });
}

/** Mensagem pública de um erro qualquer (sem caminho absoluto). */
export function publicErrorMessage(err: unknown, fallback = 'Erro interno.'): string {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return msg ? redactPaths(msg) : fallback;
}
