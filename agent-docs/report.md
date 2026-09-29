# Relatório de ciclos (`sessions report`)

Um treino (`train`) roda em **ciclos**: em cada ciclo o reescritor gera variantes do prompt, elas
disputam com a **régua** (o prompt original no ciclo 1; o campeão anterior re-testado nos
seguintes) e só são promovidas se passarem no gate (margem `minGain` + teste da melhor de K +
re-avaliação limpa). No fim, o campeão enfrenta o original num **holdout** que a seleção nunca viu.

O relatório responde, com números **medidos**:

1. **Quanto melhorou** — judge-score original × campeão (holdout quando houve; senão a run de
   treino, rotulada como otimista), Δ em p.p., ganho relativo, IC95, p-valor e a origem do p
   (`holdout` = confirmação; `selecao` = o mesmo dado que escolheu, anti-conservador), mais a
   distribuição de vereditos resolve/parcial/não dos dois lados.
2. **Os ciclos** — por ciclo: régua, melhor variante, Δ bruto e corrigido (winner's curse),
   p ajustado, decisão (promovida/segurada/inconclusiva), motivo da retenção, re-avaliação,
   custo do ciclo e acumulado.
3. **Quanto a MUDANÇA mexe no custo de usar o prompt** — custo, tokens de entrada/saída/raciocínio
   e latência **por chamada**, original × campeão, **pareados pela mesma pergunta** (holdout ou
   runs de treino); Δ absoluto e %, custo por 1.000 chamadas, projeção mensal
   (`--calls-per-month`), chamadas até a otimização se pagar (campeão mais barato) ou custo extra
   por p.p. ganho (campeão mais caro). O Δ de tokens de entrada ≈ o tamanho do system prompt.
4. **Quanto custou otimizar** — total, uso do teto, quebra por papel (juízes, respostas,
   gabaritos, reescritor, duelos) e a precisão do custo (exato/estimado/desconhecido).
5. **O que mudou no prompt** — diff de linhas original → campeão e os dois textos inteiros.
6. **Ressalvas** — holdout pulado, campeão que regrediu, drift de juiz, custo desconhecido ou 0,
   runs ausentes. Chamada com custo 0 nunca vira "grátis" em silêncio.

## Comandos

```bash
prompt-builder sessions report <sessionId>                       # Markdown no stdout
prompt-builder sessions report <sessionId> --json                # prompt-builder-session-report@1
prompt-builder sessions report <sessionId> --html relatorio.html # página autocontida (tema Plannotator)
prompt-builder sessions report <sessionId> --markdown relatorio.md --calls-per-month 50000
prompt-builder sessions report <sessionId> --annotate            # abre na UI do Plannotator e espera
```

- MCP: tool `get_session_report` (`format`: `markdown` | `json` | `html`).
- HTTP local: `GET /v1/benchmark/sessions/<id>/report?format=json|html|markdown`.
- Web: botão **Relatório de ciclos** na tela do treino (`/training/<id>/report`), com "Baixar HTML"
  (o MESMO arquivo do `--html`).

## Relatório completo via skill `plannotator-visual-explainer`

O `--html` já sai no design system do Plannotator. Para uma explicação mais rica (para quem vai
decidir), o agente:

1. roda `prompt-builder sessions report <id>` e usa o Markdown como **brief** (os números já
   vêm prontos — não recalcule nada);
2. carrega a skill **plannotator-visual-explainer** (rota "visual explainer": relatório de dados)
   e compõe o HTML com os tokens do Plannotator — manchete, cartões (Δ qualidade, Δ custo por
   chamada, custo da otimização), gráfico por ciclo, comparação de custo e ressalvas;
3. entrega com `plannotator annotate <arquivo.html>` (nunca `open`/`xdg-open`).

`npm run agent-setup` (no checkout do repo) instala o binário do Plannotator e as skills
`plannotator-visual-explainer` + `visual-explainer` em todos os diretórios de skills de agentes.

## Ler o relatório sem se enganar

- **Sem holdout**, o ganho vem dos cenários que escolheram o campeão: é otimista por construção.
- **"Inconclusivo"** com Δ positivo = pista, não conclusão (sem significância).
- O custo por chamada vem do `usage.cost` cobrado; com `zeroCostCalls > 0` o Δ pode estar
  subestimado (preço desconhecido ou modelo gratuito).
- O custo da otimização é da sessão inteira (inclui re-avaliações e holdout); o custo por ciclo
  soma a run de seleção e a re-avaliação daquele ciclo.
