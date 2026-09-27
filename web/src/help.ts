import { createContext, useContext } from 'react';
import type { RunMode } from './api';

// Há 6 tutoriais: os 3 modos de benchmark + as 3 telas de apoio. Nenhum deles
// abre sozinho (IMPL-111): o tour é sempre ≤3 passos e só roda quando o usuário
// pede — pelo botão "?" (que abre o tópico da ROTA atual) ou pela paleta ⌘K.
export type HelpTutorial = RunMode | 'runs' | 'prompts' | 'settings';

export interface HelpApi {
  open: (t: HelpTutorial) => void;
}

export const HelpContext = createContext<HelpApi>({ open: () => {} });

export function useHelp(): HelpApi {
  return useContext(HelpContext);
}

/**
 * Tópico de ajuda da rota atual (IMPL-111): o "?" abre o tutorial da TELA em
 * que o usuário está — nunca o do comparar fixo. Detalhe de run e o cockpit de
 * treino têm rota própria; `/new` cobre os 3 modos, então abre o do modo
 * default do formulário (compare) — as abas do diálogo trocam para os demais.
 */
export function helpTopicForRoute(pathname: string): HelpTutorial {
  if (pathname.startsWith('/training')) return 'training';
  if (pathname.startsWith('/runs')) return 'runs';
  if (pathname.startsWith('/prompts')) return 'prompts';
  if (pathname.startsWith('/settings')) return 'settings';
  return 'compare';
}

const FIRST_OPEN_KEY = 'bench-first-open';
const SEEN_PREFIX = 'bench-tutorial-seen:';

/** Registra (uma única vez) quando o usuário abriu o app pela primeira vez. */
export function markFirstOpen(): void {
  try {
    if (!localStorage.getItem(FIRST_OPEN_KEY)) {
      localStorage.setItem(FIRST_OPEN_KEY, new Date().toISOString());
    }
  } catch {
    /* localStorage indisponível */
  }
}

export function getFirstOpen(): string | null {
  try {
    return localStorage.getItem(FIRST_OPEN_KEY);
  } catch {
    return null;
  }
}

export function tutorialSeen(t: HelpTutorial): boolean {
  try {
    return localStorage.getItem(SEEN_PREFIX + t) === '1';
  } catch {
    return true; // sem storage: não força o tutorial
  }
}

export function markTutorialSeen(t: HelpTutorial): void {
  try {
    localStorage.setItem(SEEN_PREFIX + t, '1');
  } catch {
    /* ignore */
  }
}
