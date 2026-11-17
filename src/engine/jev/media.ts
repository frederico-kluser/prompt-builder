// Modo JEV — MÍDIA no `state` (image_url/video_url) e contabilização HONESTA.
//
// Por que existe: o tokenizador do produto conta CARACTERES (chars/4). Num caso
// com imagem, o Data URL Base64 tem dezenas de milhares de caracteres — o
// `budget.context` recusava um pedido perfeitamente válido (1280×720 ≈ 40 KB de
// Base64 = ~10 mil "tokens" de texto que o provedor NÃO cobra como texto) e o
// lint acusava `state.blob`/`state.large` num blob que é o contrato da API.
// Aqui o Base64 sai da conta de TEXTO e entra uma estimativa de tokens VISUAIS
// (por resolução) — declaradamente uma estimativa: o custo real vem de
// `usage.cost`, e o teto duro continua valendo.
//
// Módulo PURO (sem Node, sem zod): o barrel `engine/jev/index.ts` é re-exportado
// pelo shim da SPA, então nada de `node:*`, `Buffer` ou `process`.

/** Mídia que o contrato de decisões da OpenRouter aceita em `state`. */
export type JevMediaKind = 'image' | 'video';

/** Parte de mídia encontrada no estado (já validada estruturalmente). */
export interface JevMediaPart {
  kind: JevMediaKind;
  /** Caminho legível onde aparece: `state`, `state[1]`, `state.docs[0]`. */
  path: string;
  mime: string;
  bytes: number;
  /** Dimensões quando o cabeçalho está nos primeiros bytes (PNG/JPEG). */
  width: number | null;
  height: number | null;
  /** Topo do array `state` (única posição aceita fora do adaptador TypeSafe). */
  topLevel: boolean;
}

/** Limites por ADAPTADOR, não por nome de modelo (documentado em agent-docs/jev.md). */
export interface JevMediaProfile {
  id: string;
  /** Imagens aceitas por pedido (null = sem teto conhecido → validação só estrutural). */
  maxImages: number | null;
  maxImageBytes: number | null;
  minAxis: number | null;
  maxAxis: number | null;
  /** Aceita `image_url` aninhado (objetos do state) — só o adaptador TypeSafe. */
  nested: boolean;
  kinds: readonly JevMediaKind[];
  /** Formatos aceitos (`data:image/png` → `image/png`). */
  mimes: readonly string[];
}

const MIB = 1024 * 1024;

/** Estimativa de tokens visuais por área processada (chars/4 não vale para imagem). */
export const IMAGE_TOKENS_PER_PIXEL_DIVISOR = 750;
/** Sem dimensões no cabeçalho: valor conservador único (não finge precisão). */
export const UNKNOWN_IMAGE_TOKENS = 1800;
/** Vídeo nativo é amostrado pelo provedor (2 fps no Clef); teto conservador. */
export const VIDEO_TOKENS_ESTIMATE = 12_000;

export const MEDIA_PROFILES: Readonly<Record<string, JevMediaProfile>> = Object.freeze({
  typesafe: {
    id: 'typesafe',
    maxImages: 64,
    maxImageBytes: 16 * MIB,
    minAxis: 280,
    maxAxis: 1568,
    nested: true,
    kinds: ['image'],
    mimes: ['image/png', 'image/jpeg'],
  },
  'cloudflare-omni': {
    id: 'cloudflare-omni',
    maxImages: 4,
    maxImageBytes: 4 * MIB,
    minAxis: null,
    maxAxis: null,
    nested: false,
    kinds: ['image', 'video'],
    mimes: ['image/png', 'image/jpeg', 'image/webp'],
  },
  /** Famílias com imagem no catálogo mas cujos limites por adaptador não temos. */
  generic: {
    id: 'generic',
    maxImages: null,
    maxImageBytes: 32 * MIB,
    minAxis: null,
    maxAxis: null,
    nested: false,
    kinds: ['image'],
    mimes: ['image/png', 'image/jpeg', 'image/webp'],
  },
});

/** Perfil do adaptador para o id do modelo (alias móvel fica no perfil genérico). */
export function mediaProfileFor(modelId?: string): JevMediaProfile {
  const id = (modelId ?? '').trim();
  if (/^(?:typesafe\/)?jev-(?:1\.1[34])(?:\.0|-\d{8})?$/.test(id)) return MEDIA_PROFILES.typesafe;
  if (id === 'cloudflare/clef-omni') return MEDIA_PROFILES['cloudflare-omni'];
  return MEDIA_PROFILES.generic;
}

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_MAP: Int16Array = (() => {
  const m = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_CHARS.length; i++) m[B64_CHARS.charCodeAt(i)] = i;
  return m;
})();

/** Decodifica só os primeiros `limit` bytes (cabeçalho) sem `Buffer`/Node. */
function b64Head(b64: string, limit: number): Uint8Array {
  const take = Math.min(b64.length, Math.ceil(limit / 3) * 4);
  const out = new Uint8Array(Math.floor(take * 0.75) + 3);
  let o = 0;
  for (let i = 0; i + 3 < take; i += 4) {
    const a = B64_MAP[b64.charCodeAt(i)];
    const b = B64_MAP[b64.charCodeAt(i + 1)];
    const c = B64_MAP[b64.charCodeAt(i + 2)];
    const d = B64_MAP[b64.charCodeAt(i + 3)];
    if (a < 0 || b < 0) break;
    out[o++] = (a << 2) | (b >> 4);
    if (c >= 0) {
      out[o++] = ((b & 15) << 4) | (c >> 2);
      if (d >= 0) out[o++] = ((c & 3) << 6) | d;
    }
  }
  return out.subarray(0, o);
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

/** PNG: IHDR logo após a assinatura. JPEG: varre os marcadores até um SOFn. */
export function imageSizeOf(b64: string): { width: number; height: number } | null {
  const head = b64Head(b64, 96 * 1024);
  const u16 = (at: number): number => (head[at] << 8) | head[at + 1];
  const u32 = (at: number): number => ((head[at] << 24) | (head[at + 1] << 16) | (head[at + 2] << 8) | head[at + 3]) >>> 0;
  if (head.length >= 24 && PNG_SIGNATURE.every((v, i) => head[i] === v)) {
    if (String.fromCharCode(head[12], head[13], head[14], head[15]) !== 'IHDR') return null;
    const width = u32(16);
    const height = u32(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (head.length >= 4 && head[0] === 0xff && head[1] === 0xd8) {
    let i = 2;
    while (i + 9 < head.length) {
      if (head[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = head[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      if (marker === 0xda || marker === 0xd9) return null;
      const size = u16(i + 2);
      if (size < 2) return null;
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof && i + 9 < head.length) {
        const height = u16(i + 5);
        const width = u16(i + 7);
        return width > 0 && height > 0 ? { width, height } : null;
      }
      i += 2 + size;
    }
  }
  return null;
}

/** `data:<mime>;base64,<payload>` → mime + bytes decodificados (null se inválido). */
export function decodeMediaUrl(url: unknown): { mime: string; b64: string; bytes: number } | null {
  if (typeof url !== 'string') return null;
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
  if (!m) return null;
  const b64 = m[2];
  if (!b64 || b64.length % 4 !== 0) return null;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return { mime: m[1].toLowerCase(), b64, bytes: (b64.length / 4) * 3 - padding };
}

export function isMediaPart(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.type === 'image_url' || v.type === 'video_url';
}

/**
 * Separa TEXTO de MÍDIA num estado: o valor devolvido tem os Data URLs trocados
 * por um marcador curto (`[imagem 1280×720]`) e `parts` traz as dimensões.
 * É o mesmo walk que o provedor faz; nenhuma parte é modificada no fio.
 */
export function splitMedia(state: unknown): { value: unknown; parts: JevMediaPart[] } {
  const parts: JevMediaPart[] = [];
  const walk = (node: unknown, path: string, topLevel: boolean): unknown => {
    if (Array.isArray(node)) return node.map((child, i) => walk(child, `${path}[${i}]`, path === 'state'));
    if (node === null || typeof node !== 'object') return node;
    const obj = node as Record<string, unknown>;
    if (obj.type === 'image_url' || obj.type === 'video_url') {
      const kind: JevMediaKind = obj.type === 'image_url' ? 'image' : 'video';
      const payload = obj[kind === 'image' ? 'image_url' : 'video_url'];
      const url = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>).url : undefined;
      const decoded = decodeMediaUrl(url);
      const size = decoded && kind === 'image' ? imageSizeOf(decoded.b64) : null;
      parts.push({
        kind,
        path,
        mime: decoded?.mime ?? 'desconhecido',
        bytes: decoded?.bytes ?? 0,
        width: size?.width ?? null,
        height: size?.height ?? null,
        topLevel,
      });
      const marcador = size ? `[${kind === 'image' ? 'imagem' : 'vídeo'} ${size.width}×${size.height}]` : `[${kind}]`;
      return marcador;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = walk(v, `${path}.${k}`, false);
    return out;
  };
  return { value: walk(state, 'state', true), parts };
}

/** Estimativa de tokens de ENTRADA que as partes de mídia acrescentam. */
export function estimateVisualTokens(parts: readonly JevMediaPart[]): number {
  let total = 0;
  for (const p of parts) {
    if (p.kind === 'video') {
      total += VIDEO_TOKENS_ESTIMATE;
      continue;
    }
    total +=
      p.width && p.height
        ? Math.min(4096, Math.max(1, Math.ceil((p.width * p.height) / IMAGE_TOKENS_PER_PIXEL_DIVISOR)))
        : UNKNOWN_IMAGE_TOKENS;
  }
  return total;
}

export interface JevMediaIssue {
  level: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  path: string;
}

/** Valida as partes contra o PERFIL DO ADAPTADOR (o que o fio aceita de fato). */
export function validateMedia(parts: readonly JevMediaPart[], profile: JevMediaProfile): JevMediaIssue[] {
  const issues: JevMediaIssue[] = [];
  const images = parts.filter((p) => p.kind === 'image');
  if (parts.length === 0) return issues;
  for (const p of parts) {
    if (!profile.kinds.includes(p.kind)) {
      issues.push({
        level: 'error',
        code: 'state.media_unsupported',
        path: p.path,
        message: `${p.kind === 'image' ? 'imagem' : 'vídeo'} no estado, mas o adaptador "${profile.id}" não lê ${p.kind} — envie frames/imagem ou troque o modelo.`,
      });
      continue;
    }
    if (p.bytes === 0 || p.mime === 'desconhecido') {
      issues.push({
        level: 'error',
        code: 'state.media_invalid',
        path: p.path,
        message: 'parte de mídia sem Data URL base64 válido (`data:image/png;base64,...`) — não é enviável como texto.',
      });
      continue;
    }
    if (!profile.mimes.includes(p.mime)) {
      issues.push({
        level: 'error',
        code: 'state.media_mime',
        path: p.path,
        message: `formato "${p.mime}" não aceito pelo adaptador "${profile.id}" (${profile.mimes.join(', ')}).`,
      });
    }
    if (profile.maxImageBytes && p.bytes > profile.maxImageBytes) {
      issues.push({
        level: 'error',
        code: 'state.media_size',
        path: p.path,
        message: `${p.bytes} bytes > teto de ${profile.maxImageBytes} do adaptador "${profile.id}" (base64 inclui ~⅓).`,
        });
    }
    if (p.kind === 'image' && p.width && p.height && profile.minAxis && profile.maxAxis) {
      const menor = Math.min(p.width, p.height);
      const maior = Math.max(p.width, p.height);
      if (menor < profile.minAxis || maior > profile.maxAxis) {
        issues.push({
          level: 'error',
          code: 'state.media_axis',
          path: p.path,
          message: `${p.width}×${p.height} fora de ${profile.minAxis}..${profile.maxAxis} px/eixo — redimensione (padding preserva as frações).`,
        });
      }
    }
    if (!p.topLevel && !profile.nested) {
      issues.push({
        level: 'error',
        code: 'state.media_position',
        path: p.path,
        message: 'este adaptador só lê image_url no TOPO do array `state`; mova a parte para `state[]`.',
      });
    }
    if (p.kind === 'image' && !p.width) {
      issues.push({
        level: 'warning',
        code: 'state.media_unmeasured',
        path: p.path,
        message: 'não consegui ler as dimensões do cabeçalho (PNG/JPEG): a estimativa de tokens usa 1800 e os limites de eixo não são conferidos.',
      });
    }
  }
  if (profile.maxImages !== null && images.length > profile.maxImages) {
    issues.push({
      level: 'error',
      code: 'state.media_count',
      path: 'state',
      message: `${images.length} imagens > ${profile.maxImages} do adaptador "${profile.id}".`,
    });
  }
  if (images.length > 0) {
    const tokens = estimateVisualTokens(parts);
    issues.push({
      level: 'info',
      code: 'state.media',
      path: 'state',
      message: `${images.length} imagem(ns), ~${tokens} tokens visuais estimados (Base64 fora da conta de texto; o custo real vem de usage.cost).`,
    });
  }
  return issues;
}
