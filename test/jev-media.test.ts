// Modo JEV — MÍDIA no estado: o Base64 não é texto do prompt.
//
// Regressão que estes testes travam: antes, um caso com screenshot 1280×720
// (≈40 KB de Data URL) era contado como ~10 mil tokens de TEXTO e o
// `budget.context` recusava a run; o lint ainda acusava `state.blob`/`state.large`
// no blob que É o contrato da API. Agora o Base64 sai da conta e entra uma
// estimativa visual por área — declarada, nunca fatura.

import { describe, expect, it } from 'vitest';
import {
  IMAGE_TOKENS_PER_PIXEL_DIVISOR,
  UNKNOWN_IMAGE_TOKENS,
  decodeMediaUrl,
  estimateVisualTokens,
  imageSizeOf,
  isMediaPart,
  lintJevCases,
  lintJevSpec,
  mediaProfileFor,
  splitMedia,
  validateMedia,
  withSpecId,
  type JevCase,
  type JevQuestionSpec,
  type JevSpec,
} from '../src/engine/jev/index.js';
import { countTextTokens } from '../src/openrouter.js';
import type { OpenRouterModel } from '../src/types.js';

const spec = (questions: unknown[], extra: Partial<JevSpec> = {}): JevSpec =>
  withSpecId({ label: 't', questions: questions as JevQuestionSpec[], ...extra });

/** PNG mínimo com IHDR real (o parser só lê o cabeçalho) + IDAT de enchimento. */
function pngDataUrl(width: number, height: number, fillBytes = 0): string {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; // bit depth
  ihdr[17] = 2; // RGB
  const pad = Buffer.alloc(fillBytes, 0x41);
  return `data:image/png;base64,${Buffer.concat([sig, ihdr, pad]).toString('base64')}`;
}

/** JPEG mínimo: SOI + APP0 + SOF0 com as dimensões. */
function jpegDataUrl(width: number, height: number): string {
  const bytes = Buffer.from([
    0xff, 0xd8,
    // APP0 (JFIF) com 16 bytes
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    // SOF0: len, precision, height, width, components
    0xff, 0xc0, 0x00, 0x0b, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0x01,
    0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
  return `data:image/jpeg;base64,${bytes.toString('base64')}`;
}

const imagePart = (url: string): Record<string, unknown> => ({ type: 'image_url', image_url: { url } });
const visionQuestions = [
  { id: 'visible', type: 'noul', instructions: 'Is the labelled control visible?' },
  {
    id: 'kind',
    type: 'choice',
    instructions: 'What kind of control is it?',
    criteria: { button: 'Pressable', input: 'Text entry', other: null },
  },
];

describe('mídia: deteção, dimensões e estimativa', () => {
  it('lê as dimensões de PNG e de JPEG sem Buffer no módulo do motor', () => {
    const png = decodeMediaUrl(pngDataUrl(1280, 720, 4096));
    expect(png?.mime).toBe('image/png');
    expect(imageSizeOf(png!.b64)).toEqual({ width: 1280, height: 720 });
    const jpeg = decodeMediaUrl(jpegDataUrl(960, 540));
    expect(jpeg?.mime).toBe('image/jpeg');
    expect(imageSizeOf(jpeg!.b64)).toEqual({ width: 960, height: 540 });
  });

  it('recusa URL remoto, base64 nu, prefixo errado e payload não canónico', () => {
    expect(decodeMediaUrl('https://exemplo.invalid/a.png')).toBeNull();
    expect(decodeMediaUrl('iVBORw0KGgo=')).toBeNull();
    expect(decodeMediaUrl('data:image/png,AAA')).toBeNull();
    expect(decodeMediaUrl(`data:image/png;base64,${'A'.repeat(5)}`)).toBeNull();
  });

  it('separa mídia do texto: o Data URL vira marcador e o Base64 sai da conta', () => {
    const url = pngDataUrl(1280, 720, 40_000);
    const state = ['Contexto.', imagePart(url)];
    const { value, parts } = splitMedia(state);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ kind: 'image', width: 1280, height: 720, topLevel: true, mime: 'image/png' });
    const texto = JSON.stringify(value);
    expect(texto).toContain('[imagem 1280×720]');
    expect(texto).not.toContain('base64');
    // Prova do bug: o texto que o tokenizador via antes era dezenas de milhares de chars.
    expect(JSON.stringify(state).length).toBeGreaterThan(40_000);
    expect(texto.length).toBeLessThan(200);
  });

  it('estima tokens visuais pela área e usa o valor conservador quando não há dimensões', () => {
    const { parts } = splitMedia([imagePart(pngDataUrl(1280, 720))]);
    expect(estimateVisualTokens(parts)).toBe(Math.ceil((1280 * 720) / IMAGE_TOKENS_PER_PIXEL_DIVISOR));
    const semDimensao = decodeMediaUrl(`data:image/png;base64,${Buffer.alloc(1200, 7).toString('base64')}`)!;
    const { parts: sem } = splitMedia([
      { type: 'image_url', image_url: { url: `data:image/png;base64,${semDimensao.b64}` } },
    ]);
    expect(sem[0].width).toBeNull();
    expect(estimateVisualTokens(sem)).toBe(UNKNOWN_IMAGE_TOKENS);
  });

  it('reconhece parte de mídia e perfil do adaptador (alias móvel não herda limites)', () => {
    expect(isMediaPart(imagePart('data:image/png;base64,AAAA'))).toBe(true);
    expect(isMediaPart({ type: 'text', text: 'x' })).toBe(false);
    expect(mediaProfileFor('typesafe/jev-1.14').maxAxis).toBe(1568);
    expect(mediaProfileFor('jev-1.13').nested).toBe(true);
    expect(mediaProfileFor('cloudflare/clef-omni').kinds).toContain('video');
    expect(mediaProfileFor('~typesafe/jev-latest').id).toBe('generic');
  });
});

describe('validação de mídia por adaptador', () => {
  it('erro em posição aninhada só no adaptador que não lê imagem fora do topo', () => {
    const parts = splitMedia({ screenshot: imagePart(pngDataUrl(1280, 720)) }).parts;
    const codes = (id: string) => validateMedia(parts, mediaProfileFor(id)).map((i) => i.code);
    expect(codes('typesafe/jev-1.14')).not.toContain('state.media_position');
    expect(codes('cloudflare/clef-omni')).toContain('state.media_position');
  });

  it('recusa eixo fora de 280..1568, formato não aceito, bytes acima do teto e excesso de imagens', () => {
    const pequena = splitMedia([imagePart(pngDataUrl(200, 200))]).parts;
    expect(validateMedia(pequena, mediaProfileFor('typesafe/jev-1.14')).map((i) => i.code)).toContain('state.media_axis');
    const webp = splitMedia([imagePart(`data:image/webp;base64,${Buffer.alloc(400, 3).toString('base64')}`)]).parts;
    expect(validateMedia(webp, mediaProfileFor('typesafe/jev-1.14')).map((i) => i.code)).toContain('state.media_mime');
    const grande = splitMedia([imagePart(pngDataUrl(800, 600, 4 * 1024 * 1024))]).parts;
    expect(validateMedia(grande, mediaProfileFor('cloudflare/clef-omni')).map((i) => i.code)).toContain('state.media_size');
    const cinco = Array.from({ length: 5 }, () => imagePart(pngDataUrl(800, 600)));
    expect(validateMedia(splitMedia(cinco).parts, mediaProfileFor('cloudflare/clef-omni')).map((i) => i.code)).toContain(
      'state.media_count',
    );
  });

  it('vídeo no Jev é erro explícito (frames ou outro modelo), nunca texto disfarçado', () => {
    const video = splitMedia([{ type: 'video_url', video_url: { url: `data:video/mp4;base64,${Buffer.alloc(800, 1).toString('base64')}` } }]).parts;
    expect(validateMedia(video, mediaProfileFor('typesafe/jev-1.14')).map((i) => i.code)).toContain('state.media_unsupported');
    expect(validateMedia(video, mediaProfileFor('cloudflare/clef-omni')).map((i) => i.code)).not.toContain(
      'state.media_unsupported',
    );
  });

  it('parte malformada é ERRO estrutural (não entra como JSON comum)', () => {
    const parts = splitMedia([{ type: 'image_url', image_url: { url: 'https://exemplo.invalid/x.png' } }]).parts;
    const issues = validateMedia(parts, mediaProfileFor('typesafe/jev-1.14'));
    expect(issues.map((i) => i.code)).toContain('state.media_invalid');
  });
});

describe('orçamento de contexto com imagem (regressão)', () => {
  const modelo = { id: 'typesafe/jev-1.14', contextLength: 65_536 } as unknown as OpenRouterModel;
  const caso = (url: string): JevCase => ({
    id: 'c1',
    state: ['Use only the attached screenshot as visual evidence.', imagePart(url)],
    expected: { visible: true, kind: 'button' },
    split: 'train',
  });

  it('o mesmo estado passava de 65.536 "tokens" de texto e agora cabe', () => {
    const c = caso(pngDataUrl(1280, 720, 40_000));
    const s = spec(visionQuestions);
    const bruto = countTextTokens(JSON.stringify(c.state));
    expect(bruto).toBeGreaterThan(10_000); // o que o tokenizador via antes
    const issues = lintJevSpec(s, { model: modelo, modelId: 'typesafe/jev-1.14', cases: [c] });
    expect(issues.filter((i) => i.code === 'budget.context')).toHaveLength(0);
    expect(issues.filter((i) => i.code === 'state.media').length).toBeGreaterThan(0);
    expect(issues.every((i) => i.level !== 'error')).toBe(true);
  });

  it('o lint de casos não acusa blob/large num Data URL legítimo, mas acusa base64 fora da mídia', () => {
    const s = spec(visionQuestions);
    const legit = lintJevCases([caso(pngDataUrl(1280, 720, 40_000))], s);
    expect(legit.map((i) => i.code)).not.toContain('state.blob');
    expect(legit.map((i) => i.code)).not.toContain('state.large');
    const ruido = lintJevCases([{ ...caso(pngDataUrl(640, 480)), state: 'x'.repeat(500) + Buffer.alloc(400, 9).toString('base64') }], s);
    expect(ruido.map((i) => i.code)).toContain('state.blob');
  });

  it('o erro de contexto continua valendo quando há texto demais além da mídia', () => {
    const c: JevCase = {
      ...caso(pngDataUrl(1280, 720)),
      state: ['y'.repeat(400_000), imagePart(pngDataUrl(1280, 720))],
    };
    const issues = lintJevSpec(spec(visionQuestions), { model: modelo, modelId: 'typesafe/jev-1.14', cases: [c] });
    expect(issues.map((i) => i.code)).toContain('budget.context');
  });
});
