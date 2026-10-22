# Gerador de variantes — resolução e grade

Abre [`index.html`](./index.html) no navegador. Ele gera, a partir de uma
captura PNG/JPEG/WebP:

- downscales em qualquer lista de resoluções (ex.: 1920×1080, 1280×720,
  960×540, 640×360);
- **frame-axis** — print intacto dentro de uma moldura, réguas de x/y nas margens;
- **frame-mark** — moldura com letras de coluna (A–F) e números de linha (1–4);
- **sidecar-grid** — print limpo + uma segunda imagem só com a grade;
- **ZIP** com os PNGs, `manifest.json` (escalas, margens, células) e
  `INSTRUCOES.md` (prompts e fórmula de remapeamento).

Nenhuma imagem sai do navegador: tudo é canvas local.

O tutorial completo, incluindo a conta para voltar à imagem original, está em
[`INSTRUCOES.md`](./INSTRUCOES.md). Exemplos gerados pelo build:
[`exemplos/`](./exemplos/). Pacote pronto para baixar:
[`gerador-de-variantes.zip`](./gerador-de-variantes.zip).

**Regra de ouro:** a grade nunca é desenhada em cima do print. Se você usar
moldura, peça coordenadas da **área da captura** (0..w, 0..h), não da imagem
inteira; assim a conta de volta é só dividir por `sx`/`sy`.
