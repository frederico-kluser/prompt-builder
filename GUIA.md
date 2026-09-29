# GUIA — Prompt Builder

Guia do utilizador, do primeiro acesso à leitura do resultado. Para o motor por dentro,
arquitetura e referência da API, veja o [README](./README.md). Para usar sem interface
(agente de código, CLI ou MCP), veja [§10](#10-sem-interface-por-agentes).

---

## 1. O que é isto

O Prompt Builder mede **qual modelo (ou qual system prompt) responde melhor ao seu caso** —
com evidência, não com impressão. O ciclo inteiro tem 4 figuras:

| 1 · Cenários | 2 · Respostas | 3 · Juiz | 4 · Vencedor |
|---|---|---|---|
| Um modelo gerador escreve perguntas de teste a partir do seu **tema** | Cada participante (modelo ou versão de prompt) responde às mesmas perguntas | Um modelo juiz compara cada resposta com um **gabarito** e diz *resolve / parcial / não resolve* | O placar mostra quem resolveu mais; os melhores ainda **duelam** no fim |

Tudo corre com um **teto de gasto** que você define: a run para sozinha antes de o passar.

---

## 2. Primeiro acesso: a chave

Ao abrir a aplicação **sem chave**, ela pede-a diretamente (é o passo 2 do primeiro acesso —
só aparece a introdução na primeira vez). A chave é do **OpenRouter**:

1. Crie uma em **[openrouter.ai/keys](https://openrouter.ai/keys)** — a página mostra a chave
   **uma única vez**, guarde-a.
2. **Qualquer key válida serve** — com ou sem limite de crédito. O sistema aceita as duas em
   igualdade e não avisa nem bloqueia nada por causa disso. (Se quiser, o OpenRouter deixa
   definir `limit`/`limit_reset` na key — é opcional e só seu.)
3. Cole na tela e clique **Validar e conectar** (ou cole direto — a validação corre no paste).

**Onde a chave fica:** por padrão, só na memória da aba — recarregar ou fechar a aba a apaga e a
app pede de novo. Com **Lembrar neste dispositivo** ligado, fica no `localStorage` do seu navegador
até você a remover. Nos dois casos segue direto para o OpenRouter — nenhum outro servidor a
recebe. **Riscos:** qualquer script da página (XSS), extensões do navegador ou outra pessoa neste
computador conseguem lê-la; em máquina partilhada, não a lembre.
**Como revogar:** na [página de keys](https://openrouter.ai/keys) — revogue e crie outra se algo
parecer errado.

Sem chave pode **explorar o histórico local** (opção na primeira tela) — mas nada que chame
modelos funciona sem ela.

---

## 3. A configuração guiada

A **Nova run** abre por default no modo **Guiado**: 5 passos, uma pergunta de cada vez, em
linguagem natural. Nada é obrigatório até ao «Iniciar» — o rodapé diz sempre o que falta.

| Passo | O que decide | Exemplo |
|---|---|---|
| **1 · Objetivo** | O modo do benchmark: *Comparar modelos*, *Testar o meu prompt* ou *Treinar um prompt* | “Qual modelo responde melhor ao meu caso?” |
| **2 · Teste** | O **tema** (a partir daqui nascem os cenários) e, nos modos de prompt, o seu **system prompt** atual (entra como controlo) | “Atendimento de clínica de exames — FAQs, preparo e agendamento” |
| **3 · Participantes** | **Quem compete** (modelos ou o modelo sob teste), **quem escreve** os cenários (gerador) e **quem avalia** (juízes) | 3 modelos competidores · gerador barato · 1 juiz |
| **4 · Limites** | **Quantos cenários** (mais = mais confiança e mais custo), o **teto de gasto** e o **duelo final** entre os melhores | 5 cenários · até US$ 2 · com duelo final |
| **5 · Revisão** | O **plano da run** em linguagem natural: o que vai acontecer, por ordem, quanto se estima gastar e o que falta | “O gerador cria 5 cenários… os modelos A, B e C respondem… o juiz dá o veredito… os 3 melhores duelam” |

> **Modelos por default** (troque em qualquer seletor): juízes `google/gemini-3.8-flash` +
> `meta/muse-spark-1.3` · gerador `xiaomi/mimo-v2.6-pro` (no comparar: `meta/muse-spark-1.3`, pois
> o gerador não pode competir) · competidores `deepseek/deepseek-v4.1-flash`, `z-ai/glm-5.3-flash`
> e `xiaomi/mimo-v2.6-pro` · modelo sob teste `xiaomi/mimo-v2.6-pro` · gabarito
> `z-ai/glm-5.3-flash`. As listas de preferência completas estão em
> [`skills/prompt-builder/models.md`](./skills/prompt-builder/models.md).

O **rodapé fixo** acompanha todos os passos: a **primeira pendência** (clique e ele leva ao passo
que resolve), o **custo estimado** e o botão **Iniciar**. Se a estimativa passar de US$ 1 (ou
incluir preço desconhecido), um diálogo mostra a faixa e os principais responsáveis antes de
gastar — nada é debitado sem esse “sim”.

---

## 4. A configuração completa

O toggle **Formulário: Guiado | Completo** troca a superfície **sem perder nada do que já
preencheu** (é o mesmo estado). A **Completa** é a página única com tudo à vista, para quem já
sabe o que quer afinar:

- **Cenários** — tema, gerador, cenários importados (seed) e o briefing opcional;
- **Prompts/Modelos** — competidores (ou configs do mesmo modelo com temperatura/esforço
  diferentes), técnicas de prompt × variantes manuais, reescritor;
- **Juízes** — painel de juízes, modelo de referência (gabarito), juiz em 2 ordens;
- **Avançado** (recolhido por default) — finalistas/duelos, tokens/timeout/concorrência,
  gates do treino (margem mínima, holdout), conformidade LGPD, dado pessoal (só sintético ×
  redigir), filtros de preço e o que só entra por arquivo JSON.

**Importar/Exportar JSON** (topo) guarda e repõe a configuração inteira (`arena-config`), e
também aceita **pacotes de cenários** ou listas de cenários prontos — o import avisa sempre o
que foi aplicado, ajustado ou descartado.

---

## 5. Os três modos — quando usar cada

| Modo | Responde a | Use quando |
|---|---|---|
| **Comparar modelos** | “Qual modelo é melhor para o meu caso?” | Quer escolher entre 2+ modelos com as mesmas perguntas e o mesmo juiz |
| **Testar o meu prompt** | “Esta versão do prompt é melhor que a atual?” | Tem um system prompt e quer compará-lo com variações (geradas por técnicas, ou escritas à mão) |
| **Treinar um prompt** | “Melhore o meu prompt sozinho, com evidência.” | Quer que o prompt evolua rodada a rodada — com campeã só quando há ganho real, e teste cego (holdout) no fim |

Regras de justiça que a app impõe: o **juiz nunca é o modelo sob teste**; em variation/training o
**gabarito** é escrito por um modelo à parte; e a variante original entra como **controlo**.

---

## 6. Durante a execução

A tela da run tem duas camadas — **Resumo** (alto nível) e **Resultados** (detalhe):

- **Resumo — “O que está acontecendo”:** as 4 fases do pipeline com contagem (Cenários →
  Respostas → Julgamento → Duelo final), a frase do que se passa agora, o **placar em linguagem
  simples** (“resolveu 3 de 5 · 1 parcial · nota 72”) e o **gasto até agora** face ao teto.
- **Resultados — o heatmap:** uma linha por variante/modelo, uma coluna por cenário. Cada célula
  é o veredito: ✓ resolve · ◐ parcial · ✕ não resolve · · pendente · ⏳ aguardando julgamento ·
  ⏹ fora do placar (orçamento/cancelamento) · ⊘ bloqueado pela moderação · ✂ truncada.
- **Final:** os duelos entre os finalistas, com taxa de vitória.

Pode **cancelar** (segure o botão) — o parcial fica gravado e nada de novo é pago. Se fechar a
aba que executa a run, ela é marcada como interrompida quando a app voltar.

---

## 7. Ler o resultado

- **Veredito** é a unidade: *resolve* (100%), *parcial* (50%) ou *não resolve* (0%) contra o
  gabarito. A **nota 0–100** é a média desses pesos sobre os cenários julgados.
- **Duelo final:** os `N` melhores (por nota) disputam **todos** os cenários entre si, par a par
  e nas duas ordens — o placar final é por **taxa de vitória**. Empate em desacordo de ordem.
- **Cenário “incompleto”** (cortado pelo orçamento, cancelado ou com resposta truncada) fica
  **fora do placar e das médias** — nunca vira nota inventada.
- **Run inconclusiva** = o juiz perdeu vereditos demais para o resultado sustentar conclusão;
  os motivos aparecem no topo da run.
- **Bloqueado ≠ recusado ≠ erro:** bloqueio é a defesa da moderação (sem veredito), recusa é o
  modelo se recusando (julgável) e erro é infra. As três contagens aparecem no resumo.
- **Exportar:** JSON (record inteiro), CSV (uma linha por resposta) e, em prompts testados com
  gabaritos, o **pacote de cenários** do campeão (para reutilizar noutro benchmark).

---

## 8. Custo e orçamento

- A **estimativa** do rodapé vem da mesma conta das portas de orçamento do motor, sobre a
  configuração que vai ser enviada; mostra a faixa (baixa–alta) e os 3 maiores responsáveis.
- **Preço variável/desconhecido** (roteadores, modelos sem preço) fica fora da soma e é dito à
  parte — o total nunca é apresentado como “grátis”.
- **Teto de gasto** (`budgetUsd`): o motor para numa fronteira de fase antes de passar dele, e a
  run sai **parcial honesta** (o que foi concluído vale; o resto fica fora). Sem teto, o céu é o
  limite — recomenda-se sempre colocar um.
- O **custo real** vem de `usage.cost` (o valor cobrado pelo provedor), quebrado por papel
  (gerador, gabarito, competidores, juiz, duelos, reescritor) na run terminada.

---

## 9. Privacidade e LGPD

- **Chave:** ver §2 — nunca sai para o backend além do header `x-openrouter-key`.
- **Dado pessoal nos textos:** em «Avançado › Dado pessoal» escolhe-se *só sintético* (a run é
  recusada se houver CPF/telefone/e-mail com aparência real) ou *redigir* (o dado é pseudonimizado
  antes de cada envio, com revisão explícita do que foi encontrado).
- **Conformidade LGPD por área:** filtra o catálogo dos participantes para endpoints compatíveis
  com a área escolhida (ex.: dados de saúde) — ver a tabela de allowlist no [README](./README.md#conformidade-lgpd-allowlist-por-endpoint).
  *Não é aconselhamento jurídico.*

---

## 10. Sem interface: por agentes

Tudo o que a interface faz também é dirigível por **CLI/MCP**, de qualquer diretório:

- **Skill de agente** — `skills/prompt-builder` (vem no pacote npm). Para ter disponível em
  **todos os agentes**, instale **globalmente por symlink**:
  `bash scripts/install-agent-skill.sh install` (ver `doctor`/`uninstall` no mesmo script).
  Por repositório, o próprio CLI também instala: `npx prompt-builder-cli init --agent all`.
- **CLI** — `npx prompt-builder-cli docs quickstart` (documentação embarcada, casada com a
  versão); `--budget` é obrigatório sem TTY; `--output-format ndjson` emite um evento por linha;
  `--dry-run` faz o pré-voo inteiro sem gastar.
- **MCP** — `claude mcp add --transport stdio arena -- npx -y prompt-builder-cli mcp`; as runs
  são **jobs** (`start_run` → `run_status` → `get_result`), com `idempotencyKey` obrigatória.
- **Códigos de saída:** `0` ok · `2` uso · `3` config · `4` auth · `5` sem crédito · `7` parcial
  por orçamento · `8` rede · `130` SIGINT.

---

## 11. Problemas comuns

| Sintoma | O que é | O que fazer |
|---|---|---|
| `401` ao validar a key | Key inválida ou revogada | Crie outra em [openrouter.ai/keys](https://openrouter.ai/keys) |
| `402` no meio da run | Conta sem créditos | Adicione créditos ou reduza a run (menos cenários/juízes) |
| `429` | Rate limit do provedor | O motor já faz backoff; se persistir, baixe a concorrência em Avançado |
| Run parou antes do fim | Teto de gasto atingido (ou cancelamento) | O parcial vale; veja `O que aconteceu` na run — o motivo está dito ali |
| “preço variável” na estimativa | Modelo/roteador sem preço fixo | O total é parcial por definição; o aviso diz o quê |
| Células ⊘ no heatmap | Bloqueio da moderação | Não é erro de key nem do prompt — o cenário fica sem veredito para o prompt |
| Muitas células ✂ | Respostas truncadas no teto de tokens | Suba `maxOutputTokens` (Avançado) ou use modelo com saída mais curta |
| Run “interrompida” ao voltar | A aba que executava fechou/recarregou | Reabra a run no histórico; o parcial está guardado |

Precisa de mais detalhe? [`README.md`](./README.md) tem o motor, a API e a arquitetura; a memória
CoALA do projeto (`coala.py search`) tem as decisões e pesquisas por trás de cada escolha.