# Tutorial — trocar resolução e usar grade sem cobrir o print

Este tutorial acompanha o gerador [`index.html`](./index.html). Ele produz as
mesmas variantes que o benchmark usa: **resolução** e **grade sem desenhar em
cima da captura**. As instruções abaixo são as que você deve dar ao modelo (e
as que o seu código de avaliação precisa para voltar à imagem original).

## 1. Por que não desenhar a grade em cima do print

Cobrir a UI com linhas muda o que o modelo vê: texto fino, bordas de controles
e ícones podem sumir atrás da grade. A alternativa é manter o print **intacto**
e colocar a referência espacial:

- **`frame-axis`** — o print fica dentro de uma moldura; as réguas de x/y ficam
  só nas margens;
- **`frame-mark`** — a moldura tem letras de coluna (A–F) e números de linha
  (1–4) nas margens;
- **`sidecar-grid`** — o print vai limpo e uma **segunda imagem** contém só a
  grade de referência.

Em todas, o print original não recebe nenhum pixel novo.

## 2. Reduzir a resolução (downscale) e voltar

Para uma tela original `W×H` enviada como `w×h`:

```
sx = w / W
sy = h / H
x_original = x_previsto / sx
y_original = y_previsto / sy
```

Exemplo: tela 1920×1080 enviada em 960×540 (`sx=sy=0.5`). Se o modelo
respondeu `(480, 250)`, o ponto original é `(960, 500)`.

**Nunca** compare o ponto previsto diretamente com a caixa original: ele está
na escala da imagem enviada. O benchmark faz essa conta **antes** de pontuar e
guarda `imageViewport` no record.

### Se você recortar uma região antes de reduzir

A matriz desta rodada reduziu a **imagem inteira**. Se o seu gerador recortar
uma região `(crop.x, crop.y, crop.w, crop.h)` e enviá-la em `w×h`:

```
x_original = crop.x + (x_previsto / (w / crop.w))
y_original = crop.y + (y_previsto / (h / crop.h))
```

O ponto precisa dos dois deslocamentos (origem do recorte + escala). Sem isso,
o clique cai deslocado exatamente pelo tamanho do recorte — o erro clássico de
quem reduz uma região e esquece de voltar para a tela original.

### Moldura (`frame-*`)

O print é desenhado em `(left, top)` e continua com `w×h` pixels. Peça as
coordenadas **relativas à área da captura** (origem no canto superior esquerdo
do print, `0..w` e `0..h`). Aí a conta é a mesma do downscale:

```
x_print = x_previsto
y_print = y_previsto
x_original = x_print / sx
```

As margens são só referência visual. Se você preferir pedir coordenadas da
imagem inteira (incluindo margens), a conta vira:

```
x_print = x_previsto - left
y_print = y_previsto - top
x_original = x_print / sx
```

Escolha **uma** convenção e diga isso no prompt. O gerador usa a primeira
(relativa ao print), que é a mais estável.

### Sidecar (`sidecar-grid`)

A primeira imagem é a captura limpa em `w×h`; a segunda é a grade do mesmo
tamanho. Peça coordenadas **da primeira imagem** e use a conta do downscale.
A segunda imagem não entra na conta.

## 3. Prompt recomendado

Para a captura limpa + resolução:

```text
A imagem tem {w}×{h} pixels e é a única fonte de verdade.
Responda com a ação e o ponto em PIXELS DESTA IMAGEM.
```

Para a moldura:

```text
A imagem tem {fw}×{fh} pixels. A captura da UI ocupa
x={left}..{left+w}, y={top}..{top+h}; o resto são margens com réguas.
NÃO há grade desenhada em cima da captura.
Devolva x/y em pixels da ÁREA DA CAPTURA (0..{w}, 0..{h}), com origem no
canto superior esquerdo da captura; não inclua as margens no ponto.
```

Para o sidecar:

```text
A primeira imagem é a captura limpa ({w}×{h}); a segunda é uma grade de
referência do mesmo tamanho. Use a segunda só como régua.
Devolva x/y em pixels da PRIMEIRA imagem.
```

## 4. Escolher a resolução

- **1080p** é a referência; use quando a precisão importa.
- **720p** costuma ser o melhor custo/benefício em modelos gerais; no nosso
  teste, 1280×720 teve a melhor média geral (61,1%) — mas com pouca margem.
- **540p** começa a perder texto fino; **360p** derruba o recall (29% na média).
- Para alvos pequenos, **não reduza**: recorte a região e amplie (zoom), que é
  um banco separado.

## 5. Gerar e baixar

1. Abra [`index.html`](./index.html) no navegador.
2. Selecione um PNG/JPEG da UI.
3. Informe as resoluções (uma por linha ou separadas por vírgula).
4. Marque as grades: moldura com eixos, moldura com letras ou sidecar.
5. Clique em **Gerar** e confira a prévia.
6. **Baixar tudo (.zip)** inclui os PNGs, `manifest.json` e um `INSTRUCOES.md`
   com a fórmula de remapeamento daquele conjunto.

O gerador roda 100% no navegador; nenhuma imagem sai do seu computador.

## 6. O que o `manifest.json` contém

```json
{
  "format": "vision-variants@1",
  "source": { "name": "tela.png", "width": 1920, "height": 1080 },
  "resolutions": [
    { "id": "1280x720", "file": "1280x720.png", "width": 1280, "height": 720, "sx": 0.667, "sy": 0.667 }
  ],
  "grids": [
    { "id": "frame-mark", "resolution": "1280x720", "kind": "frame",
      "file": "1280x720-frame-mark.png", "margins": { "left": 90, "top": 54, "right": 16, "bottom": 16 },
      "viewport": { "width": 1386, "height": 790 }, "cols": 6, "rows": 4 }
  ]
}
```

Use `sx`/`sy` ou `width/source.width` para voltar à tela original. Para a
moldura, lembre que as coordenadas pedidas são relativas ao print; as margens
não entram na conta (a menos que você mude a convenção do prompt).

## 7. Limites

- O gerador não conhece a verdade do DOM; ele só produz imagens e metadados.
  Para pontuar, você precisa das caixas/rótulos do seu dataset.
- Não redimensione uma imagem já com grade: gere a grade **depois** do
  downscale, para as margens e as letras continuarem legíveis.
- Uma execução não é suficiente para concluir qual combinação é melhor; use
  várias tarefas, fixe o provedor e reporte custo/latência.
