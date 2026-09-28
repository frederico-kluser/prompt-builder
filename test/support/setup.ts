// Suíte RÁPIDA por omissão (`npm test`): as camadas pesadas — containers Docker
// reais, E2E browser e simulações Monte Carlo grandes — ficam para
// `npm run test:full` (PB_FULL=1). O core (benchmark → apontar melhor prompt,
// com "sem ganho" como resultado válido) é testado nos DOIS modos; o que muda
// é o tamanho da simulação e a camada de integração.
if (process.env.PB_FULL !== '1') {
  process.env.PB_FAST = '1';
  if (process.env.PB_SKIP_DOCKER_TESTS === undefined) process.env.PB_SKIP_DOCKER_TESTS = '1';
}
