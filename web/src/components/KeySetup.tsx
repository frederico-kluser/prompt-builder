import { useEffect, useId, useState } from 'react';
import { Check, LoaderCircle, TriangleAlert } from 'lucide-react';
import type { KeyPersistence, ValidateKeyResponse } from '../api';
import { getStoredKey, keyPersistence, setStoredKey, validateKey } from '../api';
import { keyHandlingFacts, OPENROUTER_KEYS_URL } from '../keyHandling';
import { MultiStateButton } from '@/components/motion-ui/multi-state-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Banner, PageHeader, Screen } from './primitives';

type Status = 'idle' | 'validating' | 'valid' | 'invalid';

function usd(v: number): string {
  return `$${v.toFixed(v < 1 ? 4 : 2)}`;
}

function describeKey(res: ValidateKeyResponse): string {
  const parts: string[] = ['Key válida'];
  if (res.label) parts.push(`(${res.label})`);
  if (typeof res.usageUsd === 'number') {
    // O limite da key é INFORMAÇÃO quando existe — nunca cobrança: key sem
    // limite é aceite como qualquer outra (decisão do dono, 2026-09-27).
    const limit =
      res.limitUsd === null || res.limitUsd === undefined ? '' : ` / limite ${usd(res.limitUsd)}`;
    parts.push(`— uso ${usd(res.usageUsd)}${limit}`);
  }
  if (res.isFreeTier) parts.push('· tier gratuito');
  return parts.join(' ') + '.';
}

// (2026-09-27, decisão do DONO) Não existe mais aviso/banner de "key sem
// limite de crédito": QUALQUER key válida é aceite em igualdade — o limite é
// opcional do usuário e o sistema nunca cobra nem bloqueia por isso.

// Rótulo e glifo do botão por estado — o MultiStateButton morfa a largura entre eles.
// "conectada", não "salva": sem «Lembrar» a key vive só na memória da aba.
const BUTTON_LABEL: Record<Status, string> = {
  idle: 'Validar e conectar',
  validating: 'Validando…',
  valid: 'Key conectada',
  invalid: 'Tentar de novo',
};

export function KeySetup({ onSaved }: { onSaved?: () => void }) {
  const [key, setKey] = useState(getStoredKey());
  const [status, setStatus] = useState<Status>(getStoredKey() ? 'valid' : 'idle');
  const [message, setMessage] = useState<string | null>(null);
  // Como a key está guardada AGORA — a tela declara isso (IMPL-082), nunca um
  // texto fixo. Atualizado a cada gravação.
  const [persistence, setPersistence] = useState<KeyPersistence>(() => keyPersistence());
  // "Lembrar neste dispositivo": opt-in EXPLÍCITO (default: só memória). Com uma
  // key já lembrada, nasce marcado — revalidá-la não a apaga do disco em
  // silêncio (antes: todo revalidar chamava setStoredKey sem `remember` e
  // removia a cópia persistida).
  const [remember, setRemember] = useState(() => keyPersistence() === 'remembered');
  const rememberId = useId();

  useEffect(() => {
    setKey(getStoredKey());
  }, []);

  /** Grava e sincroniza a declaração da tela com o que ficou guardado. */
  function store(k: string, lembrar: boolean) {
    setStoredKey(k, { remember: lembrar });
    setPersistence(keyPersistence());
  }

  /** A escolha vale NA HORA para a key já conectada: desmarcar tira do disco já. */
  function handleRemember(v: boolean) {
    setRemember(v);
    const atual = getStoredKey();
    if (atual && status === 'valid') store(atual, v);
  }

  async function handleValidate(rawKey?: string) {
    const target = (rawKey ?? key).trim();
    if (!target) {
      setStatus('invalid');
      setMessage('Cole sua key do OpenRouter.');
      return;
    }
    setStatus('validating');
    setMessage(null);
    try {
      const res = await validateKey(target);
      if (res.ok) {
        store(target, remember);
        setStatus('valid');
        setMessage(describeKey(res));
        onSaved?.();
      } else {
        store('', false);
        setStatus('invalid');
        setMessage(res.error ?? 'Key inválida.');
      }
    } catch (err) {
      setStatus('invalid');
      setMessage((err as Error).message);
    }
  }

  function handleClear() {
    store('', false);
    setKey('');
    setStatus('idle');
    setMessage(null);
  }

  const icon =
    status === 'validating' ? (
      <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
    ) : status === 'valid' ? (
      <Check className="size-4" aria-hidden="true" />
    ) : status === 'invalid' ? (
      <TriangleAlert className="size-4" aria-hidden="true" />
    ) : undefined;

  return (
    <div className="rounded-xl bg-card p-5 ring-1 ring-foreground/10">
      <h2 className="font-heading text-base font-medium">OpenRouter API Key</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
        Cole sua key do OpenRouter. Ela vai direto do navegador para o OpenRouter — nenhum outro
        servidor a recebe.
      </p>
      {/* "Como sua key é tratada" (IMPL-082): só frases VERIFICÁVEIS, montadas a
          partir do estado real (web/src/keyHandling.ts — cada uma tem
          verificador em test/key-handling.test.ts). O antigo 4º ponto, "crie a
          key COM limite de crédito", foi REMOVIDO a pedido do dono em
          2026-09-27: key sem limite é aceite sem cobrança nem aviso. */}
      <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-muted-foreground" aria-label="Como sua key é tratada">
        {keyHandlingFacts(persistence).map((f) => (
          <li key={f.id} data-key-fact={f.id}>
            <strong className="font-medium text-foreground">{f.title}:</strong> {f.text}
            {f.id === 'revogar' && (
              <>
                {' '}
                <a
                  className="text-primary underline-offset-4 hover:underline"
                  href={OPENROUTER_KEYS_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  Página de keys do OpenRouter ↗
                </a>
              </>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Input
          className="min-w-[16rem] flex-1 font-mono text-[13px]"
          type="password"
          autoComplete="off"
          aria-label="OpenRouter API key"
          placeholder="sk-or-v1-..."
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            // Enter valida a key — e nunca submete um <form> em volta (na Nova
            // Run o re-prompt vive DENTRO do formulário da run).
            if (e.key === 'Enter') {
              e.preventDefault();
              void handleValidate();
            }
          }}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData('text').trim();
            if (pasted) {
              setKey(pasted);
              setTimeout(() => handleValidate(pasted), 0);
              e.preventDefault();
            }
          }}
        />
        <MultiStateButton
          state={status}
          icon={icon}
          feedback={status === 'invalid' ? 'shake' : status === 'valid' ? 'pop' : 'none'}
          announce={message ?? undefined}
          disabled={status === 'validating'}
          onClick={() => void handleValidate()}
          pillClassName="rounded-lg px-3.5 py-2 text-sm font-medium"
          surfaceClassName={
            status === 'invalid' ? 'bg-destructive/10 text-destructive' : 'bg-primary text-primary-foreground'
          }
        >
          {BUTTON_LABEL[status]}
        </MultiStateButton>
        {status === 'valid' && (
          <Button type="button" variant="ghost" onClick={handleClear}>
            Remover
          </Button>
        )}
      </div>

      {/* Opt-in de persistência (IMPL-082): declarado, reversível e com efeito
          imediato sobre a key já conectada. */}
      <div className="mt-3 flex items-start gap-2.5">
        <Switch
          className="mt-0.5"
          checked={remember}
          onCheckedChange={(v) => handleRemember(!!v)}
          aria-labelledby={`${rememberId}-rotulo`}
          aria-describedby={`${rememberId}-nota`}
        />
        <div className="min-w-0">
          <span id={`${rememberId}-rotulo`} className="block text-sm font-medium text-foreground">
            Lembrar neste dispositivo
          </span>
          <p id={`${rememberId}-nota`} className="mt-0.5 text-[13px] leading-snug text-muted-foreground">
            Guarda a key no <code className="font-mono text-[12.5px]">localStorage</code> deste navegador
            para não precisar colá-la a cada visita. Desligado, ela vive só na memória desta aba.
          </p>
        </div>
      </div>

      {message && (
        <Banner tone={status === 'invalid' ? 'error' : 'neutral'} className="mt-3">
          {message}
        </Banner>
      )}

    </div>
  );
}

export function KeyGate({ children }: { children: React.ReactNode }) {
  const [hasKey, setHasKey] = useState(!!getStoredKey());
  if (!hasKey) {
    return (
      <Screen>
        <PageHeader
          title="Conecte sua chave"
          subtitle="Para criar uma run, cole sua chave da OpenRouter. Ela vai direto do navegador para a OpenRouter — marque «Lembrar neste dispositivo» para não precisar colá-la de novo."
        />
        <KeySetup onSaved={() => setHasKey(true)} />
      </Screen>
    );
  }
  return <>{children}</>;
}
