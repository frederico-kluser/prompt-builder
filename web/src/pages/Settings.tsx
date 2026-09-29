import { useId, useState } from 'react';
import { KeySetup } from '../components/KeySetup';
import { StorageSettings } from '../components/StorageNotice';
import { SegmentedToggle, SegmentedToggleOption } from '@/components/motion-ui/segmented-toggle';
import { Switch } from '@/components/ui/switch';
import { PageHeader, Screen, SectionHead } from '../components/primitives';
import { isAttributionDisabled, setAttributionEnabled } from '../engine/openrouter';
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

export function SettingsPage() {
  const { theme, setTheme } = useTheme();

  return (
    <Screen>
      <PageHeader
        title="Configurações"
        subtitle="A chave usada para falar com a OpenRouter, a aparência do app, a privacidade e o armazenamento local."
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
    </Screen>
  );
}
