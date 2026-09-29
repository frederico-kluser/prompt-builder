import type { ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { SettingRow } from './primitives';

/**
 * Campos compactos do formulário de run — extraídos de `pages/NewRun.tsx` para
 * o fluxo GUIADO (`components/GuidedSetup.tsx`) compor as MESMAS perguntas sem
 * duplicar markup. Rótulo + explicação à esquerda, controle à direita (o `wide`
 * desce o controle para baixo), tudo vindo de `primitives.tsx`.
 */

/** Linha numérica (valor NUMBER). Sem clamp na digitação — o clamp é no envio. */
export function NumRow(p: {
  label: string;
  sub?: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
}) {
  return (
    <SettingRow label={p.label} sub={p.sub}>
      <Input
        type="number"
        className="w-24"
        aria-label={p.label}
        min={p.min}
        max={p.max}
        step={p.step ?? 1}
        value={p.value}
        onChange={(e) => {
          const v = e.target.valueAsNumber;
          if (!Number.isNaN(v)) p.onChange(v);
        }}
      />
    </SettingRow>
  );
}

/** Linha numérica com valor TEXTO (vazio = default/sem limite). */
export function TxtNumRow(p: {
  label: string;
  sub?: string;
  value: string;
  onChange: (v: string) => void;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
}) {
  return (
    <SettingRow label={p.label} sub={p.sub}>
      <Input
        type="number"
        className="w-24"
        aria-label={p.label}
        min={p.min}
        max={p.max}
        step={p.step}
        placeholder={p.placeholder}
        value={p.value}
        onChange={(e) => p.onChange(e.target.value)}
      />
    </SettingRow>
  );
}

/** Linha de texto CURTO (uma linha; ex.: lista de idiomas). */
export function TextRow(p: {
  label: string;
  sub?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <SettingRow label={p.label} sub={p.sub}>
      <Input
        type="text"
        className="w-40"
        aria-label={p.label}
        spellCheck={false}
        autoComplete="off"
        placeholder={p.placeholder}
        value={p.value}
        onChange={(e) => p.onChange(e.target.value)}
      />
    </SettingRow>
  );
}

/** Linha booleana. O rótulo visível é o da linha, daí o aria-label no switch. */
export function SwitchRow(p: { label: string; sub: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <SettingRow label={p.label} sub={p.sub}>
      <Switch aria-label={p.label} checked={p.checked} onCheckedChange={(v) => p.onChange(!!v)} />
    </SettingRow>
  );
}

/** Linha de texto longo: a caixa ocupa a largura toda, sob o rótulo. */
export function AreaRow(p: {
  label: string;
  sub?: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
  children?: ReactNode;
}) {
  return (
    <SettingRow label={p.label} sub={p.sub} wide>
      <Textarea
        rows={p.rows ?? 3}
        aria-label={p.label}
        value={p.value}
        placeholder={p.placeholder}
        onChange={(e) => p.onChange(e.target.value)}
      />
      {p.children}
    </SettingRow>
  );
}

/** Botão de texto discreto ("gerar com IA", "escrever manualmente"). */
export function LinkButton(p: { onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={p.disabled}
      onClick={p.onClick}
      className="self-start text-[13px] text-primary underline-offset-4 hover:underline disabled:opacity-50"
    >
      {p.children}
    </button>
  );
}