// Biblioteca de prompts salvos/evoluídos do usuário (client-only, store 'prompts'
// do IndexedDB). Cada prompt tem versionamento próprio: mudar o TEXTO cria uma
// nova versão e registra no history; renomear não versiona. Leitura degrada
// para vazio quando o IndexedDB está indisponível; ESCRITA rejeita com
// `IdbWriteError` (IMPL-022) — a tela avisa em vez de fingir que salvou.

import { idbGet, idbGetAll, idbPut, idbDelete } from '../idb';
import type { SavedPrompt } from './types';

const STORE = 'prompts';

// Cap de versões no history — ao estourar, descarta as mais antigas.
const HISTORY_LIMIT = 50;

export async function savePrompt(input: {
  name: string;
  text: string;
  origin?: SavedPrompt['origin'];
  note?: string;
}): Promise<SavedPrompt> {
  const now = new Date().toISOString();
  const prompt: SavedPrompt = {
    id: crypto.randomUUID(),
    name: input.name,
    text: input.text,
    version: 1,
    history: [{ version: 1, text: input.text, savedAt: now, note: input.note }],
    origin: input.origin,
    createdAt: now,
    updatedAt: now,
  };
  await idbPut(STORE, prompt);
  return prompt;
}

export async function updatePrompt(
  id: string,
  input: { text?: string; name?: string; note?: string },
): Promise<SavedPrompt | undefined> {
  const prompt = await idbGet<SavedPrompt>(STORE, id);
  if (!prompt) return undefined;

  const now = new Date().toISOString();
  if (input.name !== undefined) prompt.name = input.name;
  // Só o texto versiona: renomear não gera versão nova nem entrada no history.
  if (input.text !== undefined && input.text !== prompt.text) {
    prompt.text = input.text;
    prompt.version += 1;
    prompt.history.push({ version: prompt.version, text: prompt.text, savedAt: now, note: input.note });
    if (prompt.history.length > HISTORY_LIMIT) {
      prompt.history = prompt.history.slice(prompt.history.length - HISTORY_LIMIT);
    }
  }
  prompt.updatedAt = now;

  await idbPut(STORE, prompt);
  return prompt;
}

export async function getPrompt(id: string): Promise<SavedPrompt | undefined> {
  return idbGet<SavedPrompt>(STORE, id);
}

export async function listPrompts(): Promise<SavedPrompt[]> {
  const prompts = await idbGetAll<SavedPrompt>(STORE);
  // Mais recentemente mexidos primeiro.
  return prompts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deletePrompt(id: string): Promise<void> {
  await idbDelete(STORE, id);
}
