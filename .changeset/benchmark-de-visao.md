---
"prompt-builder-cli": minor
---

Benchmark de visão (UI grounding): o modelo lê uma captura 1080p de uma UI real
(Bootstrap, React95, Fluent UI, Material 3 e macOS) e devolve os elementos
clicáveis (`map`) ou a ação pedida com a posição (`action`). Dataset versionado
e pinado por sha256 em `src/data/vision/`, verdade tirada do DOM (sem juiz LLM),
placar determinístico (ponto na caixa + rótulo/tipo) e relatório Markdown/HTML.
CLI novo: `prompt-builder vision run|list|show|report|dataset`; o gateway passou
a suportar imagem (`ChatMessage.images`), com recusa fail-closed no modo LGPD
sensível. Na SPA, `/vision` escolhe N cenários do banco, mostra a tela do teste
no hover e o resultado em matriz cenário × modelo com mapa de calor por modelo
(IndexedDB v4). Roadmap completo em `ROADMAP-VISAO.md`.
