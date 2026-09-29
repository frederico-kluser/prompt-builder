# `data/calibration/` — conjuntos de calibração juiz × humano

Aqui ficam os conjuntos **rotulados por pessoas** que respondem "o juiz LLM
serve neste domínio?" (IMPL-058, R-03a:REC-4). Um arquivo por domínio:
`data/calibration/<dominio>.jsonl`, formato `calibration-jsonl@1`. Ao contrário
do resto de `data/` (runs e sessões em runtime, fora do git), **esta pasta é
versionada**: rótulo humano é trabalho caro e precisa de histórico.

> Estado (2026-09-28): o formato, o relatório (`prompt-builder calib report`) e
> os testes existem. **Nenhum conjunto real existe ainda** — os ≥ 150 itens com
> ≥ 2 rótulos humanos por item e o piloto anotador × anotador dependem de
> anotadores humanos e não podem ser gerados por código. Não commite itens
> inventados como se fossem reais: exemplo vai com `"synthetic": true`.

## Começar

```bash
prompt-builder calib template -o data/calibration/<dominio>.jsonl   # exemplo comentado, itens SINTÉTICOS
prompt-builder docs calibration                                     # formato completo e códigos de saída
```

Substitua os itens sintéticos pelos seus. Formato, campo a campo, em
`prompt-builder docs calibration` (fonte: `agent-docs/calibration.md`).

## Protocolo do piloto (faça ANTES de medir o juiz)

1. **Rubrica escrita.** Uma página dizendo quando é `resolve`, `parcial` e
   `nao` para este domínio, com 2–3 exemplos de cada. É o mesmo critério que o
   juiz recebe — se a rubrica mudar, a calibração anterior deixa de valer.
2. **30–50 itens**, estratificados: as 3 classes de veredito e os tipos de
   tarefa do domínio (`extracao`, `factual`, `raciocinio`, `formato`,
   `recusa`, `aberta`). Tire os itens de runs reais (pergunta + resposta do
   competidor), **anonimizados** — o arquivo vai para o git.
3. **Dois anotadores, às cegas e independentes.** Cada um rotula sozinho, sem
   ver o rótulo do outro nem o veredito do juiz, em ordem embaralhada. Use
   pseudônimos estáveis em `annotator` (`a1`, `a2`), nunca nome/e-mail.
4. **Meça:** `prompt-builder calib report --file <arq> --pilot`. O relatório
   mostra o α ordinal de Krippendorff, o AC2 de Gwet e o IC95% entre os
   anotadores (e o α de cada par, se houver mais de dois).
5. **α humano < 0,667 → pare.** O comando sai com exit 10
   (`gate.calibration_human_alpha_low`). Discuta os desacordos, ajuste a
   rubrica e refaça o piloto com itens NOVOS. Não meça o juiz contra humanos que
   discordam entre si.
6. **Registre o piloto** (data, rubrica/versão, anotadores, n, α e IC) na
   memória do projeto (`coala.py add --type episodic …`) e no PR que adicionar
   o arquivo.

## Conjunto completo

- **≥ 150 itens** com ≥ 2 rótulos humanos, **≥ 30 por classe** de veredito e
  **≥ 30 por tipo de tarefa** (com 150–200 itens o IC95% do α fica com largura
  ≤ 0,2).
- **Adjudicação:** nos desacordos, um terceiro (ou os dois, juntos) decide o
  rótulo final em `gold`, preservando os rótulos originais em `humanLabels`.
  `gold` habilita sensibilidade/especificidade do juiz.
- **Veredito do juiz por último**, às cegas para os humanos: rode o setup de
  juiz que está sendo calibrado (mesmos modelos, mesmo contrato/prompt) sobre
  `question`/`candidate`/`reference` e grave em `judgeVerdict` +
  `judgeModel`. Hoje isso é manual — não há comando que chame o juiz sobre o
  arquivo (seria gasto de API; fica para um item próprio).
- **Relatório:** `prompt-builder calib report --file <arq>` (exit 10 se o juiz
  não for aceitável). Em CI, `--strict` também reprova quando o conjunto não
  cumpre o protocolo.

Juiz aceitável = α juiz × humano ≥ 0,667 **e** dentro da faixa humano × humano
nos mesmos itens. α ≥ 0,800 é "confiável"; entre 0,667 e 0,800, "tentativo".
