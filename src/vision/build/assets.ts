// Proveniência dos assetsvendorizados por família (vai no manifesto e no
// `vision dataset list`). Versão + licença + caminhos relativos a
// `src/data/vision/`; o texto integral da licença mora ao lado dos assets.
import type { VisionAssetRef } from '../../engine/vision/index.js';

export const ASSETS: VisionAssetRef[] = [
  {
    family: 'bootstrap',
    name: 'Bootstrap',
    version: '5.3.3',
    license: 'MIT',
    files: ['vendor/bootstrap/bootstrap.min.css', 'vendor/bootstrap/LICENSE'],
  },
  {
    family: 'react95',
    name: 'React95 (React 18.3.1 + react95 4.0.0 + styled-components 6)',
    version: '4.0.0',
    license: 'MIT (+ MIT das dependências; ver vendor/react95/)',
    files: [
      'vendor/react95/app.iife.js',
      'vendor/react95/ms_sans_serif.woff2',
      'vendor/react95/ms_sans_serif_bold.woff2',
      'vendor/react95/LICENSE',
      'vendor/react95/LICENSES.md',
    ],
  },
  {
    family: 'fluent',
    name: 'Fluent UI web components',
    version: '3.1.3 + fluent-themes 0.4.0',
    license: 'MIT',
    files: [
      'vendor/fluent/fluent-web-components.min.js',
      'vendor/fluent/fluent-themes.iife.js',
      'vendor/fluent/inter-latin-wght.woff2',
      'vendor/fluent/LICENSE',
      'vendor/fluent/LICENSE-inter-OFL.txt',
    ],
  },
  {
    family: 'material',
    name: 'Material Web (Material 3)',
    version: '2.5.0',
    license: 'Apache-2.0',
    files: [
      'vendor/material/material-web.all.min.js',
      'vendor/material/roboto-latin-wght.woff2',
      'vendor/material/material-symbols-outlined.woff2',
      'vendor/material/LICENSE',
      'vendor/material/LICENSE-roboto-OFL.txt',
      'vendor/material/LICENSE-material-symbols.txt',
    ],
  },
  {
    family: 'macos',
    name: 'macOS — CSS próprio do repositório',
    version: '1',
    license: 'MIT',
    files: [],
  },
];
