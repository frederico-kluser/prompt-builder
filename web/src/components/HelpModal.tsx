import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  SmoothTabs,
  SmoothTabsList,
  SmoothTabsTab,
  SmoothTabsPanels,
  SmoothTabsPanel,
} from '@/components/motion-ui/smooth-tabs';
import { useMotionUITransition, useMotionUITheme } from '@/components/motion-ui/ui-theme';
import { Button } from '@/components/ui/button';
import { Modal } from './Modal';
import { markTutorialSeen, type HelpTutorial } from '../help';
import { cn } from '@/lib/utils';

interface Step {
  kicker: string;
  title: string;
  body: string;
}

const TAB_LABEL: Record<HelpTutorial, string> = {
  compare: 'Comparar',
  variation: 'Variação',
  training: 'Treino',
  runs: 'Histórico',
  prompts: 'Prompts',
  settings: 'Configurações',
};

// Tutoriais curtos: no máximo 3 passos por tópico (o que é / o que selecionar /
// como ler). Devem refletir a tela atual — página única de configuração +
// heatmap ao vivo + bloco "Final" com os 3 melhores duelando. Nada de número
// inventado: os defaults citados batem com os do motor (teste de conteúdo em
// test/ux-keygate-help.test.ts).
export const TUTORIALS: Record<HelpTutorial, Step[]> = {
  compare: [
    {
      kicker: 'O que é',
      title: 'Vários modelos, os mesmos cenários',
      body: 'Todos os modelos respondem às mesmas perguntas. Um gabarito é escrito antes, e o juiz compara cada resposta com ele: resolve, parcial ou não resolve.',
    },
    {
      kicker: 'O que selecionar',
      title: 'Cenários, modelos e juízes',
      body: 'Importe um JSON de cenários ou mande gerar (escolhendo a LLM geradora e quantos). Escolha os modelos que competem e ao menos 1 juiz. Se o JSON já trouxer tudo, só falta o juiz.',
    },
    {
      kicker: 'Como ler',
      title: 'Heatmap e final',
      body: 'Enquanto roda, o heatmap preenche cenário × modelo: ✓ resolve, ◐ parcial, ✕ não resolve. No fim, os 3 de maior score duelam entre si em cada cenário e o pódio sai em “Final”.',
    },
  ],
  variation: [
    {
      kicker: 'O que é',
      title: 'Um modelo, vários prompts',
      body: 'O modelo é fixo e o que muda é o system prompt. Cada variação enfrenta os mesmos cenários para você descobrir qual prompt funciona melhor.',
    },
    {
      kicker: 'O que selecionar',
      title: 'Prompt base, variações e juízes',
      body: 'Escolha o modelo sob teste, escreva (ou gere) o prompt base e marque as técnicas que viram variações — o botão “Todas” seleciona de uma vez. Depois, os juízes.',
    },
    {
      kicker: 'Como ler',
      title: 'Heatmap e final',
      body: 'O heatmap mostra cada variação em cada cenário. Em “Final”, as 3 melhores duelam entre si; o bloco “Variantes” guarda o texto de cada prompt.',
    },
  ],
  training: [
    {
      kicker: 'O que é',
      title: 'O prompt evolui sozinho',
      body: 'A cada rodada a melhor variação vira a base da próxima. Os cenários são congelados entre as rodadas, e o treino para quando não há mais ganho real.',
    },
    {
      kicker: 'O que selecionar',
      title: 'Igual à variação, mais rodadas',
      body: 'Modelo sob teste, prompt base, técnicas, juízes — e quantas rodadas de evolução. Uma fatia dos cenários fica reservada para validar o campeão no fim.',
    },
    {
      kicker: 'Como ler',
      title: 'Rodada, evolução e melhor prompt',
      body: 'O heatmap acompanha a rodada corrente e “Evolução” mostra o score de cada variante por rodada. Em “Melhor prompt” você compara com o original, copia e salva na biblioteca.',
    },
  ],
  runs: [
    {
      kicker: 'O que é',
      title: 'Runs e treinos guardados neste navegador',
      body: 'Tudo o que você rodou fica salvo neste navegador: runs de comparar/variação e sessões de treino, cada uma com modo, tema, status e horário.',
    },
    {
      kicker: 'Como abrir',
      title: 'Run abre o heatmap, treino abre o cockpit',
      body: 'Uma run abre com o heatmap cenário × variante e o bloco “Final”; um treino abre o cockpit, com a evolução por rodada e a escolha do melhor prompt.',
    },
    {
      kicker: 'Detalhe',
      title: 'As iterações de um treino ficam de fora da lista',
      body: 'Cada rodada do treino é uma run-filha: elas não aparecem na lista plana e são acessíveis pela tela da própria sessão.',
    },
  ],
  prompts: [
    {
      kicker: 'O que é',
      title: 'Biblioteca de prompts salvos',
      body: 'Os prompts que você salva — por exemplo, os promovidos num treino — ficam guardados neste navegador, com nome e texto completo.',
    },
    {
      kicker: 'Versionamento',
      title: 'Texto novo vira versão nova',
      body: 'Mudar o texto cria uma nova versão e registra o histórico; renomear não cria versão.',
    },
    {
      kicker: 'Como usar',
      title: 'Renomear, comparar e reusar',
      body: 'Aqui você renomeia, exclui, compara as versões e manda o texto para o rascunho da Nova run.',
    },
  ],
  settings: [
    {
      kicker: 'O que é',
      title: 'Chave, tema e armazenamento',
      body: 'Aqui ficam a chave da OpenRouter, o tema do app (claro, escuro ou o do sistema) e o armazenamento local.',
    },
    {
      kicker: 'A chave',
      title: 'Local, com limite e revogável',
      body: 'A key vive só no localStorage deste navegador e segue direto para o OpenRouter. Qualquer key válida é aceite; se algo parecer errado, revogue-a na página de keys e crie outra.',
    },
    {
      kicker: 'Tema',
      title: 'Claro, escuro ou o do sistema',
      body: 'A troca é imediata e vale para todas as telas; em “sistema” o app acompanha o tema do computador enquanto estiver aberto.',
    },
  ],
};

const ORDER: HelpTutorial[] = ['compare', 'variation', 'training', 'runs', 'prompts', 'settings'];

export function HelpModal({ tutorial, onClose }: { tutorial: HelpTutorial; onClose: () => void }) {
  const [active, setActive] = useState<HelpTutorial>(tutorial);
  const [step, setStep] = useState(0);
  const ui = useMotionUITransition('ui');
  const { motionMode } = useMotionUITheme();
  const still = motionMode === 'off';

  useEffect(() => {
    setActive(tutorial);
    setStep(0);
  }, [tutorial]);

  useEffect(() => {
    markTutorialSeen(active);
  }, [active]);

  const steps = TUTORIALS[active];
  const s = steps[step];
  const isLast = step >= steps.length - 1;

  return (
    <Modal open onClose={onClose} label="Como funciona" className="max-w-xl">
      <div className="p-6 pt-5">
        <SmoothTabs
          value={active}
          onValueChange={(v) => {
            setActive(v as HelpTutorial);
            setStep(0);
          }}
          className="flex flex-col gap-5"
        >
          <SmoothTabsList ariaLabel="Modos de benchmark" className="mr-10 w-fit">
            {ORDER.map((t) => (
              <SmoothTabsTab key={t} value={t} className="px-3 py-1.5 text-[13px]">
                {TAB_LABEL[t]}
              </SmoothTabsTab>
            ))}
          </SmoothTabsList>
          {/* Os painéis do SmoothTabs são o conteúdo por aba; o passo dentro da
              aba tem a própria transição (abaixo), porque muda sem trocar aba. */}
          {/* min-h fixo pelo passo mais alto: sem ele o diálogo pula de altura
              a cada "Próximo". */}
          <SmoothTabsPanels className="min-h-[152px]">
            {ORDER.map((t) => (
              <SmoothTabsPanel key={t} value={t}>
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={step}
                    initial={still ? false : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: still ? 0 : ui.duration * 0.6 }}
                  >
                    <div className="text-[11px] font-semibold tracking-[0.07em] text-primary uppercase">
                      {s.kicker}
                    </div>
                    <h2 className="mt-2 font-heading text-xl font-medium tracking-tight text-balance">
                      {s.title}
                    </h2>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
                  </motion.div>
                </AnimatePresence>
              </SmoothTabsPanel>
            ))}
          </SmoothTabsPanels>
        </SmoothTabs>

        <div className="mt-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-1.5">
            {steps.map((_, j) => (
              <button
                key={j}
                type="button"
                aria-label={`Passo ${j + 1}`}
                aria-current={j === step ? 'step' : undefined}
                onClick={() => setStep(j)}
                className={cn(
                  'h-1.5 rounded-full transition-all',
                  j === step ? 'w-5 bg-primary' : 'w-1.5 bg-border hover:bg-muted-foreground',
                )}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            {step > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setStep((i) => i - 1)}>
                Anterior
              </Button>
            )}
            <Button size="sm" onClick={() => (isLast ? onClose() : setStep((i) => i + 1))}>
              {isLast ? 'Fechar' : 'Próximo'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
