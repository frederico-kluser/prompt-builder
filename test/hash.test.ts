import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, contentHash, sha256Hex } from '../src/engine/hash.js';

describe('hash — fonte única de identidade de conteúdo', () => {
  it('sha256Hex bate com os vetores oficiais e com node:crypto', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const samples = ['a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'ação — 数据 🚀', 'x'.repeat(1000)];
    for (const s of samples) {
      expect(sha256Hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
    }
  });

  it('canonicalJson ordena chaves, remove espaços e ignora undefined', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], c: undefined })).toBe('{"a":[true,null,"x"],"b":1}');
    expect(canonicalJson({ z: { y: 2, x: 1 } })).toBe('{"z":{"x":1,"y":2}}');
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson(1e21)).toBe('1e+21');
    expect(() => canonicalJson(Number.NaN)).toThrow();
  });

  it('ordena chaves por unidade de código UTF-16 (vetor do RFC 8785 §3.2.3)', () => {
    const obj = {
      '\u20ac': 'Euro',
      '\r': 'CR',
      '\ufb33': 'Hebrew',
      '1': 'One',
      '\ud83d\ude00': 'Smiley',
      '\u0080': 'Ctrl',
      '\u00f6': 'Latin',
    };
    // Object.keys não serve para conferir: em JS a chave inteira '1' vem sempre primeiro.
    const esperado =
      '{"\\r":"CR","1":"One","\u0080":"Ctrl","\u00f6":"Latin","\u20ac":"Euro","\ud83d\ude00":"Smiley","\ufb33":"Hebrew"}';
    expect(canonicalJson(obj)).toBe(esperado);
  });

  it('contentHash é estável à ordem das chaves e muda com o conteúdo', () => {
    const a = contentHash({ question: 'q', rubric: 'r', tags: ['x'] });
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(contentHash({ tags: ['x'], rubric: 'r', question: 'q' })).toBe(a);
    expect(contentHash({ question: 'q', rubric: 'r2', tags: ['x'] })).not.toBe(a);
  });
});
