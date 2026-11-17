---
"prompt-builder-cli": minor
---

Modo JEV com **mídia no estado**: `{type:'image_url', image_url:{url:'data:image/png;base64,…'}}`
atravessa `state` como está e a comparação de SOMs de imagem funciona de ponta a
ponta. O motor deixou de contar o Data URL como texto (chars/4): o Base64 sai da
conta e entra uma **estimativa visual por área** (~área/750, máx. 4096; 1800 sem
dimensões legíveis; 12 000 para vídeo), declarada como estimativa — o custo real
continua a vir de `usage.cost`. Consequências:

- `budget.context` deixa de recusar imagens legítimas (um screenshot 1280×720
  passava de ~10 mil "tokens" e derrubava a run; agora cabe);
- `state.blob`/`state.large` deixam de acusar um Data URL que É o contrato da API
  (base64 fora da mídia continua avisado);
- validação por **perfil de adaptador** (`mediaProfileFor`): TypeSafe/jev —
  PNG/JPEG, 280..1568 px/eixo, 16 MiB, até 64, imagem em qualquer nível; Clef
  Omni — 4 MiB, até 4, só no topo + vídeo nativo; demais famílias com imagem no
  catálogo — perfil genérico. Códigos novos: `state.media_axis`, `state.media_size`,
  `state.media_mime`, `state.media_count`, `state.media_position`,
  `state.media_unsupported`, `state.media_invalid`, `state.media_unmeasured`;
- doc de agente em `agent-docs/jev.md` (posição, limites, ouro de UI do DOM e a
  regra presença≠localização) e regressões em `test/jev-media.test.ts`.

Motivação medida: uma comparação de sete SOMs em 28 casos de UI estimava
US$ 0,38–0,71 com o Base64 contado como texto; com a conta correta ficou em
US$ 0,046–0,087 e o custo real foi US$ 0,047.
