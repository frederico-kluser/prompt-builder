# App React95 do cenário `react95-painel`

`app.jsx` é o app React de verdade (React 18 + `react95` 4 + styled-components 6)
que o bundle `src/data/vision/vendor/react95/app.iife.js` contém. O HTML do
cenário só carrega o IIFE — nenhuma rede em tempo de render.

## Reconstruir o bundle

```bash
d=$(mktemp -d)
npm install --prefix "$d" react@18.3.1 react-dom@18.3.1 styled-components@6 react95@4.0.0 esbuild@0.28
node scripts/vision-react95-build.mjs "$d/node_modules" "$d/app.iife.js"
cp "$d/app.iife.js" src/data/vision/vendor/react95/app.iife.js
npm run vision:build -- --only react95
```

O contrato do bundle é: um único arquivo IIFE, sem imports em runtime, com
React/styled-components embutidos (o `scripts/vision-react95-build.mjs` fixa
`NODE_ENV=production`, JSX automático e minify). Se o app mudar, o
`npm run vision:build` gera a imagem nova e atualiza o manifesto — o dataset
inteiro muda de hash e isso é esperado.
