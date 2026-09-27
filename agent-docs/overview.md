# Como funciona

Uma **run** é um mini-benchmark auto-contido, repetido em N **cenários**:

1. **Datagen** — um modelo recebe o tema (e um `scenarioBrief` opcional) e gera
   os cenários em lotes paralelos: uma pergunta, um contexto de produto (que
   vira o system prompt dos participantes) e um teto de tokens.
2. **Gabarito** — o modelo de referência escreve a resposta ideal de cada
   cenário, com temperatura 0 e o mesmo contexto que os participantes recebem.
3. **Participantes** — respondem ao mesmo cenário em paralelo.
4. **Julgamento pointwise** — o juiz classifica **cada resposta isoladamente**
   contra o gabarito: `resolve` / `parcial` / `nao`, com uma frase de motivo.
   O *judge-score* é `(resolve + 0,5 × parcial) / julgados × 100`. Falha do
   juiz **não é veredito**: fica ausente (fora da média) e, se passar de 10%
   num papel ou sobrarem < 5 cenários julgados, a run sai `inconclusive`.
5. **Finais** — terminado o julgamento, os **N melhores por judge-score médio**
   duelam entre si em cada cenário (Copeland: cada par nas duas ordens;
   desacordo entre as ordens = empate).

Todas as etapas rodam **em paralelo**. A concorrência das chamadas é controlada
por um limitador global adaptativo (cresce no sucesso, recua pela metade em
HTTP 429) — não existe cap por comando.

## "Contestant": o que está competindo

| Modo | O que é um contestant |
|---|---|
| `compare` | um **modelo** (ou uma tripla modelo+temperatura+raciocínio) |
| `vary` | uma **variante do prompt**, todas no mesmo modelo |
| `train` | idem, mas as variantes evoluem a cada iteração |

## O laço do `train`

- **Iteração 0** — gera variantes do prompt base aplicando técnicas de
  engenharia de prompt. O prompt base entra como **controle**.
- **Split de holdout** — depois da iteração 0, uma fatia dos cenários
  (`holdoutRatio`, padrão 0,2) é **reservada** e fica fora do treino. Com menos
  de 5 cenários reservados, o holdout é descartado e tudo treina.
- **Promoção com margem** — a melhor variante só vira campeã se superar o
  controle por pelo menos `minGain` pontos de judge-score. Sem ganho, o treino
  **convergiu** e para (continuar só queimaria custo re-testando a régua).
- **Iterações seguintes** — o campeão vira a nova base, é re-testado *verbatim*
  como controle, e as variantes recebem as **lições** das falhas dele.
- **Gate final** — campeão e base disputam nos cenários de holdout, com
  significância estatística (bootstrap pareado). É o que separa "melhorou" de
  "sobreajustou aos cenários de treino".

Se o holdout for pulado (orçamento), o resultado traz `holdoutSkipped: true` e
um aviso: **o campeão não está validado contra sobreajuste**.

## Onde ficam os dados

`~/.prompt-builder/` — `runs/`, `sessions/`, `cache/` e `key` (modo 0600).
Mude com `--data-dir` ou `$PROMPT_BUILDER_HOME`.
