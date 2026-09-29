import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { RotateCw, Trash2 } from 'lucide-react';
import { KeySetup } from '../components/KeySetup';
import { StorageSettings } from '../components/StorageNotice';
import { HoldToConfirmButton } from '@/components/motion-ui/hold-to-confirm';
import { SegmentedToggle, SegmentedToggleOption } from '@/components/motion-ui/segmented-toggle';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Banner, PageHeader, Screen, SectionHead } from '../components/primitives';
import { isAttributionDisabled, setAttributionEnabled } from '../engine/openrouter';
import { RETENTION_DAYS_KEY, retentionDaysFor, siteWipeInstructions, wipeLocalData, type SiteWipeResult } from '../lgpd';
import { lastLocalPrune, pruneExpiredLocal, subscribeLocalPrune } from '../localRetention';
import { useTheme, type Theme } from '../theme';

const THEMES: { value: Theme; label: string }[] = [
  { value: 'light', label: 'Claro' },
  { value: 'dark', label: 'Escuro' },
  { value: 'system', label: 'Sistema' },
];

/**
 * IMPL-120 (R-01b:REC-9): os headers de ATRIBUIÇÃO (`HTTP-Referer` com a
 * origem desta página e `X-Title: Prompt Builder`) são dado enviado ao
 * OpenRouter em TODA chamada — declarados aqui e desligáveis. A escolha vale
 * na hora (o gateway é reconfigurado em lugar) e fica salva no navegador
 * (`pb.noAttribution`); é o equivalente da variável
 * `PROMPT_BUILDER_NO_ATTRIBUTION` do CLI.
 */
function AttributionSetting() {
  const id = useId();
  const [enabled, setEnabled] = useState(() => !isAttributionDisabled());

  function toggle(next: boolean) {
    setAttributionEnabled(next);
    setEnabled(next);
  }

  return (
    <div className="flex items-start gap-2.5 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <Switch
        className="mt-0.5"
        checked={enabled}
        onCheckedChange={(v) => toggle(!!v)}
        aria-labelledby={`${id}-rotulo`}
        aria-describedby={`${id}-nota`}
      />
      <div className="min-w-0">
        <span id={`${id}-rotulo`} className="block text-sm font-medium text-foreground">
          Identificar o app para a OpenRouter
        </span>
        <p id={`${id}-nota`} className="mt-0.5 text-[13px] leading-snug text-muted-foreground">
          Envia em cada chamada os headers <code className="font-mono text-[12.5px]">HTTP-Referer</code> (o endereço
          desta página) e <code className="font-mono text-[12.5px]">X-Title</code> (“Prompt Builder”) — dado
          compartilhado com a OpenRouter, que os usa no ranking público de apps. Desligado, nenhum dos dois vai no
          fio; o resto da chamada não muda.
        </p>
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Execuções com lock vivo NESTA origem (qualquer aba) — `navigator.locks.query`. */
async function runningLocks(): Promise<number> {
  try {
    const locks = (globalThis.navigator as Navigator | undefined)?.locks;
    if (!locks?.query) return 0;
    const { held = [] } = await locks.query();
    return held.filter((l) => typeof l.name === 'string' && l.name.startsWith('prompt-builder:')).length;
  } catch {
    return 0;
  }
}

/**
 * left#6 (IMPL-100, R-16:REC-6) — retenção do que o app guarda NESTE
 * navegador. O TTL é o mesmo do CLI (90 dias por default; 0 desliga) e roda
 * sozinho na abertura do app (`startLocalRetention`, main.tsx). Mudar o número
 * aqui só mostra a PRÉVIA (dry-run) do que sairia — nada é apagado na hora.
 */
function RetentionSettings() {
  const id = useId();
  const prune = useSyncExternalStore(subscribeLocalPrune, lastLocalPrune, lastLocalPrune);
  const [days, setDays] = useState(() => String(retentionDaysFor(safeStorage() ?? { getItem: () => null })));
  const [preview, setPreview] = useState<number | null>(null);
  const parsed = /^\d+$/u.test(days.trim()) ? Number(days.trim()) : null;

  useEffect(() => {
    if (parsed === null || parsed === 0) {
      setPreview(null);
      return;
    }
    let vivo = true;
    const t = setTimeout(() => {
      void pruneExpiredLocal({ retentionDays: parsed, dryRun: true }).then((r) => vivo && setPreview(r.deleted.length));
    }, 250);
    return () => {
      vivo = false;
      clearTimeout(t);
    };
  }, [parsed]);

  function commit(next: string) {
    setDays(next);
    if (!/^\d+$/u.test(next.trim())) return;
    try {
      safeStorage()?.setItem(RETENTION_DAYS_KEY, String(Number(next.trim())));
    } catch {
      // armazenamento bloqueado: vale só nesta visita (a prévia continua).
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 flex-1 basis-64">
          <label htmlFor={`${id}-ttl`} className="block text-sm font-medium text-foreground">
            Apagar runs e treinos antigos
          </label>
          <p id={`${id}-nota`} className="mt-0.5 text-[13px] leading-snug text-muted-foreground">
            Ao abrir o app, runs e treinos (LLM e JEV) deste navegador com mais dias que isto são apagados — a mesma
            regra do terminal. Um arquivo importado conta da importação. <strong className="font-medium">0</strong>{' '}
            desliga. A biblioteca de prompts não expira.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            id={`${id}-ttl`}
            inputMode="numeric"
            className="w-20 text-right tabular"
            value={days}
            aria-describedby={`${id}-nota ${id}-previa`}
            aria-invalid={parsed === null}
            onChange={(e) => commit(e.target.value)}
          />
          <span className="text-sm text-muted-foreground">dias</span>
        </div>
      </div>
      <p id={`${id}-previa`} className="text-[13px] text-muted-foreground" aria-live="polite">
        {parsed === null
          ? 'Digite um número inteiro de dias (0 desliga).'
          : parsed === 0
            ? 'Retenção desligada: nada é apagado sozinho.'
            : preview === null
              ? 'Calculando…'
              : preview === 0
                ? `Com ${parsed} dias, nada venceu hoje.`
                : `Com ${parsed} dias, ${preview} registro(s) sairiam na próxima abertura do app.`}
        {prune && prune.deleted.length > 0 && (
          <> Nesta abertura, {prune.deleted.length} registro(s) com mais de {prune.retentionDays} dias foram apagados.</>
        )}
      </p>
    </div>
  );
}

/**
 * left#6: "Apagar todos os dados locais" — derruba o banco INTEIRO
 * (`wipeLocalData` → `indexedDB.deleteDatabase`; o `delete` de registro deixa
 * tombstones recuperáveis, crbug 40418460), mostra o uso do site antes/depois
 * (`navigator.storage.estimate`) e o passo a passo de "limpar dados do site"
 * para o que fica fora do IndexedDB (chave, preferências, caches).
 */
function WipeLocalData() {
  const [phase, setPhase] = useState<'idle' | 'wiping' | 'done'>('idle');
  const [result, setResult] = useState<SiteWipeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emExecucao, setEmExecucao] = useState(0);

  useEffect(() => {
    let vivo = true;
    void runningLocks().then((n) => vivo && setEmExecucao(n));
    return () => {
      vivo = false;
    };
  }, [phase]);

  async function wipe() {
    setPhase('wiping');
    setError(null);
    try {
      setResult(await wipeLocalData());
      setPhase('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('idle');
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0 flex-1 basis-64">
          <div className="text-sm font-medium text-foreground">Apagar todos os dados locais</div>
          <p className="mt-0.5 text-[13px] leading-snug text-muted-foreground">
            Apaga de uma vez o banco local do app neste navegador: runs, treinos, runs JEV e a biblioteca de prompts.
            Não dá para desfazer — exporte antes o que quiser guardar (Histórico → Exportar).
          </p>
        </div>
        {phase !== 'done' && (
          <HoldToConfirmButton
            holdSeconds={1.5}
            onConfirm={() => void wipe()}
            className="!h-8 !w-auto rounded-lg px-3 !text-[0.8rem]"
          >
            <Trash2 className="size-4" aria-hidden="true" />
            {phase === 'wiping' ? 'Apagando…' : 'Segure para apagar tudo'}
          </HoldToConfirmButton>
        )}
      </div>
      {emExecucao > 0 && phase !== 'done' && (
        <Banner tone="warn">
          Há {emExecucao} execução(ões) em andamento neste navegador (nesta ou em outra aba). Cancele-as antes: uma run
          que continua rodando volta a gravar depois do apagamento.
        </Banner>
      )}
      {error && <Banner tone="error">Não foi possível apagar: {error}</Banner>}
      {result && (
        <div className="flex flex-col gap-3" aria-live="polite">
          {result.blocked ? (
            <Banner tone="warn" alert>
              Outra aba do app está com o banco aberto: feche as outras abas deste site — o navegador conclui o
              apagamento quando elas fecharem.
            </Banner>
          ) : result.deleted ? (
            <Banner tone="neutral">
              Banco local apagado. Uso do site neste navegador: {formatBytes(result.estimateBefore.usage)} antes →{' '}
              {formatBytes(result.estimateAfter.usage)} agora.
            </Banner>
          ) : (
            <Banner tone="error">O navegador recusou o apagamento do banco local. Use “limpar dados do site” abaixo.</Banner>
          )}
          <ul className="flex flex-col gap-1 text-[13px] leading-snug text-muted-foreground">
            {siteWipeInstructions().map((linha) => (
              <li key={linha}>{linha}</li>
            ))}
          </ul>
          <div>
            <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
              <RotateCw aria-hidden="true" />
              Recarregar o app
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function SettingsPage() {
  const { theme, setTheme } = useTheme();

  return (
    <Screen>
      <PageHeader
        title="Configurações"
        subtitle="A chave usada para falar com a OpenRouter, a aparência do app, a privacidade, o armazenamento local e o apagamento dos dados deste navegador."
      />

      <KeySetup />

      <SectionHead>Aparência</SectionHead>
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
        <div className="min-w-0">
          <div className="text-sm font-medium">Tema</div>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Em “Sistema”, acompanha a preferência do seu sistema operacional em tempo real.
          </p>
        </div>
        <SegmentedToggle value={theme} onChange={(v) => setTheme(v as Theme)} ariaLabel="Tema do app">
          {THEMES.map((t) => (
            <SegmentedToggleOption key={t.value} value={t.value} className="px-3 py-1.5 text-[13px]">
              {t.label}
            </SegmentedToggleOption>
          ))}
        </SegmentedToggle>
      </div>

      <SectionHead>Privacidade</SectionHead>
      <AttributionSetting />

      <SectionHead>Armazenamento local</SectionHead>
      <StorageSettings />

      <SectionHead>Retenção e apagamento</SectionHead>
      <div className="flex flex-col gap-3">
        <RetentionSettings />
        <WipeLocalData />
      </div>
    </Screen>
  );
}
