// IMPL-083 (R-10:REC-5) — CSP sem 'unsafe-eval' e ZERO violações no console.
//
// O zod v4 compila parsers de objeto com `new Function(...)` (JIT) e, para
// saber se pode, SONDA o `eval` na primeira construção de `z.object` — sob a
// CSP da Vercel (script-src sem 'unsafe-eval') a sonda lança (engolida) mas o
// navegador REPORTA a violação `script-src eval` em toda rota. Com `jitless`
// o zod nem sonda: usa o parser interpretado (mesmo resultado, sem eval).
//
// ⚠️ Tem de rodar ANTES de qualquer schema ser construído — os schemas nascem
// no topo dos módulos (src/runConfigSchema.ts, contracts, …), então este
// arquivo é o PRIMEIRO import de main.tsx (ESM avalia as dependências na
// ordem dos imports). A config do zod 4 mora em `globalThis.__zod_globalConfig`
// e vale para as DUAS cópias empacotadas (web/node_modules e a raiz, que o
// motor em src/ importa).
import { z } from 'zod';

z.config({ jitless: true });
