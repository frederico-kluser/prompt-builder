---
"prompt-builder-cli": minor
---

LGPD e release: retenção com TTL (90 dias por omissão, `PB_RETENTION_DAYS` para ajustar) e prune automático de runs, apagamento total sem resíduos (record, sobras `.tmp` da escrita atómica, dono, job, artefatos/cache e o índice de resumos) e wipe do armazenamento local da SPA (`indexedDB.deleteDatabase` + `storage.estimate` + instruções de limpar dados do site) — verificado de ponta a ponta num browser real (E2E Playwright `launch_persistent_context`). Empacotamento: `files` do package.json passou a allowlist positiva — `dist/agentRoutes.*` e os 72 `.d.ts.map` que apontavam para fora do tarball deixaram de embarcar. Publicação: `prepublishOnly` passou a correr os gates (testes, publint, attw, allowlist do tarball, smoke dos 3 bins) e o npm passa a publicar por trusted publishing (OIDC) a partir de tags, com notas de release via changesets.
