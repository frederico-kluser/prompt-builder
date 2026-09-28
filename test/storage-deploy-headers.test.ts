// IMPL-083 (R-10:REC-5) — o vercel.json saía SEM nenhum header de segurança:
// sem CSP (a SPA guarda a key do OpenRouter no localStorage), sem
// frame-ancestors, nosniff, Referrer-Policy, Permissions-Policy nem COOP.
//
// Este contrato cobre o que é verificável SEM deploy:
//  (i) os headers todos existem com os valores exigidos;
//  (iii) o hash 'sha256-…' do script INLINE de tema bate com o HTML REAL — se o
//        script de web/index.html (ou o web/dist/index.html construído) mudar,
//        o teste falha até o hash ser regerado. O hash é SEMPRE medido aqui
//        (nunca copiado à mão entre arquivos): sha256 em base64 do corpo do
//        <script>, exatamente como o navegador calcula.
//  — nada de 'unsafe-inline'/'unsafe-eval' em script-src, style-src sem
//    'unsafe-inline', e o access-control-allow-origin: * legado continua FORA.
//
// O que exige deploy e por isso fica como pendência declarada de IMPL-083:
// curl -sI no deploy (i), 0 violações de CSP no console das telas e dos
// AnimatePresence popLayout (ii) e a auditoria Mozilla Observatory ≥ B+ (iv).

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

interface HeaderEntry {
  key: string;
  value: string;
}

interface VercelConfig {
  rewrites?: unknown;
  headers?: Array<{ source: string; headers: HeaderEntry[] }>;
}

function vercel(): VercelConfig {
  return JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf-8')) as VercelConfig;
}

function headersOf(cfg: VercelConfig): Map<string, string> {
  const grupo = (cfg.headers ?? []).find((h) => h.source === '/(.*)');
  expect(grupo, 'headers para /(.*) (SPA inteira)').toBeDefined();
  const mapa = new Map<string, string>();
  for (const h of grupo!.headers) mapa.set(h.key.toLowerCase(), h.value);
  return mapa;
}

function cspDirective(csp: string, nome: string): string {
  const dir = csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.toLowerCase().startsWith(nome));
  expect(dir, `diretiva ${nome} na CSP`).toBeDefined();
  return dir!;
}

/** Hash CSP ('sha256-<base64>') dos scripts INLINE de um HTML. */
function inlineScriptHashes(htmlPath: string): string[] {
  const html = readFileSync(htmlPath, 'utf-8');
  const out: string[] = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  for (const m of html.matchAll(re)) {
    const corpo = m[1];
    out.push(`'sha256-${createHash('sha256').update(corpo, 'utf-8').digest('base64')}'`);
  }
  return out;
}

describe('vercel.json — headers de segurança da SPA (IMPL-083)', () => {
  it('CSP com frame-ancestors, fontes justas e SEM unsafe-inline/unsafe-eval', () => {
    const h = headersOf(vercel());
    const csp = h.get('content-security-policy');
    expect(csp, 'Content-Security-Policy presente').toBeDefined();
    const c = csp!;

    expect(cspDirective(c, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(cspDirective(c, 'default-src')).toBe("default-src 'self'");
    expect(cspDirective(c, 'object-src')).toBe("object-src 'none'");
    expect(cspDirective(c, 'base-uri')).toBe("base-uri 'self'");
    // style-src 'self' SEM 'unsafe-inline' (se o CSS runtime do popLayout do
    // Motion bloquear, a saída é nonce via MotionConfig — não abrir o style-src).
    expect(cspDirective(c, 'style-src')).toBe("style-src 'self'");
    // A SPA fala direto com o OpenRouter (BYOK); nenhum outro host em connect.
    expect(cspDirective(c, 'connect-src')).toContain('https://openrouter.ai');
    const scriptSrc = cspDirective(c, 'script-src');
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(scriptSrc).not.toContain('unsafe-eval');
  });

  it('hash do script inline de tema bate com o HTML (crit. iii)', () => {
    const csp = headersOf(vercel()).get('content-security-policy')!;
    const scriptSrc = cspDirective(csp, 'script-src');
    const hashes = inlineScriptHashes(join(ROOT, 'web', 'index.html'));
    expect(hashes.length, 'web/index.html tem 1 script inline de tema').toBe(1);
    for (const h of hashes) {
      expect(scriptSrc, `script-src carrega o hash medido do HTML (${h})`).toContain(h);
    }
    // Se existir build, o HTML DEPLOYADO tem de bater com o mesmo hash — é o
    // que o navegador efetivamente recebe.
    const distHtml = join(ROOT, 'web', 'dist', 'index.html');
    let dist: string[] = [];
    try {
      dist = inlineScriptHashes(distHtml);
    } catch {
      dist = []; // sem build neste checkout: o teste do fonte já amarra o hash
    }
    for (const h of dist) {
      expect(scriptSrc, 'hash bate também com o web/dist/index.html construído').toContain(h);
    }
  });

  it('nosniff, Referrer-Policy, Permissions-Policy mínima, COOP e X-Frame-Options', () => {
    const h = headersOf(vercel());
    expect(h.get('x-content-type-options')).toBe('nosniff');
    expect(h.get('x-frame-options')).toBe('DENY');
    expect(h.get('referrer-policy')).toBe('no-referrer');
    const pp = h.get('permissions-policy');
    expect(pp, 'Permissions-Policy presente').toBeDefined();
    for (const alvo of ['camera=()', 'microphone=()', 'geolocation=()']) {
      expect(pp).toContain(alvo);
    }
    expect(h.get('cross-origin-opener-policy')).toBe('same-origin');
  });

  it('sem access-control-allow-origin: * e com os rewrites da SPA preservados', () => {
    const texto = JSON.stringify(vercel()).toLowerCase();
    expect(texto, 'o header legado ACAO * não volta').not.toContain('access-control-allow-origin');
    const cfg = vercel();
    expect(cfg.rewrites).toEqual([{ source: '/(.*)', destination: '/index.html' }]);
  });
});