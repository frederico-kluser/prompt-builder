import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, Check, MessageSquareText, Scale, Trophy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getStoredKey } from '../api';
import { KeySetup } from './KeySetup';
import { GoalCard, GOALS } from './GuidedSetup';
import { PageHeader, Screen } from './primitives';
import type { RunMode } from '../api';

/**
 * PRIMEIRO ACESSO (pedido do dono: "quando abro a aplicação, pede direto a
 * key"). Tela própria (`/welcome`), com no máximo 3 passos iniciados pelo
 * usuário (R-11b:DEC-5 — tour curto, nunca automático):
 *
 *   1. Boas-vindas — o que o produto faz, em 4 figuras de alto nível.
 *   2. A chave do OpenRouter — `KeySetup` (com os 4 pontos de risco/limite/
 *      revogação) — é o pedido DIRETO da key, logo ao abrir.
 *   3. O objetivo — 3 cartões que levam ao fluxo guiado já no modo certo.
 *
 * Quem já passou por aqui cai direto no passo 2 (a key) quando abre sem chave.
 * "Explorar sem chave" salta tudo por SESSÃO de navegação (sessionStorage) —
 * no próximo abrir, a app pergunta de novo.
 */

type Step = 'intro' | 'key' | 'objetivo';

/** Marca que o intro já foi visto — no próximo abrir pede a key direto. */
export function markOnboarded(): void {
  try {
    localStorage.setItem('pb.onboarded', '1');
  } catch {
    // localStorage indisponível: sem persistência, o intro aparece de novo.
  }
}

function seenOnboard(): boolean {
  try {
    return localStorage.getItem('pb.onboarded') === '1';
  } catch {
    return false;
  }
}

/** "Explorar sem chave" — dura só esta sessão de navegação. */
export function skipKeyAsk(): void {
  try {
    sessionStorage.setItem('pb.explore', '1');
  } catch {
    // sem sessionStorage o gate volta a perguntar no próximo render
  }
}

export function keyAskSkipped(): boolean {
  try {
    return sessionStorage.getItem('pb.explore') === '1';
  } catch {
    return false;
  }
}

/**
 * Rota de onde o gate (`KeyFirstGate`, main.tsx) trouxe o usuário — para
 * devolvê-lo a ela depois da key (recarregar `/runs/:id` sem key lembrada não
 * pode perder a run aberta). Só caminhos internos; a raiz e o próprio
 * `/welcome` não contam.
 */
export function returnPathFrom(state: unknown): string | null {
  const from = (state as { from?: unknown } | null)?.from;
  if (typeof from !== 'string' || !from.startsWith('/') || from.startsWith('//')) return null;
  if (from === '/' || from.startsWith('/welcome')) return null;
  return from;
}

/** As 4 figuras do pipeline, em linguagem de quem nunca viu um benchmark. */
const PIPELINE = [
  {
    icon: MessageSquareText,
    title: 'Cenários',
    text: 'Um gerador escreve perguntas de teste a partir do seu tema.',
  },
  {
    icon: Scale,
    title: 'Respostas',
    text: 'Cada modelo (ou cada versão do prompt) responde às mesmas perguntas.',
  },
  {
    icon: Check,
    title: 'Juiz',
    // web-live#10: comparando modelos (o default) não há gabarito — o juiz
    // ranqueia as respostas lado a lado; não prometa régua que não existe.
    text: 'Um modelo juiz compara cada resposta com o gabarito (ou com as rivais, quando não há gabarito): resolve, parcial ou não resolve.',
  },
  {
    icon: Trophy,
    title: 'Vencedor',
    text: 'O placar mostra quem resolveu mais — e, havendo gabarito, os melhores ainda duelam no fim.',
  },
];

export function FirstRun() {
  const navigate = useNavigate();
  const location = useLocation();
  // Volta para onde estava (ex.: recarregou `/runs/:id` e a key era só da aba).
  const voltarPara = returnPathFrom(location.state);
  const [step, setStep] = useState<Step>(seenOnboard() ? 'key' : 'intro');
  const [hasKey, setHasKey] = useState(!!getStoredKey());

  /** Depois da key: de volta à rota de origem, ou o passo de objetivo. */
  function continuar() {
    if (voltarPara) navigate(voltarPara, { replace: true });
    else setStep('objetivo');
  }

  function pickGoal(id: RunMode) {
    markOnboarded();
    // O fluxo guiado da Nova Run abre já adaptado ao objetivo escolhido.
    navigate(`/new?objetivo=${id}`);
  }

  return (
    <Screen>
      {step === 'intro' && (
        <>
          <PageHeader
            title="Bem-vindo ao Prompt Builder"
            subtitle="Meça, com evidência, qual modelo ou qual system prompt responde melhor ao seu caso — com cenários gerados, um juiz que dá o veredito e gasto sob teto."
          />
          <ol className="mt-2 grid gap-3 sm:grid-cols-2">
            {PIPELINE.map((p, i) => {
              const Icon = p.icon;
              return (
                <li key={p.title} className="flex gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                    <Icon className="size-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0">
                    <span className="block font-heading text-sm font-medium">
                      {i + 1}. {p.title}
                    </span>
                    <span className="mt-0.5 block text-[13px] leading-relaxed text-muted-foreground">
                      {p.text}
                    </span>
                  </span>
                </li>
              );
            })}
          </ol>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Button
              onClick={() => {
                markOnboarded();
                setStep('key');
              }}
            >
              Começar
              <ArrowRight aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                markOnboarded();
                skipKeyAsk();
                // Explorar = histórico local; a Nova Run pediria a key de novo.
                navigate(voltarPara && !voltarPara.startsWith('/new') ? voltarPara : '/runs');
              }}
            >
              Explorar sem chave (histórico local)
            </Button>
          </div>
        </>
      )}

      {step === 'key' && (
        <>
          <PageHeader
            title="Conecte a sua chave"
            subtitle="A única coisa que falta para começar. A chave do OpenRouter segue direto do navegador para o OpenRouter — nenhum outro servidor a recebe."
          />
          <KeySetup
            onSaved={() => {
              setHasKey(true);
            }}
          />
          <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
            Ainda não tem chave? Crie uma em{' '}
            <a
              className="text-primary underline-offset-4 hover:underline"
              href="https://openrouter.ai/keys"
              target="_blank"
              rel="noreferrer"
            >
              openrouter.ai/keys ↗
            </a>
            . Qualquer key válida serve — o sistema aceita-a como está.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button disabled={!hasKey} onClick={continuar}>
              {voltarPara ? 'Voltar para onde estava' : 'Continuar'}
              <ArrowRight aria-hidden="true" />
            </Button>
            <Button variant="ghost" onClick={() => setStep('intro')}>
              Voltar
            </Button>
          </div>
        </>
      )}

      {step === 'objetivo' && (
        <>
          <PageHeader
            title="O que quer descobrir primeiro?"
            subtitle="Escolha um objetivo — a configuração guiada abre já adaptada a ele. Pode mudar de ideias depois."
          />
          <div className="grid gap-3 sm:grid-cols-3">
            {GOALS.map((g) => (
              <GoalCard key={g.id} goal={g} selected={false} onPick={() => pickGoal(g.id)} />
            ))}
          </div>
          <p className="mt-4 text-[13px] text-muted-foreground">
            Preferem decidir depois?{' '}
            <button
              type="button"
              className="text-primary underline-offset-4 hover:underline"
              onClick={() => navigate('/new?objetivo=compare&passo=objetivo')}
            >
              Abrir a configuração sem escolher
            </button>
          </p>
        </>
      )}
    </Screen>
  );
}