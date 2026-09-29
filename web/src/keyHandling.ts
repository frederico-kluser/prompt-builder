// "Como sua key é tratada" (IMPL-082, R-10:REC-4) — SÓ frases verificáveis.
//
// Antes o KeySetup, o KeyGate e a Ajuda diziam "salva só no localStorage deste
// navegador" enquanto a key vivia só em memória (o setStoredKey era chamado sem
// `remember`): toda recarga perdia a key e o texto era falso. A página agora é
// montada DAQUI, a partir do estado REAL (`keyPersistence()`), e cada frase tem
// um verificador em test/key-handling.test.ts amarrado a um fato do código
// (checklist com cobertura de 100%: frase nova sem verificador reprova).
//
// O que ela NÃO pode afirmar: proteção contra código malicioso rodando nesta
// página (XSS, extensões) — não existe; por isso a recomendação de não lembrar
// a key em máquina partilhada e o caminho de revogação.

import type { KeyPersistence } from './api';

/** Página de keys do OpenRouter (revogar/criar). */
export const OPENROUTER_KEYS_URL = 'https://openrouter.ai/keys';

export type KeyFactId = 'onde' | 'destino' | 'servidor' | 'riscos' | 'sumir' | 'revogar';

export interface KeyFact {
  id: KeyFactId;
  title: string;
  text: string;
}

/** As afirmações da tela, conforme a key está guardada AGORA. */
export function keyHandlingFacts(persistence: KeyPersistence): KeyFact[] {
  return [
    {
      id: 'onde',
      title: 'Onde ela fica',
      text:
        persistence === 'remembered'
          ? 'no localStorage deste navegador, até você a remover — «Apagar todos os dados locais» (Configurações) ou limpar os dados do site apaga também a key.'
          : 'só na memória desta aba — recarregar ou fechar a aba apaga a key. Marque «Lembrar neste dispositivo» para não precisar colá-la de novo.',
    },
    {
      id: 'destino',
      title: 'Para onde vai',
      text: 'sai deste navegador só para openrouter.ai: na validação, no catálogo de modelos e nas chamadas das runs.',
    },
    {
      id: 'servidor',
      title: 'Sem servidor nosso',
      text: 'nenhum servidor do Prompt Builder recebe a key — o benchmark roda nesta aba e fala direto com o OpenRouter.',
    },
    {
      id: 'riscos',
      title: 'Riscos',
      text: 'qualquer script da página (XSS), extensão do navegador com acesso à página ou outra pessoa neste computador consegue ler a key. Em máquina partilhada, não a lembre.',
    },
    {
      id: 'sumir',
      title: 'Se ela sumir',
      text: 'o navegador pode apagar os dados do site (o Safari, por exemplo, após 7 dias sem uso); aí o app pede a key de novo antes de qualquer chamada paga.',
    },
    {
      id: 'revogar',
      title: 'Como revogar',
      text: 'a key é exibida uma única vez; se algo parecer errado, revogue-a e crie outra na página de keys do OpenRouter.',
    },
  ];
}
