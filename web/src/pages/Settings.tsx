import { KeySetup } from '../components/KeySetup';
import { StorageSettings } from '../components/StorageNotice';
import { SegmentedToggle, SegmentedToggleOption } from '@/components/motion-ui/segmented-toggle';
import { PageHeader, Screen, SectionHead } from '../components/primitives';
import { useTheme, type Theme } from '../theme';

const THEMES: { value: Theme; label: string }[] = [
  { value: 'light', label: 'Claro' },
  { value: 'dark', label: 'Escuro' },
  { value: 'system', label: 'Sistema' },
];

export function SettingsPage() {
  const { theme, setTheme } = useTheme();

  return (
    <Screen>
      <PageHeader
        title="Configurações"
        subtitle="A chave usada para falar com a OpenRouter, a aparência do app e o armazenamento local."
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

      <SectionHead>Armazenamento local</SectionHead>
      <StorageSettings />
    </Screen>
  );
}
